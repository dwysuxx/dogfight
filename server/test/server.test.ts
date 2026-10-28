import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { type Server, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { type TestContext, test } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";
import { seq } from "@dogfight/shared/brand.ts";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import {
  type Controls,
  PROTOCOL_VERSION,
  RoomInfoSchema,
  RoomsResponseSchema,
  type ServerMessage,
  check,
  parseServerMessage,
} from "@dogfight/shared/protocol.ts";
import { loadConfig } from "../src/config.ts";
import { type App, createApp, errorCode } from "../src/http.ts";
import { MatchLogStore } from "../src/log/matchlog.ts";
import { readReplay } from "../src/log/replay.ts";
import { Room, RoomManager } from "../src/rooms.ts";

const quietLogger = { error() {}, info() {}, warn() {} };
const v = PROTOCOL_VERSION;

async function createTempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "dogfight-lab06-"));
}

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address === "object", "server is listening on TCP");
  return address.port;
}

interface AppOptions {
  maxRooms?: number;
  maxPlayers?: number;
  maxPayload?: number;
  maxMessages?: number;
  joinTimeoutMs?: number;
  heartbeatMs?: number;
}

async function startApp(directory: string, options: AppOptions = {}) {
  const dist = join(directory, "dist");
  const logs = join(directory, "logs");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "<!doctype html><title>Dogfight test</title>");
  const config = loadConfig({
    HOST: "127.0.0.1",
    PORT: "0",
    LOG_DIR: logs,
    MAX_ROOMS: String(options.maxRooms ?? 8),
    MAX_PLAYERS_PER_ROOM: String(options.maxPlayers ?? 4),
    MAX_PAYLOAD: String(options.maxPayload ?? 1024),
    MAX_MESSAGES_PER_SECOND: String(options.maxMessages ?? 20),
    JOIN_TIMEOUT_MS: String(options.joinTimeoutMs ?? 5000),
    HEARTBEAT_MS: String(options.heartbeatMs ?? 15_000),
  });
  const app = await createApp({ ...config, clientDist: dist }, { logger: quietLogger });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const port = portOf(app.server);
  return { app, base: `http://127.0.0.1:${port}`, ws: `ws://127.0.0.1:${port}/ws`, logs };
}

async function closeApp(app: App, sockets: WebSocket[] = []): Promise<void> {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
  await app.close();
}

// Every response body is `unknown` until a schema says otherwise.
async function body<S extends z.ZodType>(response: Response, schema: S): Promise<z.infer<S>> {
  const value: unknown = await response.json();
  const parsed = check(schema, value);
  if (!parsed.ok) assert.fail(`${response.url}: ${parsed.error.message}`);
  return parsed.value;
}

function withApp(t: TestContext, options?: AppOptions) {
  const sockets: WebSocket[] = [];
  const ready = (async () => {
    const directory = await createTempDirectory();
    const started = await startApp(directory, options);
    t.onTestFinished(async () => {
      await closeApp(started.app, sockets);
      await rm(directory, { recursive: true, force: true });
    });
    return { ...started, sockets };
  })();
  return ready;
}

test("config is validated by a zod schema with defaults and resolves paths", () => {
  const config = loadConfig({ PORT: "0", MAX_ROOMS: "4", LOG_DIR: "var/logs" });
  assert.equal(config.port, 0);
  assert.equal(config.maxRooms, 4);
  assert.equal(config.maxMessagesPerSecond, 60, "default");
  assert.deepEqual(config.netsim, { lag: 0, jitter: 0, drop: 0 });
  assert.ok(config.logDir.endsWith(join("server", "var", "logs")));
  assert.throws(() => loadConfig({ PORT: "70000" }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ MAX_ROOMS: "1" }), /MAX_ROOMS must be an integer/);
  assert.throws(() => loadConfig({ HOST: "evil host" }), /HOST must be/);
  assert.throws(() => loadConfig({ NET_DROP: "0.9" }), /NET_/);
});

test("Room's typed EventEmitter emits ordered events and RoomManager caps and removes rooms", () => {
  const manager = new RoomManager({ maxRooms: 3, maxPlayersPerRoom: 1 });
  const room = manager.create({ name: "Test room" });
  const events: string[] = [];
  room.on("join", (player) => events.push(`join:${player.name}`));
  room.on("chat", (chat) => events.push(`chat:${chat.text}`));
  room.on("leave", () => events.push("leave"));
  room.on("empty", () => events.push("empty"));
  room.join({ id: "a", name: "Ada" });
  assert.throws(() => room.join({ id: "b", name: "Bob" }), /full/);
  room.chat({ id: "a", name: "Ada" }, "hello");
  room.leave("a");
  assert.deepEqual(events, ["join:Ada", "chat:hello", "leave", "empty"]);
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
    const path = store.resolveId(file);
    assert.ok(path);
    const types: unknown[] = [];
    for await (const event of readReplay(path)) {
      assert.ok(event && typeof event === "object" && "type" in event);
      types.push(event.type);
    }
    assert.deepEqual(types, ["join", "chat", "empty"]);
    assert.match(await readFile(path, "utf8"), /"text":"hello"}\n/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("HTTP API, safe static files, request caps, and streamed replay work", async (t) => {
  const { base, logs } = await withApp(t, { maxRooms: 3, maxPayload: 512 });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal((await body(health, z.object({ ok: z.boolean() }))).ok, true);

  const slowStarted = performance.now();
  const slow = await fetch(`${base}/api/slow?ms=10`);
  assert.equal(slow.status, 200);
  assert.ok(performance.now() - slowStarted >= 8);
  assert.equal((await fetch(`${base}/api/slow?ms=1001`)).status, 400);

  const staticPage = await fetch(base);
  assert.equal(staticPage.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await staticPage.text(), /Dogfight test/);

  const traversal = await new Promise<number | undefined>((resolve, reject) => {
    const { port } = new URL(base);
    const request = httpRequest({ host: "127.0.0.1", port, path: "/%2e%2e/%2e%2e/etc/passwd" }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
  assert.ok([400, 403, 404].includes(traversal ?? 0));
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);

  const created = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Practice", arena: { width: 800, height: 600, asteroids: 4 } }),
  });
  assert.equal(created.status, 201);
  const room = await body(created, RoomInfoSchema);
  const listed = await body(await fetch(`${base}/api/rooms`), RoomsResponseSchema);
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
  const replays = await body(await fetch(`${base}/api/replays`), z.object({ replays: z.array(z.string()) }));
  assert.ok(replays.replays.includes(replayId));
  assert.equal((await fetch(`${base}/api/replays/../../secrets`)).status, 404);
});

// --- WebSocket helpers --------------------------------------------------------

type MessageOf<K extends ServerMessage["type"]> = Extract<ServerMessage, { type: K }>;
const isType = <K extends ServerMessage["type"]>(message: ServerMessage, type: K): message is MessageOf<K> =>
  message.type === type;

// Every frame the server sends is parsed with the same schemas the client
// uses, so these tests also prove the server's output matches the protocol.
function decodeFrame(raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean): ServerMessage {
  const bytes = Array.isArray(raw) ? Buffer.concat(raw) : raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
  if (isBinary) {
    const decoded = binaryCodec.decode(bytes);
    assert.ok(decoded.ok, decoded.ok ? "" : decoded.error.message);
    const message = decoded.value;
    assert.ok(message.type === "state" || message.type === "pong", `server sent binary ${message.type}`);
    return message;
  }
  const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const parsed = parseServerMessage(value);
  assert.ok(parsed.ok, parsed.ok ? "" : `${parsed.error.code}: ${parsed.error.message}`);
  return parsed.value;
}

function nextMessage<K extends ServerMessage["type"]>(
  socket: WebSocket,
  type: K,
  predicate: (message: MessageOf<K>) => boolean = () => true,
  timeoutMs = 3000,
): Promise<MessageOf<K>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${type}`));
    }, timeoutMs);
    const onMessage = (raw: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      const message = decodeFrame(raw, isBinary);
      if (!isType(message, type) || !predicate(message)) return;
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

async function openSocket(url: string, sockets: WebSocket[]): Promise<WebSocket> {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await once(socket, "open");
  return socket;
}

async function joinRoom(
  ws: string,
  sockets: WebSocket[],
  { name, room = "orbit", codec, query = "" }: { name: string; room?: string; codec?: "json" | "binary"; query?: string },
) {
  const socket = await openSocket(`${ws}${query}`, sockets);
  const joined = nextMessage(socket, "joined");
  socket.send(JSON.stringify({ v, type: "join", room, name, ...(codec ? { codec } : {}) }));
  return { socket, joined: await joined };
}

const controls = (overrides: Partial<Controls> = {}): Controls => ({
  left: false,
  right: false,
  thrust: false,
  fire: false,
  ...overrides,
});

const closeCode = async (socket: WebSocket): Promise<unknown> => (await once(socket, "close"))[0];

test("WebSocket clients join, receive roster and chat, and leave cleanly", async (t) => {
  const { ws, sockets } = await withApp(t);

  const first = await joinRoom(ws, sockets, { name: "Ada" });
  assert.equal(first.joined.player.playerId, 1);
  assert.equal(first.joined.tickRate, 30);
  const roster = nextMessage(first.socket, "roster", (m) => m.players.length === 2);
  const second = await joinRoom(ws, sockets, { name: "Lin" });
  assert.equal(second.joined.player.playerId, 2);
  assert.deepEqual((await roster).players.map((player) => player.name), ["Ada", "Lin"]);

  const firstChat = nextMessage(first.socket, "chat");
  const secondChat = nextMessage(second.socket, "chat");
  second.socket.send(JSON.stringify({ v, type: "chat", text: "Hello, Ada!" }));
  assert.equal((await firstChat).text, "Hello, Ada!");
  assert.equal((await secondChat).player.name, "Lin");

  const afterLeave = nextMessage(first.socket, "roster", (m) => m.players.length === 1);
  second.socket.close();
  assert.deepEqual((await afterLeave).players.map((player) => player.name), ["Ada"]);
});

test("the authoritative match applies seq-numbered inputs and acks them per client", async (t) => {
  const { ws, base, sockets } = await withApp(t);

  const first = await joinRoom(ws, sockets, { name: "Ada", codec: "json" });
  const second = await joinRoom(ws, sockets, { name: "Lin", codec: "json" });
  const firstId = first.joined.player.playerId;

  // Both clients receive the same world for the same tick; only ack differs.
  const record = (socket: WebSocket) => {
    const states = new Map<number, MessageOf<"state">>();
    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      const message = decodeFrame(raw, isBinary);
      if (isType(message, "state")) states.set(message.tick, message);
    });
    return states;
  };
  const firstStates = record(first.socket);
  const secondStates = record(second.socket);
  const commonTick = async (): Promise<[MessageOf<"state">, MessageOf<"state">]> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      for (const [tick, a] of firstStates) {
        const b = secondStates.get(tick);
        if (b) return [a, b];
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("No common tick");
  };
  const [a, b] = await commonTick();
  assert.deepEqual(a.entities, b.entities);
  const ships = a.entities.flatMap((e) => (e.kind === "ship" ? [e] : []));
  assert.equal(ships.filter((ship) => ship.bot).length, 1);
  assert.deepEqual(ships.filter((ship) => !ship.bot).map((ship) => ship.owner).sort(), [1, 2]);
  const start = ships.find((ship) => ship.owner === firstId);
  assert.ok(start);

  // 12 thrust inputs, sent the way the client does: each message repeats the
  // last few (redundancy); the server must apply each seq exactly once.
  const inputs: { seq: number; controls: Controls }[] = [];
  for (let n = 1; n <= 12; n++) {
    inputs.push({ seq: n, controls: controls({ thrust: true }) });
    first.socket.send(JSON.stringify({ v, type: "input", inputs: inputs.slice(-4) }));
  }
  const thrusted = await nextMessage(first.socket, "state", (m) => m.ack === 12);
  const moved = thrusted.entities.find((e) => e.kind === "ship" && e.owner === firstId);
  assert.ok(moved);
  assert.ok(Math.hypot(moved.x - start.x, moved.y - start.y) > 2, "the ship moved under thrust");
  const otherView = await nextMessage(second.socket, "state", (m) => m.tick >= thrusted.tick);
  assert.equal(otherView.ack, 0, "acks are per client");

  first.socket.send(JSON.stringify({ v, type: "input", inputs: [{ seq: 13, controls: controls({ fire: true }) }] }));
  const fired = await nextMessage(second.socket, "state", (m) =>
    m.entities.some((e) => e.kind === "bullet" && e.owner === firstId),
  );
  const bullet = fired.entities.find((e) => e.kind === "bullet" && e.owner === firstId);
  assert.ok(bullet?.kind === "bullet");
  assert.equal(bullet.seq, 13, "the bullet carries the seq of the input that fired it");

  const stats = await body(
    await fetch(`${base}/api/stats`),
    z.object({
      matches: z.array(
        z.object({
          room: z.string(),
          players: z.number(),
          ticker: z.object({ rate: z.number() }),
          inputs: z.object({ inputsApplied: z.number() }),
        }),
      ),
    }),
  );
  const orbit = stats.matches.find((match) => match.room === "orbit");
  assert.ok(orbit);
  assert.equal(orbit.ticker.rate, 30);
  assert.equal(orbit.players, 2);
  assert.ok(orbit.inputs.inputsApplied >= 13);
});

test("binary clients get DataView snapshots and can send binary inputs and pings", async (t) => {
  const { ws, sockets } = await withApp(t);

  const { socket, joined } = await joinRoom(ws, sockets, { name: "Bin", room: "deep-field", codec: "binary" });
  const state = await nextMessage(socket, "state");
  assert.ok(state.entities.some((e) => e.kind === "ship" && e.owner === joined.player.playerId));
  assert.ok(state.entities.some((e) => e.kind === "asteroid" && e.shape.length === 11));

  socket.send(binaryCodec.encode({ type: "input", inputs: [{ seq: seq(1), controls: controls({ right: true }) }] }));
  await nextMessage(socket, "state", (m) => m.ack === 1);

  socket.send(binaryCodec.encode({ type: "ping", t: 1234.5 }));
  const pong = await nextMessage(socket, "pong");
  assert.equal(pong.t, 1234.5);
  assert.ok(pong.tick > 0);

  const closed = closeCode(socket);
  socket.send(Uint8Array.of(1, PROTOCOL_VERSION, 1, 1, 0, 0, 0, 0xff)); // reserved input bits set
  assert.equal(await closed, 1008);
});

test("the latency injector delays both directions of one connection", async (t) => {
  const { ws, sockets } = await withApp(t);

  const { socket, joined } = await joinRoom(ws, sockets, { name: "Laggy", query: "?lag=60" });
  assert.deepEqual(joined.netsim, { lag: 60, jitter: 0, drop: 0 });
  const sentAt = performance.now();
  socket.send(JSON.stringify({ v, type: "ping", t: sentAt }));
  await nextMessage(socket, "pong");
  assert.ok(performance.now() - sentAt >= 115, "60 ms each way");

  socket.send(JSON.stringify({ v, type: "netsim", lag: 0, jitter: 0, drop: 0 }));
  assert.equal((await nextMessage(socket, "netsim")).lag, 0);

  const rejected = new WebSocket(`${ws}?drop=2`);
  sockets.push(rejected);
  rejected.on("error", () => {});
  assert.equal(await closeCode(rejected), 1008);
});

test("WebSocket rejects clients that miss the join deadline", async (t) => {
  const { ws, sockets } = await withApp(t, { joinTimeoutMs: 40 });
  const socket = await openSocket(ws, sockets);
  const error = nextMessage(socket, "error");
  const closed = closeCode(socket);
  assert.equal((await error).code, "join-timeout");
  assert.equal(await closed, 1008);
});

test("WebSocket heartbeat pings live clients and maxPayload closes oversized frames", async (t) => {
  const { ws, sockets } = await withApp(t, { maxPayload: 1024, heartbeatMs: 20 });

  const { socket: live } = await joinRoom(ws, sockets, { name: "Heartbeat" });
  live.on("error", () => {});
  await once(live, "ping");
  assert.equal(live.readyState, WebSocket.OPEN);

  const oversized = await openSocket(ws, sockets);
  oversized.on("error", () => {});
  const closed = closeCode(oversized);
  oversized.send(JSON.stringify({ v, type: "chat", text: "x".repeat(2048) }));
  assert.equal(await closed, 1009);
});

test("WebSocket validates every message with the shared schemas and enforces rate and room caps", async (t) => {
  const { ws, base, sockets } = await withApp(t, { maxPlayers: 1, maxRooms: 2, maxMessages: 2 });

  await joinRoom(ws, sockets, { name: "Ada" });

  const second = await openSocket(ws, sockets);
  const fullError = nextMessage(second, "error");
  const fullClose = closeCode(second);
  second.send(JSON.stringify({ v, type: "join", room: "orbit", name: "Lin" }));
  assert.equal((await fullError).code, "room-full");
  assert.equal(await fullClose, 1008);

  const malformed = await openSocket(ws, sockets);
  const invalidError = nextMessage(malformed, "error");
  malformed.send(JSON.stringify({ v, type: "join", room: "orbit", name: "Eve", admin: true }));
  assert.equal((await invalidError).code, "invalid-join");

  const oldVersion = await openSocket(ws, sockets);
  const versionClose = closeCode(oldVersion);
  oldVersion.send(JSON.stringify({ v: 0, type: "join", room: "orbit", name: "Old" }));
  assert.equal(await versionClose, 1002);

  const roomCap = await fetch(`${base}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Over limit" }),
  });
  assert.equal(roomCap.status, 409);

  const { socket: rateLimited } = await joinRoom(ws, sockets, { name: "Rate test", room: "deep-field" });
  const firstChat = nextMessage(rateLimited, "chat");
  rateLimited.send(JSON.stringify({ v, type: "chat", text: "first" }));
  assert.equal((await firstChat).text, "first");
  const rateError = nextMessage(rateLimited, "error");
  rateLimited.send(JSON.stringify({ v, type: "chat", text: "second" }));
  assert.equal((await rateError).code, "rate-limit");
});

test("HTTP rejects a symlink that escapes the static root", async (t) => {
  const directory = await createTempDirectory();
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const dist = join(directory, "dist");
  const outside = join(directory, "secret.txt");
  await mkdir(dist, { recursive: true });
  await writeFile(join(dist, "index.html"), "<title>Safe</title>");
  await writeFile(outside, "secret");
  try {
    await symlink(outside, join(dist, "leak.txt"));
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === "EPERM" || code === "EACCES") return t.skip("Symlink creation requires elevated Windows privileges");
    throw error;
  }
  const app = await createApp(
    { ...loadConfig({ PORT: "0", LOG_DIR: join(directory, "logs") }), clientDist: dist },
    { logger: quietLogger },
  );
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.onTestFinished(() => closeApp(app));
  assert.equal((await fetch(`http://127.0.0.1:${portOf(app.server)}/leak.txt`)).status, 404);
});
