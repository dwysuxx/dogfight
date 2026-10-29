import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test, vi } from "vitest";
import { type RawData, WebSocket } from "ws";
import { PROTOCOL_VERSION, type ServerMessage, parseServerMessage } from "@dogfight/shared/protocol.ts";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { Match } from "../src/match.ts";

// Chaos: break one room on purpose and check that a match in another room
// keeps ticking without a hitch. "Isolated" is measured as the longest gap
// between two snapshots the bystander receives while the other room burns.
const quietLogger = { error() {}, info() {}, warn() {} };
const v = PROTOCOL_VERSION;

async function withApp(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "dogfight-chaos-"));
  const dist = join(directory, "dist");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html>");
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_DIR: join(directory, "logs"),
    MAX_CONNECTIONS_PER_IP: "50",
  });
  const app = await createApp({ ...config, clientDist: dist }, { logger: quietLogger });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const sockets: WebSocket[] = [];
  t.onTestFinished(async () => {
    vi.restoreAllMocks();
    for (const socket of sockets) socket.terminate();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { app, base: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}/ws`, sockets };
}

interface Player {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  readonly stateTimes: number[];
  readonly closed: Promise<number>;
}

async function joinRoom(url: string, sockets: WebSocket[], room: string, name: string): Promise<Player> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  const messages: ServerMessage[] = [];
  const stateTimes: number[] = [];
  const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));
  socket.on("message", (data: RawData, isBinary) => {
    if (isBinary) return;
    const text = (Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)).toString();
    const parsed = parseServerMessage(JSON.parse(text));
    if (!parsed.ok) return;
    messages.push(parsed.value);
    if (parsed.value.type === "state") stateTimes.push(performance.now());
  });
  await once(socket, "open");
  socket.send(JSON.stringify({ v, type: "join", room, name }));
  await waitFor(() => messages.some((message) => message.type === "joined"), `${name} joined ${room}`);
  return { socket, messages, stateTimes, closed };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// Longest gap between snapshots received after `since`, in milliseconds.
function longestGap(times: readonly number[], since: number): number {
  const window = times.filter((time) => time >= since);
  assert.ok(window.length > 5, "the bystander kept receiving snapshots");
  let gap = 0;
  for (let i = 1; i < window.length; i++) gap = Math.max(gap, (window[i] ?? 0) - (window[i - 1] ?? 0));
  return gap;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// 30 Hz is 33 ms; a stall that a player would feel is several ticks long.
const MAX_GAP_MS = 250;

test("chaos: a client killed without a close frame is removed; the other room does not notice", async (t) => {
  const { ws, sockets } = await withApp(t);
  const bystander = await joinRoom(ws, sockets, "deep-field", "Bystander");
  const victim = await joinRoom(ws, sockets, "orbit", "Victim");
  const witness = await joinRoom(ws, sockets, "orbit", "Witness");
  const since = performance.now();

  victim.socket.terminate(); // TCP reset: no close handshake, like a killed tab or lost Wi-Fi
  await waitFor(
    () => witness.messages.some((message) => message.type === "roster" && message.players.length === 1),
    "the witness sees the victim leave",
  );
  await settle(400);
  assert.ok(longestGap(bystander.stateTimes, since) < MAX_GAP_MS);
  assert.equal(bystander.socket.readyState, WebSocket.OPEN);
});

test("chaos: a garbage-frame flood gets its sender kicked; other rooms keep their tick rate", async (t) => {
  const { base, ws, sockets } = await withApp(t);
  const bystander = await joinRoom(ws, sockets, "deep-field", "Bystander");
  const attacker = await joinRoom(ws, sockets, "orbit", "Attacker");
  const since = performance.now();

  for (let i = 0; i < 2000 && attacker.socket.readyState === WebSocket.OPEN; i++) {
    attacker.socket.send(randomBytes(1 + (i % 200)), { binary: i % 2 === 0 });
  }
  const code = await attacker.closed;
  assert.ok([1002, 1008].includes(code), `attacker closed with ${code}`);

  await settle(400);
  assert.ok(longestGap(bystander.stateTimes, since) < MAX_GAP_MS);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.match(await (await fetch(`${base}/metrics`)).text(), /dogfight_ws_kicked_total\{reason="[a-z-]+"\} [1-9]/);
});

test("chaos: a match that throws closes only its own room; the process and other rooms live on", async (t) => {
  const { base, ws, sockets } = await withApp(t);
  const bystander = await joinRoom(ws, sockets, "deep-field", "Bystander");
  const doomed = await joinRoom(ws, sockets, "orbit", "Doomed");
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the original, called with .call(this) below
  const step = Match.prototype.step;
  vi.spyOn(Match.prototype, "step").mockImplementation(function (this: Match) {
    if (this.room.id === "orbit") throw new Error("injected simulation bug");
    step.call(this);
  });
  const since = performance.now();

  assert.equal(await doomed.closed, 1011);
  assert.ok(doomed.messages.some((message) => message.type === "error" && message.code === "internal-error"));
  await settle(400);
  assert.ok(longestGap(bystander.stateTimes, since) < MAX_GAP_MS);
  assert.match(await (await fetch(`${base}/metrics`)).text(), /^dogfight_room_failures_total 1$/m);

  vi.restoreAllMocks();
  const again = await joinRoom(ws, sockets, "orbit", "Again");
  await waitFor(() => again.stateTimes.length > 3, "the crashed room can be played again");
});
