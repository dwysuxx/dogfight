import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { performance } from "node:perf_hooks";
import { extname, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream/promises";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { CreateRoomRequestSchema, type RoomInfo, check } from "@dogfight/shared/protocol.ts";
import type { ServerConfig } from "./config.ts";
import type { Logger } from "./log/logger.ts";
import { MatchLogStore } from "./log/matchlog.ts";
import { Registry } from "./metrics.ts";
import { type Room, RoomManager } from "./rooms.ts";
import { attachWebSocketHandlers } from "./ws.ts";

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wav", "audio/wav"],
]);

const AddBotsSchema = z.strictObject({ count: z.number().int().min(1).max(64) });

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

// The client address. Behind a proxy (TRUST_PROXY) the socket peer is the
// proxy itself; the proxy appends the address it saw as the last
// X-Forwarded-For hop, and earlier hops are whatever the client claimed.
// Only what the upgrade checks read, so tests can pass plain objects.
export interface UpgradeRequest {
  readonly headers: IncomingHttpHeaders;
  readonly socket: { readonly remoteAddress?: string | undefined };
}

export function clientIp(request: UpgradeRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const header = request.headers["x-forwarded-for"];
    const hops = (Array.isArray(header) ? header.join(",") : (header ?? "")).split(",");
    const last = hops.at(-1)?.trim();
    if (last) return last;
  }
  return request.socket.remoteAddress ?? "unknown";
}

// Cross-site WebSocket hijacking: CORS does not apply to upgrades, so the
// server checks Origin itself. No Origin means a non-browser client (bots,
// load tests), which could forge any header anyway.
export function originAllowed(request: UpgradeRequest, allowed: readonly string[]): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (allowed.includes(origin)) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export interface App {
  readonly server: Server;
  readonly wss: WebSocketServer;
  readonly rooms: RoomManager;
  readonly registry: Registry;
  // Readiness off: /ready answers 503 and new sockets are refused, so the
  // platform stops routing here while the running matches wind down.
  drain(): void;
  close(): Promise<void>;
}

export async function createApp(
  config: ServerConfig,
  { logger = console, registry = new Registry() }: { logger?: Logger; registry?: Registry } = {},
): Promise<App> {
  const logStore = new MatchLogStore(config.logDir);
  await logStore.init();
  // One log file per match session: a room that empties and is joined again
  // (the built-in rooms, or a lingering player room) starts a new file.
  const logMatches = (room: Room) => {
    logStore.start(room);
    room.once("empty", () => room.once("join", () => logMatches(room)));
  };
  const rooms = new RoomManager({
    maxRooms: config.maxRooms,
    maxPlayersPerRoom: config.maxPlayersPerRoom,
    idleMs: config.roomIdleMs,
    onRoom: logMatches,
  });
  rooms.on("error", (error) => logger.error({ err: error }, "room manager error"));
  rooms.on("roomCreated", (room) => logger.info({ roomId: room.id, name: room.name }, "room created"));
  rooms.on("roomRemoved", (room) => logger.info({ roomId: room.id }, "room removed"));

  let draining = false;
  const connectionsByIp = new Map<string, number>();
  const httpRequests = registry.counter("dogfight_http_requests_total", "HTTP requests by status class");
  const rejected = registry.counter("dogfight_ws_rejected_total", "WebSocket upgrades refused, by reason");
  const roomsCreated = registry.counter("dogfight_rooms_created_total", "Rooms created through the API");
  let metricsElu = performance.eventLoopUtilization();
  registry.gauge("dogfight_build_info", "Build version (value is always 1)", () => [
    [{ version: config.version, commit: config.commit, node: process.version }, 1] as const,
  ]);
  registry.gauge("dogfight_up", "1 while serving, 0 while draining", () => (draining ? 0 : 1));
  registry.gauge("process_uptime_seconds", "Process uptime", () => process.uptime());
  registry.gauge("process_resident_memory_bytes", "Resident set size", () => process.memoryUsage().rss);
  registry.gauge("nodejs_heap_used_bytes", "V8 heap used", () => process.memoryUsage().heapUsed);
  registry.gauge("nodejs_eventloop_utilization", "Event-loop busy share since the previous scrape (0..1)", () => {
    const elu = performance.eventLoopUtilization(metricsElu);
    metricsElu = performance.eventLoopUtilization();
    return elu.utilization;
  });
  registry.gauge("dogfight_rooms", "Rooms in the lobby", () => rooms.list().length);

  const startedAt = Date.now();
  // Event-loop utilization since the previous /api/stats call (0..1): the
  // share of time the loop was busy, the best single "how loaded" number.
  let eluMark = performance.eventLoopUtilization();
  const realDistRoot = await realpath(config.clientDist).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayload, perMessageDeflate: false });
  wss.on("error", (error) => logger.error({ err: error }, "websocket server error"));
  const wsHandlers = attachWebSocketHandlers(wss, rooms, config, logger, registry);

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const { pathname } = url;
    // Liveness: the process answers. A failure here means "restart me".
    if (request.method === "GET" && pathname === "/health")
      return sendJson(response, 200, {
        ok: true,
        version: config.version,
        commit: config.commit,
        uptimeSeconds: process.uptime(),
        rooms: rooms.list().length,
      });
    // Readiness: send me players. Off while draining or without a client build.
    if (request.method === "GET" && pathname === "/ready") {
      const ready = !draining && realDistRoot !== null;
      return sendJson(response, ready ? 200 : 503, { ready, draining, clientBuild: realDistRoot !== null });
    }
    if (request.method === "GET" && pathname === "/metrics") {
      if (config.metricsToken && request.headers.authorization !== `Bearer ${config.metricsToken}`)
        throw new HttpError(401, "Metrics need a bearer token");
      const body = registry.render();
      response.writeHead(200, {
        "content-type": "text/plain; version=0.0.4; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
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
    if (request.method === "GET" && pathname === "/api/stats") {
      const elu = performance.eventLoopUtilization(eluMark);
      eluMark = performance.eventLoopUtilization();
      return sendJson(response, 200, {
        uptimeSeconds: (Date.now() - startedAt) / 1000,
        memory: process.memoryUsage(),
        eventLoopUtilization: elu.utilization,
        ...wsHandlers.stats(),
      });
    }
    if (request.method === "POST" && pathname === "/api/rooms") {
      const body = check(CreateRoomRequestSchema, await readJson(request, config.maxPayload));
      if (!body.ok) throw new HttpError(400, body.error.message);
      let created: RoomInfo;
      try {
        created = rooms.create(body.value).info();
        roomsCreated.inc();
      } catch (error: unknown) {
        if (error instanceof TypeError || error instanceof RangeError) throw new HttpError(409, error.message);
        throw error;
      }
      return sendJson(response, 201, created);
    }
    const botsRoute = /^\/api\/rooms\/([a-z0-9-]+)\/bots$/.exec(pathname);
    if (botsRoute?.[1]) {
      const roomId = botsRoute[1];
      if (!rooms.get(roomId)) throw new HttpError(404, "Room does not exist");
      if (request.method === "DELETE") return sendJson(response, 200, { room: roomId, removed: wsHandlers.removeBots(roomId) });
      if (request.method !== "POST") throw new HttpError(405, "Method not allowed");
      const body = check(AddBotsSchema, await readJson(request, config.maxPayload));
      if (!body.ok) throw new HttpError(400, body.error.message);
      return sendJson(response, 201, { room: roomId, added: wsHandlers.addBots(roomId, body.value.count) });
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
    response.once("finish", () => httpRequests.inc({ code: `${Math.floor(response.statusCode / 100)}xx` }));
    route(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof HttpError ? error.status : errorCode(error) === "ENOENT" ? 404 : 500;
      if (status === 500) logger.error({ err: error, method: request.method, url: request.url }, "http request failed");
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
    const ip = clientIp(request, config.trustProxy);
    const refuse = (status: number, reason: string, metric: string) => {
      rejected.inc({ reason: metric });
      logger.warn({ ip, origin: request.headers.origin, reason: metric }, "websocket upgrade refused");
      reject(socket, status, reason);
    };
    if (draining) return refuse(503, "Service Unavailable", "draining");
    if (!originAllowed(request, config.allowedOrigins)) return refuse(403, "Forbidden", "origin");
    if (wss.clients.size >= config.maxConnections) return refuse(503, "Service Unavailable", "server-full");
    const open = connectionsByIp.get(ip) ?? 0;
    if (open >= config.maxConnectionsPerIp) return refuse(429, "Too Many Requests", "ip-limit");

    // Counted from the upgrade on, so a burst of handshakes cannot slip past the cap.
    connectionsByIp.set(ip, open + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (connectionsByIp.get(ip) ?? 1) - 1;
      if (left > 0) connectionsByIp.set(ip, left);
      else connectionsByIp.delete(ip);
    };
    socket.once("close", release);
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      webSocket.once("close", release);
      wss.emit("connection", webSocket, request, ip);
    });
  });

  let closed = false;
  return {
    server,
    wss,
    rooms,
    registry,
    drain() {
      draining = true;
    },
    async close() {
      if (closed) return;
      closed = true;
      draining = true;
      rooms.dispose();
      const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
      for (const socket of wss.clients) {
        if (socket.readyState === WebSocket.OPEN) socket.close(1001, "Server shutting down");
        else socket.terminate();
      }
      wsHandlers.close();
      await new Promise<void>((resolveClose) => wss.close(() => resolveClose()));
      // Keep-alive HTTP connections would hold server.close() open until they time out.
      server.closeIdleConnections();
      await serverClosed;
      await logStore.close();
    },
  };
}
