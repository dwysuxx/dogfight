import { Bus } from "@dogfight/shared/bus.ts";
import {
  type Arena,
  type RoomInfo,
  RoomInfoSchema,
  RoomsResponseSchema,
  check,
} from "@dogfight/shared/protocol.ts";
import { type FetchLike, fetchJson } from "../assets/loader.ts";

export interface JoinSelection {
  readonly room: RoomInfo;
  readonly playerName: string;
}

export type LobbyEvents = {
  roomsChanged: readonly RoomInfo[];
  roomCreated: RoomInfo;
  joined: JoinSelection;
  refreshError: unknown;
};

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Lobby {
  readonly events = new Bus<LobbyEvents>();
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly fetchImpl: FetchLike;
  rooms: readonly RoomInfo[] = [];
  #pollController: AbortController | null = null;
  #removeExternalAbort: (() => void) | null = null;

  constructor({
    endpoint = "/api/rooms",
    timeoutMs = 5000,
    // Not `fetch` itself: stored on the instance, `this.fetchImpl(...)` would
    // call it with `this === lobby` and the browser throws "Illegal invocation".
    fetchImpl = (input, init) => fetch(input, init),
  }: { endpoint?: string; timeoutMs?: number; fetchImpl?: FetchLike } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async refresh({ signal }: { signal?: AbortSignal } = {}): Promise<readonly RoomInfo[]> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const result = check(RoomsResponseSchema, await fetchJson(this.endpoint, { signal: requestSignal, fetchImpl: this.fetchImpl }));
    if (!result.ok) throw new TypeError(`Unexpected rooms response: ${result.error.message}`);
    this.rooms = result.value.rooms;
    this.events.emit("roomsChanged", this.rooms);
    return this.rooms;
  }

  async createRoom(name: string, arena?: Arena, { signal }: { signal?: AbortSignal } = {}): Promise<RoomInfo> {
    if (!name.trim()) throw new TypeError("Room name is required");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), ...(arena ? { arena } : {}) }),
      signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = payload && typeof payload === "object" && "error" in payload ? String(payload.error) : null;
      throw new Error(message ?? `Could not create room (${response.status})`);
    }
    const room = check(RoomInfoSchema, payload);
    if (!room.ok) throw new TypeError(`Unexpected room: ${room.error.message}`);
    await this.refresh(signal ? { signal } : {});
    this.events.emit("roomCreated", room.value);
    return room.value;
  }

  join(roomId: string, playerName = "Pilot"): JoinSelection {
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new RangeError(`Unknown room: ${roomId}`);
    const joined = { room, playerName: playerName.trim() || "Pilot" };
    this.events.emit("joined", joined);
    return joined;
  }

  startPolling({ intervalMs = 5000, signal }: { intervalMs?: number; signal?: AbortSignal } = {}): () => void {
    this.stopPolling();
    const controller = new AbortController();
    this.#pollController = controller;
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else {
        const abort = () => controller.abort(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        this.#removeExternalAbort = () => signal.removeEventListener("abort", abort);
      }
    }
    void this.#poll(controller.signal, intervalMs).catch((error: unknown) => {
      if (!controller.signal.aborted) this.events.emit("refreshError", error);
    });
    return () => {
      if (this.#pollController === controller) this.stopPolling();
    };
  }

  stopPolling(): void {
    this.#pollController?.abort();
    this.#pollController = null;
    this.#removeExternalAbort?.();
    this.#removeExternalAbort = null;
  }

  async #poll(signal: AbortSignal, intervalMs: number): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.refresh({ signal });
      } catch (error: unknown) {
        if (signal.aborted) return;
        this.events.emit("refreshError", error);
      }
      try {
        await wait(intervalMs, signal);
      } catch (error: unknown) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }
}
