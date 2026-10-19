import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { test } from "node:test";
import WebSocket from "ws";
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

test("protocol accepts versioned join/chat and rejects malformed or unknown messages", () => {
  assert.equal(validateClientMessage({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: "Ada" }).ok, true);
  assert.deepEqual(validateClientMessage({ v: 0, type: "chat", text: " hi " }).message.text, "hi");
  assert.equal(validateClientMessage({ v: 3, type: "join", room: "orbit", name: "Ada" }).code, "unsupported-version");
  assert.equal(validateClientMessage({ v: 0, type: "join", room: "../secrets", name: "Ada" }).ok, false);
  assert.equal(validateClientMessage({ v: 0, type: "chat", text: "x".repeat(501) }).ok, false);
  assert.equal(validateClientMessage({ v: 0, type: "chat", text: "hello", extra: true }).ok, false);
  assert.equal(validateClientMessage({ v: 0, type: "wat" }).code, "unknown-type");
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

test("WebSocket clients join, receive roster and chat, and leave cleanly", async (t) => {
  const directory = await createTempDirectory();
  const { app, ws } = await startApp(directory);
  const sockets = [];
  t.after(async () => {
    await closeApp(app, sockets);
    await rm(directory, { recursive: true, force: true });
  });

  async function join(name) {
    const socket = new WebSocket(ws);
    sockets.push(socket);
    await once(socket, "open");
    const joinedMessage = once(socket, "message");
    socket.send(JSON.stringify({ v: 0, type: "join", room: "orbit", name }));
    const [joinedRaw] = await joinedMessage;
    assert.equal(JSON.parse(joinedRaw.toString()).type, "joined");
    return socket;
  }

  const first = await join("Ada");
  const roster = once(first, "message");
  const second = await join("Lin");
  const [rosterRaw] = await roster;
  assert.deepEqual(JSON.parse(rosterRaw.toString()).players.map((player) => player.name), ["Ada", "Lin"]);

  const firstChat = once(first, "message");
  const secondChat = once(second, "message");
  second.send(JSON.stringify({ v: 0, type: "chat", text: "Hello, Ada!" }));
  const [firstRaw] = await firstChat;
  const [secondRaw] = await secondChat;
  assert.equal(JSON.parse(firstRaw.toString()).text, "Hello, Ada!");
  assert.equal(JSON.parse(secondRaw.toString()).player.name, "Lin");
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
  live.send(JSON.stringify({ v: 0, type: "join", room: "orbit", name: "Heartbeat" }));
  assert.equal(JSON.parse((await joined)[0].toString()).type, "joined");
  await once(live, "ping");
  assert.equal(live.readyState, WebSocket.OPEN);

  const oversized = new WebSocket(ws);
  sockets.push(oversized);
  oversized.on("error", () => {});
  await once(oversized, "open");
  const closed = once(oversized, "close");
  oversized.send(JSON.stringify({ v: 0, type: "chat", text: "x".repeat(2048) }));
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
  first.send(JSON.stringify({ v: 0, type: "join", room: "orbit", name: "Ada" }));
  assert.equal(JSON.parse((await joined)[0].toString()).type, "joined");

  const second = new WebSocket(ws);
  sockets.push(second);
  await once(second, "open");
  const fullError = once(second, "message");
  const fullClose = once(second, "close");
  second.send(JSON.stringify({ v: 0, type: "join", room: "orbit", name: "Lin" }));
  assert.equal(JSON.parse((await fullError)[0].toString()).code, "room-full");
  assert.equal((await fullClose)[0], 1008);

  const malformedSocket = new WebSocket(ws);
  sockets.push(malformedSocket);
  await once(malformedSocket, "open");
  const invalidError = once(malformedSocket, "message");
  malformedSocket.send(JSON.stringify({ v: 0, type: "join", room: "orbit", name: "Eve", admin: true }));
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
  rateLimited.send(JSON.stringify({ v: 0, type: "join", room: "deep-field", name: "Rate test" }));
  assert.equal(JSON.parse((await rateJoined)[0].toString()).type, "joined");
  const firstChat = once(rateLimited, "message");
  rateLimited.send(JSON.stringify({ v: 0, type: "chat", text: "first" }));
  assert.equal(JSON.parse((await firstChat)[0].toString()).type, "chat");
  const rateError = once(rateLimited, "message");
  rateLimited.send(JSON.stringify({ v: 0, type: "chat", text: "second" }));
  assert.equal(JSON.parse((await rateError)[0].toString()).code, "rate-limit");
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
