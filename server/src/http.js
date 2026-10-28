import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { extname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocketServer, WebSocket } from "ws";
import { MatchLogStore } from "./log/matchlog.js";
import { RoomManager } from "./rooms.js";
import { attachWebSocketHandlers } from "./ws.js";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wav", "audio/wav"],
]);
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request, limit) {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new HttpError(413, "Request body is too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

async function sendFile(request, response, file) {
  const info = await stat(file);
  if (!info.isFile()) throw new HttpError(404, "Not found");
  response.writeHead(200, {
    "content-type": MIME_TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream",
    "content-length": info.size,
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
  if (request.method === "HEAD") return response.end();
  await pipeline(createReadStream(file), response);
}

function safeStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Malformed URL path");
  }
  if (decoded.includes("\0")) throw new HttpError(400, "Invalid URL path");
  const rootPath = resolve(root);
  const file = resolve(rootPath, `.${decoded.replaceAll("\\", "/")}`);
  const pathFromRoot = relative(rootPath, file);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot.startsWith("../"))
    throw new HttpError(403, "Forbidden");
  return file;
}

function validateRoomPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new HttpError(400, "Body must be a JSON object");
  if (Object.keys(payload).some((key) => !["name", "arena"].includes(key)))
    throw new HttpError(400, "Only name and arena are accepted");
  if (typeof payload.name !== "string" || payload.name.trim().length < 1 || payload.name.trim().length > 40)
    throw new HttpError(400, "Room name must contain 1–40 characters");
  let arena;
  if (payload.arena !== undefined) {
    const { width, height, asteroids } = payload.arena ?? {};
    if (
      !Number.isInteger(width) || width < 320 || width > 4096 ||
      !Number.isInteger(height) || height < 240 || height > 4096 ||
      !Number.isInteger(asteroids) || asteroids < 0 || asteroids > 100
    )
      throw new HttpError(400, "Arena requires valid width, height, and asteroid count");
    arena = { width, height, asteroids };
  }
  return { name: payload.name.trim(), arena };
}

export async function createApp(config, { logger = console } = {}) {
  const logStore = new MatchLogStore(config.logDir);
  await logStore.init();
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    onRoom: (room) => logStore.start(room),
  });
  rooms.on("error", (error) => logger.error("Room manager error:", error));

  let wsHandlers = null;
  const startedAt = Date.now();
  const realDistRoot = await realpath(config.clientDist).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
      if (request.method === "GET" && url.pathname === "/health")
        return sendJson(response, 200, { ok: true, rooms: rooms.list().length });
      if (request.method === "GET" && url.pathname === "/api/slow") {
        const duration = Number(url.searchParams.get("ms") ?? "300");
        if (!Number.isInteger(duration) || duration < 1 || duration > 1000)
          throw new HttpError(400, "ms must be an integer between 1 and 1000");
        const startedAt = performance.now();
        while (performance.now() - startedAt < duration) {
          // Deliberately blocks the event loop for the lab demonstration.
        }
        return sendJson(response, 200, { requestedMs: duration, elapsedMs: performance.now() - startedAt });
      }
      if (request.method === "GET" && url.pathname === "/api/rooms")
        return sendJson(response, 200, { rooms: rooms.list() });
      if (request.method === "GET" && url.pathname === "/api/stats")
        return sendJson(response, 200, {
          uptimeSeconds: (Date.now() - startedAt) / 1000,
          memory: process.memoryUsage(),
          ...wsHandlers.stats(),
        });
      if (request.method === "POST" && url.pathname === "/api/rooms") {
        let room;
        try {
          room = rooms.create(validateRoomPayload(await readJson(request, config.maxPayload)));
        } catch (error) {
          if (error instanceof TypeError || error instanceof RangeError)
            throw new HttpError(409, error.message);
          throw error;
        }
        return sendJson(response, 201, {
          id: room.id,
          name: room.name,
          players: 0,
          capacity: room.maxPlayers,
          arena: room.arena,
        });
      }
      if (request.method === "GET" && url.pathname === "/api/replays")
        return sendJson(response, 200, { replays: await logStore.list() });
      if (request.method === "GET" && url.pathname.startsWith("/api/replays/")) {
        const id = url.pathname.slice("/api/replays/".length);
        const file = logStore.resolveId(id);
        if (!file) throw new HttpError(404, "Replay not found");
        return await sendFile(request, response, file);
      }
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws"))
        throw new HttpError(404, "Not found");
      if (!["GET", "HEAD"].includes(request.method))
        throw new HttpError(405, "Method not allowed");
      if (!realDistRoot) throw new HttpError(503, "Client build is missing; run npm run build");

      const requested = url.pathname === "/" ? "/index.html" : url.pathname;
      let file = safeStaticPath(realDistRoot, requested);
      const realFile = await realpath(file).catch((error) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (
        realFile &&
        (realFile === realDistRoot || realFile.startsWith(`${realDistRoot}${sep}`))
      ) {
        file = realFile;
      } else if (request.headers.accept?.includes("text/html")) {
        file = resolve(realDistRoot, "index.html");
      } else {
        throw new HttpError(404, "Not found");
      }
      return await sendFile(request, response, file);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : error.code === "ENOENT" ? 404 : 500;
      if (status === 500) logger.error("HTTP request failed:", error);
      sendJson(response, status, { error: status === 500 ? "Internal server error" : error.message });
    }
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayload,
    perMessageDeflate: false,
  });
  wss.on("error", (error) => logger.error("WebSocket server error:", error));
  server.on("upgrade", (request, socket, head) => {
    let pathname;
    try {
      pathname = new URL(request.url, `http://${request.headers.host ?? "localhost"}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request);
    });
  });
  wsHandlers = attachWebSocketHandlers(wss, rooms, config, logger);

  let closed = false;
  return {
    server,
    wss,
    rooms,
    async close() {
      if (closed) return;
      closed = true;
      const serverClosed = new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
      for (const socket of wss.clients) {
        if (socket.readyState === WebSocket.OPEN)
          socket.close(1001, "Server shutting down");
        else
          socket.terminate();
      }
      wsHandlers.close();
      await new Promise((resolveClose) => wss.close(resolveClose));
      await serverClosed;
      await logStore.close();
    },
  };
}
