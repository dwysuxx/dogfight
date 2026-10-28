import * as binaryCodec from "@dogfight/shared/codec/binary.js";
import * as jsonCodec from "@dogfight/shared/codec/json.js";
import { PROTOCOL_VERSION } from "@dogfight/shared/protocol/messages.js";

const MAX_QUEUED_MESSAGES = 100;
const CODECS = { json: jsonCodec, binary: binaryCodec };
const textEncoder = new TextEncoder();
const sizeOf = (data) => (typeof data === "string" ? textEncoder.encode(data).byteLength : data.byteLength);

// join/chat/netsim are always JSON text frames; input/ping go out in the
// codec chosen at join, and state/pong come back in it.
export class GameConnection {
  #socket = null;
  #listeners = new Map();
  #queue = [];
  #closed = false;
  #attempt = 0;
  #reconnectTimer = null;
  #joinPayload = null;
  #joinResolve = null;
  #joinReject = null;
  #joinTimeout = null;

  constructor({
    url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
    query = "",
    codec = "binary",
    WebSocketCtor = WebSocket,
    maxReconnectAttempts = 8,
    joinTimeoutMs = 15000,
  } = {}) {
    this.url = `${url}${query}`;
    this.codec = codec;
    this.WebSocketCtor = WebSocketCtor;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.joinTimeoutMs = joinTimeoutMs;
    this.bytesIn = 0;
    this.bytesOut = 0;
  }

  on(type, listener) {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(type);
    };
  }

  #emit(type, detail) {
    for (const listener of this.#listeners.get(type) ?? []) listener(detail);
  }

  get open() {
    return this.#socket?.readyState === this.WebSocketCtor.OPEN;
  }

  connect({ room, name }) {
    if (this.#joinPayload) return Promise.reject(new Error("Connection has already started"));
    this.#joinPayload = { type: "join", room, name, codec: this.codec };
    const joined = new Promise((resolve, reject) => {
      this.#joinResolve = resolve;
      this.#joinReject = reject;
    });
    this.#joinTimeout = setTimeout(() => {
      this.#joinReject?.(new Error("Timed out joining the room"));
      this.close();
    }, this.joinTimeoutMs);
    this.#open();
    return joined;
  }

  sendChat(text) {
    return this.#send({ type: "chat", text });
  }

  sendNetSim(conditions) {
    return this.#send({ type: "netsim", ...conditions });
  }

  // Inputs and pings are real-time: never queued while disconnected.
  sendInputs(inputs) {
    return this.open && this.#write(CODECS[this.codec].encode({ type: "input", inputs }));
  }

  sendPing(t) {
    return this.open && this.#write(CODECS[this.codec].encode({ type: "ping", t }));
  }

  #send(message) {
    if (this.#closed) return false;
    if (this.open) return this.#write(jsonCodec.encode(message));
    if (this.#queue.length >= MAX_QUEUED_MESSAGES) {
      this.#emit("error", new Error("Outgoing message queue is full"));
      return false;
    }
    this.#queue.push(message);
    return true;
  }

  #write(payload) {
    this.bytesOut += sizeOf(payload);
    this.#socket.send(payload);
    return true;
  }

  #decode(data) {
    if (typeof data === "string") return jsonCodec.decode(data);
    return binaryCodec.decode(data);
  }

  #open() {
    if (this.#closed) return;
    let socket;
    try {
      socket = new this.WebSocketCtor(this.url);
    } catch (error) {
      this.#scheduleReconnect(error);
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket || this.#closed) return;
      this.#attempt = 0;
      this.#write(jsonCodec.encode(this.#joinPayload));
      for (const message of this.#queue.splice(0)) this.#write(jsonCodec.encode(message));
      this.#emit("open");
    });
    socket.addEventListener("message", (event) => {
      if (this.#socket !== socket) return;
      this.bytesIn += sizeOf(event.data);
      let message;
      try {
        message = this.#decode(event.data);
      } catch (error) {
        this.#emit("error", new Error(`Server sent an unsupported message (protocol v${PROTOCOL_VERSION})`, { cause: error }));
        return;
      }
      if (message.type === "joined") {
        clearTimeout(this.#joinTimeout);
        this.#joinTimeout = null;
        this.#joinResolve?.(message);
        this.#joinResolve = null;
        this.#joinReject = null;
      }
      if (message.type === "error") {
        const error = new Error(message.message);
        error.code = message.code;
        this.#emit("error", error);
        if (this.#joinReject) {
          clearTimeout(this.#joinTimeout);
          this.#joinTimeout = null;
          this.#joinReject(error);
          this.#joinReject = null;
          this.#joinResolve = null;
        }
      }
      this.#emit(message.type, message);
      this.#emit("message", message);
    });
    socket.addEventListener("error", () => {
      this.#emit("connectionError", new Error("WebSocket connection failed"));
    });
    socket.addEventListener("close", (event) => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#emit("close", event);
      if (!this.#closed) this.#scheduleReconnect(new Error("WebSocket connection closed"));
    });
  }

  #scheduleReconnect(error) {
    if (this.#closed) return;
    if (this.#attempt >= this.maxReconnectAttempts) {
      this.#joinReject?.(error);
      this.#joinResolve = null;
      this.#joinReject = null;
      clearTimeout(this.#joinTimeout);
      this.#joinTimeout = null;
      this.#emit("error", new Error("Could not reconnect to the game server", { cause: error }));
      return;
    }
    const delay = Math.min(500 * 2 ** this.#attempt, 10_000) * (0.75 + Math.random() * 0.5);
    this.#attempt++;
    this.#emit("reconnecting", { attempt: this.#attempt, delay });
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }

  close() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#joinTimeout);
    this.#reconnectTimer = null;
    this.#joinTimeout = null;
    this.#joinReject?.(new Error("Connection closed"));
    this.#joinReject = null;
    this.#joinResolve = null;
    if (this.#socket && this.#socket.readyState < this.WebSocketCtor.CLOSING)
      this.#socket.close(1000, "Leaving room");
    this.#socket = null;
    this.#queue.length = 0;
  }
}
