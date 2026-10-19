import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { MESSAGE_TYPES, PROTOCOL_VERSION, serverMessage, validateClientMessage } from "./protocol.js";

function send(socket, value) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(value), (error) => {
    if (error) socket.emit("error", error);
  });
  return true;
}

function broadcast(room, message, config, logger) {
  const serialized = JSON.stringify(message);
  for (const player of room.players.values()) {
    const socket = player.socket;
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (socket.bufferedAmount > config.slowClientBytes) {
      if (message.type === MESSAGE_TYPES.CHAT) {
        logger.warn(`Dropped chat for slow client ${player.id} in room ${room.id}`);
        continue;
      }
      logger.warn(`Closing slow client ${player.id} in room ${room.id}`);
      socket.close(1013, "Slow client");
      continue;
    }
    socket.send(serialized, (error) => {
      if (error) socket.emit("error", error);
    });
  }
}

function fail(socket, code, reason, closeCode = 1008) {
  send(socket, serverMessage(MESSAGE_TYPES.ERROR, { code, message: reason }));
  if (socket.readyState === WebSocket.OPEN)
    socket.close(closeCode, reason.slice(0, 120));
}

function consumeToken(client, maxPerSecond) {
  const now = Date.now();
  const elapsed = (now - client.tokenUpdatedAt) / 1000;
  client.tokens = Math.min(maxPerSecond, client.tokens + elapsed * maxPerSecond);
  client.tokenUpdatedAt = now;
  if (client.tokens < 1) return false;
  client.tokens -= 1;
  return true;
}

function sendRoster(room, config, logger) {
  broadcast(
    room,
    serverMessage(MESSAGE_TYPES.ROSTER, { room: room.id, players: room.roster() }),
    config,
    logger,
  );
}

export function attachWebSocketHandlers(wss, rooms, config, logger = console) {
  const instrumentedRooms = new WeakSet();

  function instrumentRoom(room) {
    if (instrumentedRooms.has(room)) return;
    instrumentedRooms.add(room);
    room.on("join", () => queueMicrotask(() => sendRoster(room, config, logger)));
    room.on("leave", () => sendRoster(room, config, logger));
    room.on("chat", (chat) =>
      broadcast(room, serverMessage(MESSAGE_TYPES.CHAT, { room: room.id, ...chat }), config, logger),
    );
  }

  wss.on("connection", (socket) => {
    const client = {
      id: randomUUID(),
      room: null,
      player: null,
      tokens: config.maxMessagesPerSecond,
      tokenUpdatedAt: Date.now(),
    };
    socket.isAlive = true;
    socket.on("error", (error) => logger.error(`WebSocket ${client.id} error:`, error));

    const joinTimer = setTimeout(() => {
      if (!client.room) fail(socket, "join-timeout", "Send a join message within five seconds");
    }, config.joinTimeoutMs);

    socket.on("pong", () => {
      socket.isAlive = true;
    });
    socket.on("message", (data, isBinary) => {
      if (!consumeToken(client, config.maxMessagesPerSecond)) {
        logger.warn(`Rate limit exceeded by ${client.id}`);
        fail(socket, "rate-limit", "Too many messages", 1008);
        return;
      }
      if (isBinary) {
        fail(socket, "invalid-message", "Binary messages are not supported");
        return;
      }

      let input;
      try {
        input = JSON.parse(data.toString());
      } catch {
        fail(socket, "invalid-json", "Message must be valid JSON");
        return;
      }
      const validation = validateClientMessage(input);
      if (!validation.ok) {
        const closeCode = input?.v !== PROTOCOL_VERSION ? 1002 : 1008;
        fail(socket, validation.code, validation.reason, closeCode);
        return;
      }
      const { message } = validation;

      if (message.type === MESSAGE_TYPES.JOIN) {
        if (client.room) {
          fail(socket, "already-joined", "This connection already joined a room");
          return;
        }
        const room = rooms.get(message.room);
        if (!room) {
          fail(socket, "room-not-found", "Room does not exist", 1008);
          return;
        }
        const player = { id: client.id, name: message.name, socket };
        instrumentRoom(room);
        try {
          room.join(player);
        } catch (error) {
          fail(socket, "room-full", error.message);
          return;
        }
        clearTimeout(joinTimer);
        client.room = room;
        client.player = player;
        send(socket, serverMessage("joined", { room: room.id, player: { id: player.id, name: player.name } }));
        return;
      }

      if (!client.room || !client.player) {
        fail(socket, "not-joined", "Join a room before sending chat");
        return;
      }
      const chat = client.room.chat(client.player, message.text);
      logger.info(`[${client.room.id}] ${client.player.name}: ${chat.text}`);
    });

    socket.once("close", () => {
      clearTimeout(joinTimer);
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
  wss.once("close", () => clearInterval(heartbeat));
  return () => clearInterval(heartbeat);
}
