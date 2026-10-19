import { fetchJson } from "../assets/loader.js";

function makeEvent(type, detail) {
  return new CustomEvent(type, { detail });
}

function abortError(signal) {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function wait(ms, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Lobby extends EventTarget {
  #pollController = null;
  #removeExternalAbort = null;

  constructor({ endpoint = "/api/rooms", timeoutMs = 5000, fetchImpl = fetch } = {}) {
    super();
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.rooms = [];
  }

  async refresh({ signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const result = await fetchJson(this.endpoint, {
      signal: requestSignal,
      fetchImpl: this.fetchImpl,
    });
    const rooms = Array.isArray(result) ? result : result.rooms;
    if (!Array.isArray(rooms)) throw new TypeError("Lobby response must contain a rooms array");
    this.rooms = rooms;
    this.dispatchEvent(makeEvent("roomsChanged", rooms));
    return rooms;
  }

  async createRoom(name, arena, { signal } = {}) {
    if (typeof name !== "string" || !name.trim())
      throw new TypeError("Room name is required");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), ...(arena ? { arena } : {}) }),
      signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? `Could not create room (${response.status})`);
    }
    const room = await response.json();
    await this.refresh({ signal });
    this.dispatchEvent(makeEvent("roomCreated", room));
    return room;
  }

  join(roomId, playerName = "Pilot") {
    const room = this.rooms.find((candidate) => candidate.id === roomId);
    if (!room) throw new RangeError(`Unknown room: ${roomId}`);
    if (typeof playerName !== "string")
      throw new TypeError("Player name must be a string");
    const joined = { room, playerName: playerName.trim() || "Pilot" };
    this.dispatchEvent(makeEvent("joined", joined));
    return joined;
  }

  startPolling({ intervalMs = 5000, signal } = {}) {
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
    void this.#poll(controller.signal, intervalMs).catch((error) => {
      if (!controller.signal.aborted)
        this.dispatchEvent(makeEvent("refreshError", error));
    });
    return () => {
      if (this.#pollController === controller) this.stopPolling();
    };
  }

  stopPolling() {
    this.#pollController?.abort();
    this.#pollController = null;
    this.#removeExternalAbort?.();
    this.#removeExternalAbort = null;
  }

  async #poll(signal, intervalMs) {
    while (!signal.aborted) {
      try {
        await this.refresh({ signal });
      } catch (error) {
        if (signal.aborted) return;
        this.dispatchEvent(makeEvent("refreshError", error));
      }
      try {
        await wait(intervalMs, signal);
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
    }
  }
}
