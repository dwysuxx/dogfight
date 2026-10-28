import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { extname, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer } from "ws";
import { CreateRoomRequestSchema, type RoomInfo, check } from "@dogfight/shared/protocol.ts";
import type { ServerConfig } from "./config.ts";
import { MatchLogStore } from "./log/matchlog.ts";
import { RoomManager } from "./rooms.ts";
import { type Logger, attachWebSocketHandlers } from "./ws.ts";

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
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A Node system error (ENOENT, EPERM, ...) narrowed from `unknown`.
export function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    request.resume();
    throw new HttpError(413, "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new HttpError(400, "Unexpected request body");
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

async function sendFile(request: IncomingMessage, response: ServerResponse, file: string): Promise<void> {
  const info = await stat(file);
  if (!info.isFile()) throw new HttpError(404, "Not found");
  response.writeHead(200, {
    "content-type": MIME_TYPES.get(extname(file).toLowerCase()) ?? "application/octet-stream",
    "content-length": info.size,
    "x-content-type-options": "nosniff",
    "cache-control": "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  await pipeline(createReadStream(file), response);
}

function safeStaticPath(root: string, pathname: string): string {
  let decoded: string;
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

export interface App {
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly rooms: RoomManager;
  close(): Promise<void>;
}

export async function createApp(config: ServerConfig, { logger = console }: { logger?: Logger } = {}): Promise<App> {
  const logStore = new MatchLogStore(config.logDir);
  await logStore.init();
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    onRoom: (room) => logStore.start(room),
  });
  rooms.on("error", (error) => logger.error("Room manager error:", error));

  const startedAt = Date.now();
  const realDistRoot = await realpath(config.clientDist).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload, perMessageDeflate: false });
  wss.on("error", (error) => logger.error("WebSocket server error:", error));
  const wsHandlers = attachWebSocketHandlers(wss, rooms, config, logger);

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const { pathname } = url;
    if (request.method === "GET" && pathname === "/health") return sendJson(response, 200, { ok: true, rooms: rooms.list().length });
    if (request.method === "GET" && pathname === "/api/slow") {
      const duration = Number(url.searchParams.get("ms") ?? "300");
      if (!Number.isInteger(duration) || duration < 1 || duration > 1000)
        throw new HttpError(400, "ms must be an integer between 1 and 1000");
      const started = performance.now();
      while (performance.now() - started < duration) {
        // Deliberately blocks the event loop for the lab demonstration.
      }
      return sendJson(response, 200, { requestedMs: duration, elapsedMs: performance.now() - started });
    }
    if (request.method === "GET" && pathname === "/api/rooms") return sendJson(response, 200, { rooms: rooms.list() });
    if (request.method === "GET" && pathname === "/api/stats")
      return sendJson(response, 200, {
        uptimeSeconds: (Date.now() - startedAt) / 1000,
        memory: process.memoryUsage(),
        ...wsHandlers.stats(),
      });
    if (request.method === "POST" && pathname === "/api/rooms") {
      const body = check(CreateRoomRequestSchema, await readJson(request, config.maxPayload));
      if (!body.ok) throw new HttpError(400, body.error.message);
      let created: RoomInfo;
      try {
        created = rooms.create(body.value).info();
      } catch (error: unknown) {
        if (error instanceof TypeError || error instanceof RangeError) throw new HttpError(409, error.message);
        throw error;
      }
      return sendJson(response, 201, created);
    }
    if (request.method === "GET" && pathname === "/api/replays") return sendJson(response, 200, { replays: await logStore.list() });
    if (request.method === "GET" && pathname.startsWith("/api/replays/")) {
      const file = logStore.resolveId(pathname.slice("/api/replays/".length));
      if (!file) throw new HttpError(404, "Replay not found");
      return sendFile(request, response, file);
    }
    if (pathname.startsWith("/api/") || pathname.startsWith("/ws")) throw new HttpError(404, "Not found");
    if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    if (!realDistRoot) throw new HttpError(503, "Client build is missing; run npm run build");

    let file = safeStaticPath(realDistRoot, pathname === "/" ? "/index.html" : pathname);
    const realFile = await realpath(file).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    });
    if (realFile && (realFile === realDistRoot || realFile.startsWith(`${realDistRoot}${sep}`))) file = realFile;
    else if (request.headers.accept?.includes("text/html")) file = resolve(realDistRoot, "index.html");
    else throw new HttpError(404, "Not found");
    return sendFile(request, response, file);
  }

  const server = createServer((request, response) => {
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof HttpError ? error.status : errorCode(error) === "ENOENT" ? 404 : 500;
      if (status === 500) logger.error("HTTP request failed:", error);
      const message = error instanceof Error ? error.message : "Request failed";
      sendJson(response, status, { error: status === 500 ? "Internal server error" : message });
    });
  });

  server.on("upgrade", (request, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "", `http://${request.headers.host ?? "localhost"}`).pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit("connection", webSocket, request));
  });

  let closed = false;
  return {
    server,
    wss,
    rooms,
    async close() {
      if (closed) return;
      closed = true;
      const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      for (const socket of wss.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.close(1001, "Server shutting down");
        else socket.terminate();
      }
      wsHandlers.close();
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      await serverClosed;
      await logStore.close();
    },
  };
}
