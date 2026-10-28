import { Bus } from "@dogfight/shared/bus.ts";
import { spanEnd, spanStart } from "./perf.ts";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import type { Codec, Payload } from "@dogfight/shared/codec/codec.ts";
import { jsonCodec } from "@dogfight/shared/codec/json.ts";
import {
  type ChatBroadcast,
  type ClientMessage,
  type CodecName,
  type InputFrame,
  type JoinedMessage,
  type NetSim,
  type PongMessage,
  type Result,
  type RosterMessage,
  type ServerMessage,
  type StateMessage,
  assertNever,
  encodeJson,
  fail,
  ok,
  parseJson,
  parseServerMessage,
} from "@dogfight/shared/protocol.ts";

const MAX_QUEUED_MESSAGES = 100;
const CODECS = { json: jsonCodec, binary: binaryCodec } satisfies Record<CodecName, Codec>;
const textEncoder = new TextEncoder();
const sizeOf = (data: string | ArrayBuffer | Uint8Array) =>
  typeof data === "string" ? textEncoder.encode(data).byteLength : data.byteLength;

export class ServerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ServerError";
    this.code = code;
  }
}

export type ConnectionEvents = {
  joined: JoinedMessage;
  roster: RosterMessage;
  chat: ChatBroadcast;
  state: StateMessage;
  pong: PongMessage;
  netsim: NetSim;
  error: Error;
  open: undefined;
  close: { code: number; reason: string };
  reconnecting: { attempt: number; delay: number };
  connectionError: Error;
};

type Queued = Extract<ClientMessage, { type: "chat" | "netsim" }>;

// join/chat/netsim are always JSON text frames; input/ping go out in the
// codec chosen at join, and state/pong come back in it.
export class GameConnection {
  readonly events = new Bus<ConnectionEvents>();
  readonly url: string;
  readonly codec: Codec;
  bytesIn = 0;
  bytesOut = 0;
  readonly #WebSocketCtor: typeof WebSocket;
  readonly #maxReconnectAttempts: number;
  readonly #joinTimeoutMs: number;
  #socket: WebSocket | null = null;
  #queue: Queued[] = [];
  #closed = false;
  #attempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #joinPayload: ClientMessage | null = null;
  #joinResolve: ((message: JoinedMessage) => void) | null = null;
  #joinReject: ((error: Error) => void) | null = null;
  #joinTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor({
    url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    query = "",
    codec = "binary",
    WebSocketCtor = WebSocket,
    maxReconnectAttempts = 8,
    joinTimeoutMs = 15000,
  }: {
    url?: string;
    query?: string;
    codec?: CodecName;
    WebSocketCtor?: typeof WebSocket;
    maxReconnectAttempts?: number;
    joinTimeoutMs?: number;
  } = {}) {
    this.url = `${url}${query}`;
    this.codec = CODECS[codec];
    this.#WebSocketCtor = WebSocketCtor;
    this.#maxReconnectAttempts = maxReconnectAttempts;
    this.#joinTimeoutMs = joinTimeoutMs;
  }

  get open(): boolean {
    return this.#socket?.readyState === this.#WebSocketCtor.OPEN;
  }

  connect({ room, name }: { room: string; name: string }): Promise<JoinedMessage> {
    if (this.#joinPayload) return Promise.reject(new Error("Connection has already started"));
    this.#joinPayload = { type: "join", room, name, codec: this.codec.name };
    const joined = new Promise<JoinedMessage>((resolve, reject) => {
      this.#joinResolve = resolve;
      this.#joinReject = reject;
    });
    this.#joinTimeout = setTimeout(() => {
      this.#joinReject?.(new Error("Timed out joining the room"));
      this.close();
    }, this.#joinTimeoutMs);
    this.#open();
    return joined;
  }

  sendChat(text: string): boolean {
    return this.#sendReliable({ type: "chat", text });
  }

  sendNetSim(conditions: NetSim): boolean {
    return this.#sendReliable({ type: "netsim", ...conditions });
  }

  // Inputs and pings are real-time: never queued while disconnected.
  sendInputs(inputs: readonly InputFrame[]): boolean {
    return this.open && this.#write(this.codec.encode({ type: "input", inputs }));
  }

  sendPing(t: number): boolean {
    return this.open && this.#write(this.codec.encode({ type: "ping", t }));
  }

  #sendReliable(message: Queued): boolean {
    if (this.#closed) return false;
    if (this.open) return this.#write(encodeJson(message));
    if (this.#queue.length >= MAX_QUEUED_MESSAGES) {
      this.events.emit("error", new Error("Outgoing message queue is full"));
      return false;
    }
    this.#queue.push(message);
    return true;
  }

  #write(payload: Payload): boolean {
    if (!this.#socket) return false;
    this.bytesOut += sizeOf(payload);
    this.#socket.send(payload);
    return true;
  }

  #decode(data: unknown): Result<ServerMessage> {
    if (typeof data === "string") {
      const json = parseJson(data);
      return json.ok ? parseServerMessage(json.value) : json;
    }
    if (!(data instanceof ArrayBuffer)) return fail("invalid-message", "Unexpected frame type");
    const decoded = binaryCodec.decode(data);
    if (!decoded.ok) return decoded;
    const message = decoded.value;
    return message.type === "state" || message.type === "pong" ? ok(message) : fail("unknown-type", `Unexpected ${message.type}`);
  }

  #dispatch(message: ServerMessage): void {
    switch (message.type) {
      case "joined":
        if (this.#joinTimeout) clearTimeout(this.#joinTimeout);
        this.#joinTimeout = null;
        this.#joinResolve?.(message);
        this.#joinResolve = null;
        this.#joinReject = null;
        return this.events.emit("joined", message);
      case "error": {
        const error = new ServerError(message.code, message.message);
        this.events.emit("error", error);
        if (this.#joinReject) {
          if (this.#joinTimeout) clearTimeout(this.#joinTimeout);
          this.#joinTimeout = null;
          this.#joinReject(error);
          this.#joinReject = null;
          this.#joinResolve = null;
        }
        return;
      }
      case "roster":
        return this.events.emit("roster", message);
      case "chat":
        return this.events.emit("chat", message);
      case "state":
        return this.events.emit("state", message);
      case "pong":
        return this.events.emit("pong", message);
      case "netsim":
        return this.events.emit("netsim", { lag: message.lag, jitter: message.jitter, drop: message.drop });
      default:
        return assertNever(message, "server message");
    }
  }

  #open(): void {
    if (this.#closed) return;
    let socket: WebSocket;
    try {
      socket = new this.#WebSocketCtor(this.url);
    } catch (error: unknown) {
      this.#scheduleReconnect(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket || this.#closed || !this.#joinPayload) return;
      this.#attempt = 0;
      this.#write(encodeJson(this.#joinPayload));
      for (const message of this.#queue.splice(0)) this.#write(encodeJson(message));
      this.events.emit("open", undefined);
    });
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (this.#socket !== socket) return;
      const { data } = event;
      if (typeof data === "string" || data instanceof ArrayBuffer) this.bytesIn += sizeOf(data);
      spanStart("decode");
      const decoded = this.#decode(data);
      spanEnd("decode");
      if (!decoded.ok) {
        this.events.emit("error", new ServerError(decoded.error.code, `Server sent an invalid message: ${decoded.error.message}`));
        return;
      }
      this.#dispatch(decoded.value);
    });
    socket.addEventListener("error", () => this.events.emit("connectionError", new Error("WebSocket connection failed")));
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.events.emit("close", { code: event.code, reason: event.reason });
      if (!this.#closed) this.#scheduleReconnect(new Error("WebSocket connection closed"));
    });
  }

  #scheduleReconnect(error: Error): void {
    if (this.#closed) return;
    if (this.#attempt >= this.#maxReconnectAttempts) {
      this.#joinReject?.(error);
      this.#joinResolve = null;
      this.#joinReject = null;
      if (this.#joinTimeout) clearTimeout(this.#joinTimeout);
      this.#joinTimeout = null;
      this.events.emit("error", new Error("Could not reconnect to the game server", { cause: error }));
      return;
    }
    const delay = Math.min(500 * 2 ** this.#attempt, 10_000) * (0.75 + Math.random() * 0.5);
    this.#attempt++;
    this.events.emit("reconnecting", { attempt: this.#attempt, delay });
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  close(): void {
    this.#closed = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#joinTimeout) clearTimeout(this.#joinTimeout);
    this.#reconnectTimer = null;
    this.#joinTimeout = null;
    this.#joinReject?.(new Error("Connection closed"));
    this.#joinReject = null;
    this.#joinResolve = null;
    if (this.#socket && this.#socket.readyState < this.#WebSocketCtor.CLOSING) this.#socket.close(1000, "Leaving room");
    this.#socket = null;
    this.#queue.length = 0;
    this.events.clear();
  }
}
