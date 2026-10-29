import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol.ts";
import { loadConfig } from "../src/config.ts";
import { type UpgradeRequest, clientIp, createApp, originAllowed } from "../src/http.ts";
import { Registry } from "../src/metrics.ts";
import { RoomManager } from "../src/rooms.ts";

const quietLogger = { error() {}, info() {}, warn() {} };

async function withApp(t: TestContext, env: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "dogfight-lab08-"));
  const dist = join(directory, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Dogfight test</title>");
  const config = loadConfig({ HOST: "127.0.0.1", PORT: "0", LOG_DIR: join(directory, "logs"), ...env });
  const app = await createApp({ ...config, clientDist: dist }, { logger: quietLogger });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const sockets: WebSocket[] = [];
  t.onTestFinished(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}/ws`, sockets };
}

// Resolves with the HTTP status of a refused upgrade, or 101 once it is open.
function upgrade(url: string, sockets: WebSocket[], headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    sockets.push(socket);
    socket.once("open", () => resolve(101));
    socket.once("unexpected-response", (_request, response: IncomingMessage) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("error", reject);
  });
}

const fakeRequest = (headers: IncomingMessage["headers"], remoteAddress = "10.0.0.1"): UpgradeRequest => ({
  headers,
  socket: { remoteAddress },
});

test("config validates the production settings and stamps a version", () => {
  const config = loadConfig({ ALLOWED_ORIGINS: "https://a.example, https://b.example:8443", TRUST_PROXY: "true" });
  assert.deepEqual(config.allowedOrigins, ["https://a.example", "https://b.example:8443"]);
  assert.equal(config.trustProxy, true);
  assert.equal(config.maxConnectionsPerIp, 8);
  assert.ok(config.shutdownTimeoutMs < 10_000, "inside the 10 s kill timeout");
  assert.match(config.version, /^\d+\.\d+\.\d+/);
  assert.equal(loadConfig({ APP_VERSION: "1.2.3", GIT_SHA: "abc123" }).commit, "abc123");
  assert.throws(() => loadConfig({ ALLOWED_ORIGINS: "https://a.example/path" }), /ALLOWED_ORIGINS/);
  assert.throws(() => loadConfig({ LOG_LEVEL: "loud" }), /LOG_LEVEL/);
  assert.throws(() => loadConfig({ TRUST_PROXY: "yes" }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({ MAX_CONNECTIONS_PER_IP: "0" }), /MAX_CONNECTIONS_PER_IP/);
});

test("origin check: same host and listed origins pass, other sites do not", () => {
  const host = { host: "dogfight.example" };
  assert.equal(originAllowed(fakeRequest({ ...host, origin: "https://dogfight.example" }), []), true);
  assert.equal(originAllowed(fakeRequest({ ...host, origin: "https://evil.example" }), []), false);
  assert.equal(originAllowed(fakeRequest({ ...host, origin: "null" }), []), false);
  assert.equal(originAllowed(fakeRequest({ ...host, origin: "https://itch.zone" }), ["https://itch.zone"]), true);
  assert.equal(originAllowed(fakeRequest(host), []), true, "non-browser clients send no Origin");
});

test("client IP comes from the last X-Forwarded-For hop only behind a trusted proxy", () => {
  const request = fakeRequest({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
  assert.equal(clientIp(request, true), "203.0.113.7");
  assert.equal(clientIp(request, false), "10.0.0.1");
  assert.equal(clientIp(fakeRequest({}), true), "10.0.0.1");
});

test("/health, /ready and /metrics; draining flips readiness and refuses new sockets", async (t) => {
  const { app, base, ws, sockets } = await withApp(t);
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.match(await health.text(), /"version":"\d/);
  assert.equal((await fetch(`${base}/ready`)).status, 200);

  assert.equal(await upgrade(ws, sockets), 101);
  const metrics = await fetch(`${base}/metrics`);
  assert.match(metrics.headers.get("content-type") ?? "", /^text\/plain; version=0\.0\.4/);
  const text = await metrics.text();
  assert.match(text, /^# TYPE dogfight_ws_clients gauge$/m);
  assert.match(text, /^dogfight_ws_clients 1$/m);
  assert.match(text, /^dogfight_build_info\{version="[^"]+",commit="dev",node="v\d/m);
  assert.match(text, /^dogfight_http_requests_total\{code="2xx"\} \d+$/m);

  app.drain();
  assert.equal((await fetch(`${base}/ready`)).status, 503);
  assert.equal((await fetch(`${base}/health`)).status, 200, "still alive while draining");
  assert.equal(await upgrade(ws, sockets), 503);
  assert.match(await (await fetch(`${base}/metrics`)).text(), /^dogfight_ws_rejected_total\{reason="draining"\} 1$/m);
});

test("/metrics can require a bearer token", async (t) => {
  const { base } = await withApp(t, { METRICS_TOKEN: "s3cret" });
  assert.equal((await fetch(`${base}/metrics`)).status, 401);
  assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: "Bearer s3cret" } })).status, 200);
});

test("WebSocket upgrades: foreign Origin is refused, per-IP and total caps hold and free up", async (t) => {
  const { base, ws, sockets } = await withApp(t, { MAX_CONNECTIONS_PER_IP: "2", MAX_CONNECTIONS: "50" });
  const { host } = new URL(base);
  assert.equal(await upgrade(ws, sockets, { origin: "https://evil.example" }), 403);
  assert.equal(await upgrade(ws, sockets, { origin: `http://${host}` }), 101);
  assert.equal(await upgrade(ws, sockets), 101);
  assert.equal(await upgrade(ws, sockets), 429, "third socket from one IP");

  const first = sockets[1];
  assert.ok(first);
  first.close();
  await once(first, "close");
  // The server's own close handler runs on the same tick as the client's.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await upgrade(ws, sockets), 101, "a slot frees up when a socket closes");

  const metrics = await (await fetch(`${base}/metrics`)).text();
  assert.match(metrics, /dogfight_ws_rejected_total\{reason="origin"\} 1/);
  assert.match(metrics, /dogfight_ws_rejected_total\{reason="ip-limit"\} 1/);
});

test("graceful close: players get 1001 'going away' and the server stops well under 10 s", async (t) => {
  const { app, ws, sockets } = await withApp(t);
  assert.equal(await upgrade(ws, sockets), 101);
  const socket = sockets[0];
  assert.ok(socket);
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: "Ada" }));
  await once(socket, "message");
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  const started = performance.now();
  await app.close();
  assert.equal(await closed, 1001);
  assert.ok(performance.now() - started < 2000, `closed in ${Math.round(performance.now() - started)} ms`);
});

test("built-in rooms survive being emptied; player rooms expire when idle", async () => {
  const manager = new RoomManager({ maxRooms: 4, idleMs: 30 });
  const orbit = manager.get("orbit");
  assert.ok(orbit);
  orbit.join({ id: "a", name: "Ada" });
  orbit.leave("a");
  assert.equal(manager.get("orbit"), orbit);

  const unused = manager.create({ name: "Nobody comes" });
  const used = manager.create({ name: "Busy" });
  used.join({ id: "b", name: "Bob" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(manager.get(unused.id), undefined, "never joined: removed after idleMs");
  assert.equal(manager.get(used.id), used, "occupied: kept");

  used.leave("b");
  assert.equal(manager.get(used.id), used, "a reload within idleMs finds the room again");
  used.join({ id: "b", name: "Bob" });
  used.leave("b");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(manager.get(used.id), undefined);
  manager.create({ name: "Room limit is free again" });
  manager.dispose();
});

test("the metrics registry renders Prometheus text with escaped labels", () => {
  const registry = new Registry();
  const counter = registry.counter("x_total", "Things");
  counter.inc({ reason: 'a"b' });
  counter.inc({ reason: 'a"b' }, 2);
  registry.gauge("y", "Gauge", () => 5);
  assert.equal(registry.render(), '# HELP x_total Things\n# TYPE x_total counter\nx_total{reason="a\\"b"} 3\n# HELP y Gauge\n# TYPE y gauge\ny 5\n');
});
