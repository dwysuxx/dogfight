import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
import * as binaryCodec from "@dogfight/shared/codec/binary.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/http.js";
import { MatchLogStore } from "../src/log/matchlog.js";
import { readReplay } from "../src/log/replay.js";
import { PROTOCOL_VERSION, validateClientMessage } from "../src/protocol.js";
import { Room, RoomManager } from "../src/rooms.js";

const quietLogger = { error() {}, info() {}, warn() {} };

async function createTempDirectory() {
  return mkdtemp(join(tmpdir(), "dogfight-lab04-"));
}

async function startApp(directory, options = {}) {
  const dist = join(directory, "dist");
  const logs = join(directory, "logs");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Dogfight test</title>");
  const app = await createApp({
    ...loadConfig({
      HOST: "127.0.0.1",
      PORT: "0",
      LOG_DIR: logs,
      MAX_ROOMS: String(options.maxRooms ?? 8),
      MAX_PLAYERS_PER_ROOM: String(options.maxPlayers ?? 4),
      MAX_PAYLOAD: String(options.maxPayload ?? 1024),
      MAX_MESSAGES_PER_SECOND: String(options.maxMessages ?? 20),
      SLOW_CLIENT_BYTES: String(options.slowClientBytes ?? 512 * 1024),
      JOIN_TIMEOUT_MS: String(options.joinTimeoutMs ?? 5000),
      HEARTBEAT_MS: String(options.heartbeatMs ?? 15_000),
    }),
    clientDist: dist,
  }, { logger: quietLogger });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const { port } = app.server.address();
  return { app, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws`, logs };
}

async function closeApp(app, sockets = []) {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  await app.close();
}

test("config validates environment values and resolves paths", () => {
  const config = loadConfig({ PORT: "0", MAX_ROOMS: "4", LOG_DIR: "var/logs" });
  assert.equal(config.port, 0);
  assert.equal(config.maxRooms, 4);
  assert.ok(config.logDir.endsWith(join("server", "var", "logs")));
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ MAX_ROOMS: "1" }), /MAX_ROOMS must be an integer/);
});

test("protocol accepts versioned join/chat/input/ping and rejects malformed or unknown messages", () => {
  const v = PROTOCOL_VERSION;
  assert.equal(validateClientMessage({ v, type: "join", room: "orbit", name: "Ada" }).message.codec, "json");
  assert.equal(validateClientMessage({ v, type: "join", room: "orbit", name: "Ada", codec: "binary" }).ok, true);
  assert.equal(validateClientMessage({ v, type: "join", room: "orbit", name: "Ada", codec: "xml" }).ok, false);
  assert.deepEqual(validateClientMessage({ v, type: "chat", text: " hi " }).message.text, "hi");
  assert.equal(validateClientMessage({ v: 99, type: "join", room: "orbit", name: "Ada" }).code, "unsupported-version");
  assert.equal(validateClientMessage({ v, type: "join", room: "../secrets", name: "Ada" }).ok, false);
  assert.equal(validateClientMessage({ v, type: "chat", text: "x".repeat(501) }).ok, false);
  assert.equal(validateClientMessage({ v, type: "chat", text: "hello", extra: true }).ok, false);
  const input = (inputs) => validateClientMessage({ v, type: "input", inputs });
  const thrust = { left: false, right: false, thrust: true, fire: false };
  assert.equal(input([{ seq: 7, controls: thrust }, { seq: 8, controls: thrust }]).ok, true);
  assert.equal(input([{ seq: 7, controls: thrust }, { seq: 9, controls: thrust }]).code, "invalid-input", "gap");
  assert.equal(input([{ seq: 1, controls: { thrust: true } }]).code, "invalid-input");
  assert.equal(input([{ seq: 1, controls: { ...thrust, turn: 1000 } }]).code, "invalid-input", "cheat field");
  assert.equal(input([{ seq: 1.5, controls: thrust }]).code, "invalid-input");
  assert.equal(input([]).code, "invalid-input");
  assert.equal(input(Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, controls: thrust }))).ok, false);
  assert.equal(validateClientMessage({ v, type: "ping", t: 12.5 }).ok, true);
  assert.equal(validateClientMessage({ v, type: "ping", t: "now" }).ok, false);
  assert.equal(validateClientMessage({ v, type: "netsim", lag: 100, jitter: 20, drop: 0.02 }).ok, true);
  assert.equal(validateClientMessage({ v, type: "netsim", lag: 100, jitter: 20, drop: 0.9 }).ok, false);
  assert.equal(validateClientMessage({ v, type: "wat" }).code, "unknown-type");
});

test("Room EventEmitter emits ordered events and RoomManager caps and removes rooms", () => {
  const manager = new RoomManager({ maxRooms: 3, maxPlayersPerRoom: 1 });
  const room = manager.create({ name: "Test room" });
  const events = [];
  for (const event of ["join", "chat", "leave", "empty"])
    room.on(event, () => events.push(event));
  room.join({ id: "a", name: "Ada" });
  assert.throws(() => room.join({ id: "b", name: "Bob" }), /full/);
  room.chat({ id: "a", name: "Ada" }, "hello");
  room.leave("a");
  assert.deepEqual(events, ["join", "chat", "leave", "empty"]);
  assert.equal(manager.get(room.id), undefined);
  manager.create({ name: "Third" });
  assert.throws(() => manager.create({ name: "Fourth" }), /limit/);
  assert.throws(() => manager.create({ name: "" }), /Room name/);
});

test("MatchLogTransform writes NDJSON and replay parses incrementally", async () => {
  const directory = await createTempDirectory();
  try {
    const store = new MatchLogStore(directory);
    await store.init();
    const room = new Room({ id: "test-room", name: "Test Room" });
    const file = store.start(room);
    room.record("join", { player: "a" });
    room.record("chat", { text: "hello" });
    room.record("empty", {});
    await store.close();
    assert.deepEqual(await store.list(), [file]);
    const events = [];
    for await (const event of readReplay(store.resolveId(file))) events.push(event);
    assert.deepEqual(events.map((event) => event.type), ["join", "chat", "empty"]);
    assert.match(await readFile(store.resolveId(file), "utf8"), /"text":"hello"}\n/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP API, safe static files, request caps, and streamed replay work", async (t) => {
  const directory = await createTempDirectory();
  const { app, base, logs } = await startApp(directory, { maxRooms: 3, maxPayload: 512 });
  t.after(async () => {
    await closeApp(app);
    await rm(directory, { recursive: true, force: true });
  });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const slowStarted = performance.now();
  const slow = await fetch(`${base}/api/slow?ms=10`);
  assert.equal(slow.status, 200);
  assert.ok(performance.now() - slowStarted >= 8);
  assert.equal((await fetch(`${base}/api/slow?ms=1001`)).status, 400);

  const staticPage = await fetch(base);
  assert.equal(staticPage.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await staticPage.text(), /Dogfight test/);

  const traversal = await new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const request = httpRequest({ host: "127.0.0.1", port, path: "/%2e%2e/%2e%2e/etc/passwd" }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
  assert.ok([400, 403, 404].includes(traversal));
  const missingApi = await fetch(`${base}/api/nope`);
  assert.equal(missingApi.status, 404);

  const created = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Practice", arena: { width: 800, height: 600, asteroids: 4 } }),
  });
  assert.equal(created.status, 201);
  const room = await created.json();
  const listed = await (await fetch(`${base}/api/rooms`)).json();
  assert.ok(listed.rooms.some((candidate) => candidate.id === room.id));

  const invalid = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Bad", arena: { width: -1, height: 1, asteroids: -3 } }),
  });
  assert.equal(invalid.status, 400);
  const oversized = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(600) }),
  });
  assert.equal(oversized.status, 413);

  const replayId = `manual-${Date.now()}-abcdef12.ndjson`;
  await writeFile(join(logs, replayId), '{"type":"sample"}\n');
  const replayResponse = await fetch(`${base}/api/replays/${replayId}`);
  assert.equal(replayResponse.status, 200);
  assert.equal(await replayResponse.text(), '{"type":"sample"}\n');
  assert.equal((await (await fetch(`${base}/api/replays`)).json()).replays.includes(replayId), true);
  assert.equal((await fetch(`${base}/api/replays/../../secrets`)).status, 404);
});

// Waits for the next message matching `predicate` (JSON text frames are
// parsed; binary frames are decoded with the shared binary codec).
function nextMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for WebSocket message"));
    }, timeoutMs);
    const onMessage = (raw, isBinary) => {
      const message = isBinary ? binaryCodec.decode(raw) : JSON.parse(raw.toString());
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before expected message"));
    };
    function cleanup() {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    }
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

const ofType = (type) => (message) => message.type === type;

async function joinRoom(ws, sockets, { name, room = "orbit", codec, query = "" }) {
  const socket = new WebSocket(`${ws}${query}`);
  sockets.push(socket);
  await once(socket, "open");
  const joined = nextMessage(socket, ofType("joined"));
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room, name, ...(codec ? { codec } : {}) }));
  return { socket, joined: await joined };
}

const controls = (overrides = {}) => ({ left: false, right: false, thrust: false, fire: false, ...overrides });

test("WebSocket clients join, receive roster and chat, and leave cleanly", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws } = await startApp(directory);
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  const first = await joinRoom(ws, sockets, { name: "Ada" });
  assert.equal(first.joined.player.playerId, 1);
  assert.equal(first.joined.tickRate, 30);
  const roster = nextMessage(first.socket, (m) => m.type === "roster" && m.players.length === 2);
  const second = await joinRoom(ws, sockets, { name: "Lin" });
  assert.equal(second.joined.player.playerId, 2);
  assert.deepEqual((await roster).players.map((player) => player.name), ["Ada", "Lin"]);

  const firstChat = nextMessage(first.socket, ofType("chat"));
  const secondChat = nextMessage(second.socket, ofType("chat"));
  second.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "chat", text: "Hello, Ada!" }));
  assert.equal((await firstChat).text, "Hello, Ada!");
  assert.equal((await secondChat).player.name, "Lin");

  const afterLeave = nextMessage(first.socket, (m) => m.type === "roster" && m.players.length === 1);
  second.socket.close();
  assert.deepEqual((await afterLeave).players.map((player) => player.name), ["Ada"]);
});

test("the authoritative match applies seq-numbered inputs and acks them per client", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws } = await startApp(directory);
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  const first = await joinRoom(ws, sockets, { name: "Ada", codec: "json" });
  const second = await joinRoom(ws, sockets, { name: "Lin", codec: "json" });
  const firstId = first.joined.player.playerId;

  // Both clients receive the same world for the same tick; only ack differs.
  const firstStates = new Map();
  const secondStates = new Map();
  first.socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "state") firstStates.set(message.tick, message);
  });
  second.socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "state") secondStates.set(message.tick, message);
  });
  const sameTick = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const tick = [...firstStates.keys()].find((key) => secondStates.has(key));
      if (tick !== undefined) return [firstStates.get(tick), secondStates.get(tick)];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No common tick");
  };
  const [a, b] = await sameTick();
  assert.deepEqual(a.entities, b.entities);
  const ships = a.entities.filter((e) => e.kind === "ship");
  assert.equal(ships.filter((ship) => ship.bot).length, 1);
  assert.deepEqual(ships.filter((ship) => !ship.bot).map((ship) => ship.owner).sort(), [1, 2]);
  assert.ok(a.entities.every((e) => Number.isInteger(e.id) && e.id <= 0xffff), "u16 entity ids");
  const start = ships.find((ship) => ship.owner === firstId);

  // 12 thrust inputs, sent the way the client does: each message repeats the
  // last few (redundancy), the server must apply each seq exactly once.
  const inputs = [];
  for (let seq = 1; seq <= 12; seq++) {
    inputs.push({ seq, controls: controls({ thrust: true }) });
    first.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "input", inputs: inputs.slice(-4) }));
  }
  const thrusted = await nextMessage(first.socket, (m) => m.type === "state" && m.ack === 12);
  const moved = thrusted.entities.find((e) => e.kind === "ship" && e.owner === firstId);
  assert.ok(Math.hypot(moved.x - start.x, moved.y - start.y) > 2, "the ship moved under thrust");
  const otherView = await nextMessage(second.socket, (m) => m.type === "state" && m.tick >= thrusted.tick);
  assert.equal(otherView.ack, 0, "acks are per client");

  first.socket.send(
    JSON.stringify({ v: PROTOCOL_VERSION, type: "input", inputs: [{ seq: 13, controls: controls({ fire: true }) }] }),
  );
  const fired = await nextMessage(
    second.socket,
    (m) => m.type === "state" && m.entities.some((e) => e.kind === "bullet" && e.owner === firstId),
  );
  const bullet = fired.entities.find((e) => e.kind === "bullet" && e.owner === firstId);
  assert.equal(bullet.seq, 13, "the bullet carries the seq of the input that fired it");

  const stats = await (await fetch(`${ws.replace("ws:", "http:").replace("/ws", "")}/api/stats`)).json();
  const orbit = stats.matches.find((match) => match.room === "orbit");
  assert.equal(orbit.ticker.rate, 30);
  assert.equal(orbit.players, 2);
  assert.ok(orbit.inputs.inputsApplied >= 13);
});

test("binary clients get DataView snapshots and can send binary inputs and pings", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws } = await startApp(directory);
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  const { socket, joined } = await joinRoom(ws, sockets, { name: "Bin", room: "deep-field", codec: "binary" });
  const state = await nextMessage(socket, ofType("state"));
  assert.ok(state.entities.some((e) => e.kind === "ship" && e.owner === joined.player.playerId));
  assert.ok(state.entities.some((e) => e.kind === "asteroid" && e.shape.length === 11));

  socket.send(binaryCodec.encode({ type: "input", inputs: [{ seq: 1, controls: controls({ right: true }) }] }));
  const acked = await nextMessage(socket, (m) => m.type === "state" && m.ack === 1);
  assert.equal(acked.type, "state");

  socket.send(binaryCodec.encode({ type: "ping", t: 1234.5 }));
  const pong = await nextMessage(socket, ofType("pong"));
  assert.equal(pong.t, 1234.5);
  assert.ok(pong.tick > 0);

  const closed = once(socket, "close");
  socket.send(Uint8Array.of(1, PROTOCOL_VERSION, 1, 1, 0, 0, 0, 0xff)); // reserved input bits set
  assert.equal((await closed)[0], 1008);
});

test("the latency injector delays both directions of one connection", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws } = await startApp(directory);
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  const { socket, joined } = await joinRoom(ws, sockets, { name: "Laggy", query: "?lag=60" });
  assert.deepEqual(joined.netsim, { lag: 60, jitter: 0, drop: 0 });
  const sentAt = performance.now();
  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "ping", t: sentAt }));
  await nextMessage(socket, ofType("pong"));
  assert.ok(performance.now() - sentAt >= 115, "60 ms each way");

  socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "netsim", lag: 0, jitter: 0, drop: 0 }));
  const conditions = await nextMessage(socket, ofType("netsim"));
  assert.equal(conditions.lag, 0);

  const rejected = new WebSocket(`${ws}?drop=2`);
  sockets.push(rejected);
  rejected.on("error", () => {});
  assert.equal((await once(rejected, "close"))[0], 1008);
});

test("WebSocket rejects unjoined clients and clients that miss the join deadline", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws } = await startApp(directory, { joinTimeoutMs: 40 });
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  const socket = new WebSocket(ws);
  sockets.push(socket);
  await once(socket, "open");
  const errorMessage = once(socket, "message");
  const closed = once(socket, "close");
  const [raw] = await errorMessage;
  const [code] = await closed;
  assert.equal(JSON.parse(raw.toString()).code, "join-timeout");
  assert.equal(code, 1008);
});

test("WebSocket heartbeat pings live clients and maxPayload closes oversized frames", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws } = await startApp(directory, { maxPayload: 1024, heartbeatMs: 20 });
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  const live = new WebSocket(ws);
  sockets.push(live);
  live.on("error", () => {});
  await once(live, "open");
  const joined = once(live, "message");
  live.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: "Heartbeat" }));
  assert.equal(JSON.parse((await joined)[0].toString()).type, "joined");
  await once(live, "ping");
  assert.equal(live.readyState, WebSocket.OPEN);

  const oversized = new WebSocket(ws);
  sockets.push(oversized);
  oversized.on("error", () => {});
  await once(oversized, "open");
  const closed = once(oversized, "close");
  oversized.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "chat", text: "x".repeat(2048) }));
  assert.equal((await closed)[0], 1009);
});

test("WebSocket validates every message and enforces rate and room caps", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws, base } = await startApp(directory, {
    maxPlayers: 1,
    maxRooms: 2,
    maxMessages: 2,
  });
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  const first = new WebSocket(ws);
  sockets.push(first);
  await once(first, "open");
  const joined = once(first, "message");
  first.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: "Ada" }));
  assert.equal(JSON.parse((await joined)[0].toString()).type, "joined");

  const second = new WebSocket(ws);
  sockets.push(second);
  await once(second, "open");
  const fullError = once(second, "message");
  const fullClose = once(second, "close");
  second.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: "Lin" }));
  assert.equal(JSON.parse((await fullError)[0].toString()).code, "room-full");
  assert.equal((await fullClose)[0], 1008);

  const malformedSocket = new WebSocket(ws);
  sockets.push(malformedSocket);
  await once(malformedSocket, "open");
  const invalidError = once(malformedSocket, "message");
  malformedSocket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: "Eve", admin: true }));
  assert.equal(JSON.parse((await invalidError)[0].toString()).code, "invalid-join");

  const roomCap = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Over limit" }),
  });
  assert.equal(roomCap.status, 409);

  const rateLimited = new WebSocket(ws);
  sockets.push(rateLimited);
  await once(rateLimited, "open");
  const rateJoined = once(rateLimited, "message");
  rateLimited.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "deep-field", name: "Rate test" }));
  assert.equal(JSON.parse((await rateJoined)[0].toString()).type, "joined");
  const firstChat = nextMessage(rateLimited, ofType("chat"));
  rateLimited.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "chat", text: "first" }));
  assert.equal((await firstChat).text, "first");
  const rateError = nextMessage(rateLimited, ofType("error"));
  rateLimited.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "chat", text: "second" }));
  assert.equal((await rateError).code, "rate-limit");
});

test("HTTP rejects a symlink that escapes the static root", async (t) => {
  const directory = await createTempDirectory();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "dist");
  const outside = join(directory, "secret.txt");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "<title>Safe</title>");
  await writeFile(outside, "secret");
  const linkPath = join(dist, "leak.txt");
  try {
    await symlink(outside, linkPath);
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES")
      return t.skip("Symlink creation requires elevated Windows privileges");
    throw error;
  }
  const app = await createApp({
    ...loadConfig({ PORT: "0", LOG_DIR: join(directory, "logs") }),
    clientDist: dist,
  }, { logger: quietLogger });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(() => closeApp(app));
  assert.equal((await fetch(`${base}/leak.txt`)).status, 404);
});
