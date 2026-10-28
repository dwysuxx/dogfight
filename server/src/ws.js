import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import * as binaryCodec from "@dogfight/shared/codec/binary.js";
import * as jsonCodec from "@dogfight/shared/codec/json.js";
import { TICK_RATE } from "@dogfight/shared/protocol/messages.js";
import { MESSAGE_TYPES, ProtocolError, decodeClientMessage, serverMessage } from "./protocol.js";
import { Match } from "./match.js";
import { createNetSim, netSimFromQuery } from "./netsim.js";
import { createTicker } from "./ticker.js";

function consumeToken(client, maxPerSecond) {
  const now = Date.now();
  const elapsed = (now - client.tokenUpdatedAt) / 1000;
  client.tokens = Math.min(maxPerSecond, client.tokens + elapsed * maxPerSecond);
  client.tokenUpdatedAt = now;
  if (client.tokens < 1) return false;
  client.tokens -= 1;
  return true;
}

const byteLength = (payload) => (typeof payload === "string" ? Buffer.byteLength(payload) : payload.byteLength);

export function attachWebSocketHandlers(wss, rooms, config, logger = console) {
  const matches = new Map(); // room id -> { room, match, ticker }
  const clients = new Set();

  // Every outgoing frame goes through the client's latency injector, then
  // the slow-client policy. Snapshots and chat are droppable (a newer
  // snapshot is coming anyway); anything else on a backed-up socket closes it.
  function sendRaw(client, payload, { kind = "control" } = {}) {
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

  const sendJson = (client, message, options) => sendRaw(client, JSON.stringify(message), options);

  function broadcastJson(room, message, options) {
    const serialized = JSON.stringify(message);
    for (const player of room.players.values()) sendRaw(player.client, serialized, options);
  }

  function fail(client, code, reason, closeCode = 1008) {
    const { socket } = client;
    // Errors bypass the injector: the close must not overtake the message.
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(serverMessage(MESSAGE_TYPES.ERROR, { code, message: reason })));
      socket.close(closeCode, reason.slice(0, 120));
    }
  }

  function sendRoster(room) {
    const match = matches.get(room.id)?.match;
    broadcastJson(room, serverMessage(MESSAGE_TYPES.ROSTER, { room: room.id, players: match?.roster() ?? [] }));
  }

  // One snapshot per tick. The binary body is encoded once and only the
  // 4-byte ack is patched per client; JSON is stringified per client.
  function broadcastState({ room, match }) {
    const snapshot = match.snapshot();
    let binary = null;
    for (const player of room.players.values()) {
      const { client } = player;
      const ack = match.player(player.id)?.lastProcessedSeq ?? 0;
      let payload;
      if (client.codec === "binary") {
        binary ??= binaryCodec.encode(snapshot);
        payload = binaryCodec.withAck(binary, ack);
      } else {
        payload = jsonCodec.encode({ ...snapshot, ack });
      }
      sendRaw(client, payload, { kind: "state" });
    }
  }

  function matchFor(room) {
    let entry = matches.get(room.id);
    if (entry) return entry;
    const match = new Match(room);
    entry = { room, match, ticker: null };
    entry.ticker = createTicker({
      rate: TICK_RATE,
      tick: () => {
        match.step();
        broadcastState(entry);
      },
    });
    matches.set(room.id, entry);
    const onLeave = (player) => {
      match.leave(player.id);
      if (room.players.size > 0) return sendRoster(room);
      entry.ticker.stop();
      matches.delete(room.id);
      room.off("leave", onLeave);
      room.off("chat", onChat);
    };
    const onChat = (chat) =>
      broadcastJson(room, serverMessage(MESSAGE_TYPES.CHAT, { room: room.id, ...chat }), { kind: "chat" });
    room.on("leave", onLeave);
    room.on("chat", onChat);
    return entry;
  }

  function handleJoin(client, message) {
    if (client.room) return fail(client, "already-joined", "This connection already joined a room");
    const room = rooms.get(message.room);
    if (!room) return fail(client, "room-not-found", "Room does not exist", 1008);
    const entry = matchFor(room);
    const player = { id: client.id, name: message.name, socket: client.socket, client };
    try {
      room.join(player);
    } catch (error) {
      return fail(client, "room-full", error.message);
    }
    const playerId = entry.match.join(player);
    clearTimeout(client.joinTimer);
    client.room = room;
    client.player = player;
    client.codec = message.codec;
    sendJson(
      client,
      serverMessage(MESSAGE_TYPES.JOINED, {
        room: room.id,
        player: { id: player.id, playerId, name: player.name },
        arena: room.arena,
        tickRate: TICK_RATE,
        codec: client.codec,
        netsim: client.netsim.conditions,
      }),
    );
    sendRoster(room);
    entry.ticker.start();
  }

  function handleMessage(client, message) {
    if (message.type === MESSAGE_TYPES.JOIN) return handleJoin(client, message);
    if (message.type === MESSAGE_TYPES.PING) {
      const tick = client.room ? (matches.get(client.room.id)?.match.world.tick ?? 0) : 0;
      const pong = { type: MESSAGE_TYPES.PONG, t: message.t, tick };
      return sendRaw(client, client.codec === "binary" ? binaryCodec.encode(pong) : jsonCodec.encode(pong));
    }
    if (message.type === MESSAGE_TYPES.NETSIM) {
      client.netsim.set(message);
      logger.info(`Client ${client.id} network simulation: ${JSON.stringify(client.netsim.conditions)}`);
      return sendJson(client, serverMessage(MESSAGE_TYPES.NETSIM, client.netsim.conditions));
    }
    if (!client.room || !client.player)
      return fail(client, "not-joined", "Join a room before sending chat or input");
    if (message.type === MESSAGE_TYPES.CHAT) {
      const chat = client.room.chat(client.player, message.text);
      logger.info(`[${client.room.id}] ${client.player.name}: ${chat.text}`);
    } else if (message.type === MESSAGE_TYPES.INPUT) {
      matches.get(client.room.id)?.match.receiveInputs(client.id, message.inputs);
    }
  }

  wss.on("connection", (socket, request) => {
    let netsimConditions;
    try {
      const url = new URL(request?.url ?? "/ws", "http://localhost");
      netsimConditions = netSimFromQuery(url.searchParams, config.netsim);
    } catch (error) {
      socket.close(1008, error.message.slice(0, 120));
      return;
    }
    const client = {
      id: randomUUID(),
      socket,
      room: null,
      player: null,
      codec: "json",
      netsim: createNetSim(netsimConditions),
      tokens: config.maxMessagesPerSecond,
      tokenUpdatedAt: Date.now(),
      stats: { bytesIn: 0, bytesOut: 0, messagesIn: 0, messagesOut: 0, skipped: 0, rate: null, previous: null },
    };
    clients.add(client);
    socket.isAlive = true;
    socket.on("error", (error) => logger.error(`WebSocket ${client.id} error:`, error));

    client.joinTimer = setTimeout(() => {
      if (!client.room) fail(client, "join-timeout", "Send a join message within five seconds");
    }, config.joinTimeoutMs);

    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (data, isBinary) => {
      // Rate limit on arrival, before the injected delay.
      if (!consumeToken(client, config.maxMessagesPerSecond)) {
        logger.warn(`Rate limit exceeded by ${client.id}`);
        fail(client, "rate-limit", "Too many messages", 1008);
        return;
      }
      client.stats.bytesIn += data.byteLength ?? data.length;
      client.stats.messagesIn++;

      let message;
      try {
        message = decodeClientMessage(data, isBinary);
      } catch (error) {
        if (!(error instanceof ProtocolError)) throw error;
        fail(client, error.code, error.message, error.code === "unsupported-version" ? 1002 : 1008);
        return;
      }
      client.netsim.receive(
        () => {
          if (socket.readyState === WebSocket.OPEN) handleMessage(client, message);
        },
        { droppable: message.type === MESSAGE_TYPES.INPUT },
      );
    });

    socket.once("close", () => {
      clearTimeout(client.joinTimer);
      client.netsim.dispose();
      clients.delete(client);
      if (!client.room) return;
      const room = client.room;
      client.room = null;
      room.leave(client.id);
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }
  }, config.heartbeatMs);
  heartbeat.unref();

  // Bytes/s per client, measured over the last second.
  const rates = setInterval(() => {
    for (const { stats } of clients) {
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

  function close() {
    clearInterval(heartbeat);
    clearInterval(rates);
    for (const { ticker } of matches.values()) ticker.stop();
    for (const client of clients) client.netsim.dispose();
  }
  wss.once("close", close);

  return {
    close,
    stats() {
      return {
        tickRate: TICK_RATE,
        matches: [...matches.values()].map(({ room, match, ticker }) => ({
          room: room.id,
          tick: match.world.tick,
          players: match.playerCount,
          entities: match.world.size,
          ticker: ticker.stats(),
          inputs: { ...match.stats },
        })),
        clients: [...clients].map((client) => ({
          id: client.id,
          room: client.room?.id ?? null,
          name: client.player?.name ?? null,
          codec: client.codec,
          netsim: client.netsim.stats(),
          bytesIn: client.stats.bytesIn,
          bytesOut: client.stats.bytesOut,
          skippedSnapshots: client.stats.skipped,
          lastSecond: client.stats.rate,
        })),
      };
    },
  };
}
