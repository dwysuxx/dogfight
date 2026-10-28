import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { type WebSocketServer, WebSocket } from "ws";
import { tick } from "@dogfight/shared/brand.ts";
import { binaryCodec, withAck } from "@dogfight/shared/codec/binary.ts";
import type { Codec, Payload } from "@dogfight/shared/codec/codec.ts";
import { jsonCodec } from "@dogfight/shared/codec/json.ts";
import {
  type ClientMessage,
  type CodecName,
  type JoinMessage,
  type ServerMessage,
  TICK_RATE,
  assertNever,
  encodeJson,
} from "@dogfight/shared/protocol.ts";
import type { ServerConfig } from "./config.ts";
import { decodeClientFrame } from "./frames.ts";
import { Match, type MatchStats } from "./match.ts";
import { type NetSimStats, type NetSimulator, createNetSim, netSimFromQuery } from "./netsim.ts";
import type { ChatRecord, Room, RoomManager, RoomPlayer } from "./rooms.ts";
import { type Ticker, type TickerStats, createTicker } from "./ticker.ts";

export interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const CODECS = { json: jsonCodec, binary: binaryCodec } satisfies Record<CodecName, Codec>;
const NO_TICK = tick(0);

interface Rates {
  bytesInPerSecond: number;
  bytesOutPerSecond: number;
  messagesInPerSecond: number;
  messagesOutPerSecond: number;
}

interface Client {
  readonly id: string;
  readonly socket: WebSocket;
  readonly netsim: NetSimulator;
  readonly joinTimer: ReturnType<typeof setTimeout>;
  room: Room | null;
  player: RoomPlayer | null;
  codec: Codec;
  alive: boolean;
  tokens: number;
  tokenUpdatedAt: number;
  stats: {
    bytesIn: number;
    bytesOut: number;
    messagesIn: number;
    messagesOut: number;
    skipped: number;
    rate: Rates | null;
    previous: { bytesIn: number; bytesOut: number; messagesIn: number; messagesOut: number } | null;
  };
}

interface MatchEntry {
  readonly room: Room;
  readonly match: Match;
  readonly ticker: Ticker;
}

type SendKind = "control" | "state" | "chat";

export interface WsStats {
  tickRate: number;
  matches: { room: string; tick: number; players: number; entities: number; ticker: TickerStats; inputs: MatchStats }[];
  clients: {
    id: string;
    room: string | null;
    name: string | null;
    codec: CodecName;
    netsim: NetSimStats;
    bytesIn: number;
    bytesOut: number;
    skippedSnapshots: number;
    lastSecond: Rates | null;
  }[];
}

function consumeToken(client: Client, maxPerSecond: number): boolean {
  const now = Date.now();
  const elapsed = (now - client.tokenUpdatedAt) / 1000;
  client.tokens = Math.min(maxPerSecond, client.tokens + elapsed * maxPerSecond);
  client.tokenUpdatedAt = now;
  if (client.tokens < 1) return false;
  client.tokens -= 1;
  return true;
}

const byteLength = (payload: Payload) => (typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength);
const rawLength = (data: Buffer | ArrayBuffer | Buffer[]) =>
  Array.isArray(data) ? data.reduce((sum, chunk) => sum + chunk.byteLength, 0) : data.byteLength;

export function attachWebSocketHandlers(
  wss: WebSocketServer,
  rooms: RoomManager,
  config: ServerConfig,
  logger: Logger = console,
): { close(): void; stats(): WsStats } {
  const matches = new Map<string, MatchEntry>(); // room id -> match
  const clients = new Map<string, Client>(); // client id (= room player id) -> client

  // Every outgoing frame goes through the client's latency injector, then
  // the slow-client policy. Snapshots and chat are droppable (a newer
  // snapshot is coming anyway); anything else on a backed-up socket closes it.
  function sendRaw(client: Client, payload: Payload, kind: SendKind = "control"): boolean {
    const { socket } = client;
    if (socket.readyState !== WebSocket.OPEN) return false;
    return client.netsim.send(
      () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > config.slowClientBytes) {
          if (kind === "state" || kind === "chat") {
            client.stats.skipped++;
            return;
          }
          logger.warn(`Closing slow client ${client.id}`);
          socket.close(1013, "Slow client");
          return;
        }
        client.stats.bytesOut += byteLength(payload);
        client.stats.messagesOut++;
        socket.send(payload, (error) => {
          if (error) socket.emit("error", error);
        });
      },
      { droppable: kind === "state" },
    );
  }

  const send = (client: Client, message: ServerMessage, kind?: SendKind) => sendRaw(client, encodeJson(message), kind);

  function broadcast(room: Room, message: ServerMessage, kind?: SendKind): void {
    const serialized = encodeJson(message);
    for (const id of room.players.keys()) {
      const client = clients.get(id);
      if (client) sendRaw(client, serialized, kind);
    }
  }

  function fail(client: Client, code: string, reason: string, closeCode = 1008): void {
    const { socket } = client;
    // Errors bypass the injector: the close must not overtake the message.
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(encodeJson({ type: "error", code, message: reason }));
    socket.close(closeCode, reason.slice(0, 120));
  }

  function sendRoster(room: Room): void {
    const players = matches.get(room.id)?.match.roster() ?? [];
    broadcast(room, { type: "roster", room: room.id, players });
  }

  // One snapshot per tick. The binary body is encoded once and only the
  // 4-byte ack is patched per client; JSON is stringified per client.
  function broadcastState({ room, match }: { room: Room; match: Match }): void {
    const snapshot = match.snapshot();
    let shared: Uint8Array<ArrayBuffer> | null = null;
    for (const id of room.players.keys()) {
      const client = clients.get(id);
      if (!client) continue;
      const ack = match.player(id)?.lastProcessedSeq ?? snapshot.ack;
      if (client.codec.name === "binary") {
        shared ??= binaryCodec.encode(snapshot);
        sendRaw(client, withAck(shared, ack), "state");
      } else {
        sendRaw(client, client.codec.encode({ ...snapshot, ack }), "state");
      }
    }
  }

  function matchFor(room: Room): MatchEntry {
    const existing = matches.get(room.id);
    if (existing) return existing;
    const match = new Match(room);
    const ticker = createTicker({
      rate: TICK_RATE,
      tick: () => {
        match.step();
        broadcastState({ room, match });
      },
    });
    const entry: MatchEntry = { room, match, ticker };
    matches.set(room.id, entry);
    const onLeave = (player: RoomPlayer) => {
      match.leave(player.id);
      if (room.players.size > 0) return sendRoster(room);
      ticker.stop();
      matches.delete(room.id);
      room.off("leave", onLeave);
      room.off("chat", onChat);
    };
    const onChat = (chat: ChatRecord) => broadcast(room, { type: "chat", room: room.id, ...chat }, "chat");
    room.on("leave", onLeave);
    room.on("chat", onChat);
    return entry;
  }

  function handleJoin(client: Client, message: JoinMessage): void {
    if (client.room) return fail(client, "already-joined", "This connection already joined a room");
    const room = rooms.get(message.room);
    if (!room) return fail(client, "room-not-found", "Room does not exist", 1008);
    const entry = matchFor(room);
    const player: RoomPlayer = { id: client.id, name: message.name };
    try {
      room.join(player);
    } catch (error: unknown) {
      return fail(client, "room-full", error instanceof Error ? error.message : "Room is full");
    }
    const playerId = entry.match.join(player);
    clearTimeout(client.joinTimer);
    client.room = room;
    client.player = player;
    client.codec = CODECS[message.codec];
    send(client, {
      type: "joined",
      room: room.id,
      player: { id: player.id, playerId, name: player.name },
      arena: room.arena,
      tickRate: TICK_RATE,
      codec: client.codec.name,
      netsim: client.netsim.conditions,
    });
    sendRoster(room);
    entry.ticker.start();
  }

  function handleMessage(client: Client, message: ClientMessage): void {
    switch (message.type) {
      case "join":
        return handleJoin(client, message);
      case "ping": {
        const tick = (client.room && matches.get(client.room.id)?.match.world.tick) || NO_TICK;
        sendRaw(client, client.codec.encode({ type: "pong", t: message.t, tick }));
        return;
      }
      case "netsim": {
        const { lag, jitter, drop } = message;
        client.netsim.set({ lag, jitter, drop });
        logger.info(`Client ${client.id} network simulation: ${JSON.stringify(client.netsim.conditions)}`);
        send(client, { type: "netsim", ...client.netsim.conditions });
        return;
      }
      case "chat":
      case "input": {
        const { room, player } = client;
        if (!room || !player) return fail(client, "not-joined", "Join a room before sending chat or input");
        if (message.type === "chat") {
          const chat = room.chat(player, message.text);
          logger.info(`[${room.id}] ${player.name}: ${chat.text}`);
        } else {
          matches.get(room.id)?.match.receiveInputs(client.id, message.inputs);
        }
        return;
      }
      default:
        return assertNever(message, "client message");
    }
  }

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "/ws", "http://localhost");
    const conditions = netSimFromQuery(url.searchParams, config.netsim);
    if (!conditions.ok) {
      socket.close(1008, conditions.error.message.slice(0, 120));
      return;
    }
    const id = randomUUID();
    const client: Client = {
      id,
      socket,
      room: null,
      player: null,
      codec: jsonCodec,
      alive: true,
      netsim: createNetSim(conditions.value),
      tokens: config.maxMessagesPerSecond,
      tokenUpdatedAt: Date.now(),
      joinTimer: setTimeout(() => {
        if (!client.room) fail(client, "join-timeout", "Send a join message within five seconds");
      }, config.joinTimeoutMs),
      stats: { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0, skipped: 0, rate: null, previous: null },
    };
    clients.set(id, client);
    socket.on("error", (error) => logger.error(`WebSocket ${client.id} error:`, error));
    socket.on("pong", () => {
      client.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      // Rate limit on arrival, before the injected delay.
      if (!consumeToken(client, config.maxMessagesPerSecond)) {
        logger.warn(`Rate limit exceeded by ${client.id}`);
        fail(client, "rate-limit", "Too many messages", 1008);
        return;
      }
      client.stats.bytesIn += rawLength(data);
      client.stats.messagesIn++;

      const decoded = decodeClientFrame(data, isBinary);
      if (!decoded.ok) {
        const { code, message } = decoded.error;
        fail(client, code, message, code === "unsupported-version" ? 1002 : 1008);
        return;
      }
      const message = decoded.value;
      client.netsim.receive(
        () => {
          if (socket.readyState === WebSocket.OPEN) handleMessage(client, message);
        },
        { droppable: message.type === "input" },
      );
    });

    socket.once("close", () => {
      clearTimeout(client.joinTimer);
      client.netsim.dispose();
      clients.delete(id);
      const room = client.room;
      client.room = null;
      room?.leave(client.id);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        client.socket.terminate();
        continue;
      }
      client.alive = false;
      if (client.socket.readyState === WebSocket.OPEN) client.socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  // Bytes/s per client, measured over the last second.
  const rates = setInterval(() => {
    for (const { stats } of clients.values()) {
      const { bytesIn, bytesOut, messagesIn, messagesOut } = stats;
      if (stats.previous)
        stats.rate = {
          bytesInPerSecond: bytesIn - stats.previous.bytesIn,
          bytesOutPerSecond: bytesOut - stats.previous.bytesOut,
          messagesInPerSecond: messagesIn - stats.previous.messagesIn,
          messagesOutPerSecond: messagesOut - stats.previous.messagesOut,
        };
      stats.previous = { bytesIn, bytesOut, messagesIn, messagesOut };
    }
  }, 1000);
  rates.unref();

  function close(): void {
    clearInterval(heartbeat);
    clearInterval(rates);
    for (const { ticker } of matches.values()) ticker.stop();
    for (const client of clients.values()) client.netsim.dispose();
  }
  wss.once("close", close);

  return {
    close,
    stats: () => ({
      tickRate: TICK_RATE,
      matches: [...matches.values()].map(({ room, match, ticker }) => ({
        room: room.id,
        tick: match.world.tick,
        players: match.playerCount,
        entities: match.world.size,
        ticker: ticker.stats(),
        inputs: { ...match.stats },
      })),
      clients: [...clients.values()].map((client) => ({
        id: client.id,
        room: client.room?.id ?? null,
        name: client.player?.name ?? null,
        codec: client.codec.name,
        netsim: client.netsim.stats(),
        bytesIn: client.stats.bytesIn,
        bytesOut: client.stats.bytesOut,
        skippedSnapshots: client.stats.skipped,
        lastSecond: client.stats.rate,
      })),
    }),
  };
}
