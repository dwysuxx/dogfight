import { test } from "node:test";
import assert from "node:assert/strict";

import type { RoomInfo } from "@dogfight/shared/protocol.ts";
import {
  type FetchLike,
  HttpError,
  type RequestInitLike,
  RequiredAssetsError,
  type ResponseLike,
  fetchJson,
  loadAll,
  loadImage,
  withRetry,
} from "../src/assets/loader.ts";
import { Lobby } from "../src/lobby/lobby.ts";

// A typed fake of the slice of Response the loader uses.
function response(status: number, body: unknown = null, { json }: { json?: () => Promise<unknown> } = {}): ResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "Service Unavailable",
    json: json ?? (async () => body),
    blob: async () => new Blob([]),
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

const room = (id: string, name: string): RoomInfo => ({
  id,
  name,
  players: 0,
  capacity: 4,
  arena: { width: 960, height: 540, asteroids: 6 },
});

const signalOf = (init: RequestInitLike | undefined): AbortSignal => {
  assert.ok(init?.signal, "request carries an AbortSignal");
  return init.signal;
};

test("fetchJson rejects HTTP errors and does not retry client errors", async () => {
  let requests = 0;
  const fetchImpl: FetchLike = async () => {
    requests++;
    return response(404);
  };
  await assert.rejects(
    withRetry(() => fetchJson("/missing.json", { fetchImpl }), { attempts: 4, baseMs: 0 }),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  assert.equal(requests, 1);
});

test("fetchJson identifies malformed JSON without retrying it", async () => {
  let requests = 0;
  const fetchImpl: FetchLike = async () => {
    requests++;
    return response(200, null, {
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    });
  };
  await assert.rejects(withRetry(() => fetchJson("/broken.json", { fetchImpl }), { attempts: 3, baseMs: 0 }), /Invalid JSON response/);
  assert.equal(requests, 1);
});

test("loadImage exposes HTTP 4xx status so retry never repeats missing assets", async () => {
  let requests = 0;
  const fetchImpl: FetchLike = async () => {
    requests++;
    return response(404);
  };
  const decode = async (): Promise<never> => {
    throw new Error("never decoded");
  };
  await assert.rejects(
    withRetry(() => loadImage("/missing.svg", { fetchImpl, decode }), { attempts: 4, baseMs: 0 }),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  assert.equal(requests, 1);
});

test("withRetry retries transient server failures with a bounded attempt count", async () => {
  let requests = 0;
  const value = await withRetry(
    async () => {
      requests++;
      if (requests < 3) throw new HttpError(response(503), "/rooms");
      return "ready";
    },
    { attempts: 3, baseMs: 0 },
  );
  assert.equal(value, "ready");
  assert.equal(requests, 3);
});

test("loadAll reports per-resource progress and makes optional sound failures non-fatal", async () => {
  const progress: [number, number, number][] = [];
  const warnings: string[] = [];
  const assets = await loadAll(
    { arena: "/arena.json", sounds: { missing: { url: "/missing.wav" } } },
    {
      onProgress: (ratio, completed, total) => progress.push([ratio, completed, total]),
      onWarning: (key) => warnings.push(key),
      audioContext: null,
      fetchImpl: async () => response(200, { width: 900, height: 500, asteroids: 4 }),
    },
  );
  assert.deepEqual(assets.arena, { width: 900, height: 500, asteroids: 4 });
  assert.equal(assets.sounds["missing"], undefined);
  assert.deepEqual(warnings, ["sound:missing"]);
  assert.deepEqual(progress.at(-1), [1, 2, 2]);
});

test("loadAll fails clearly when a required resource is unavailable or the manifest is malformed", async () => {
  await assert.rejects(
    loadAll({ arena: "/missing.json" }, { fetchImpl: async () => response(404) }),
    (error: unknown) => error instanceof RequiredAssetsError && /Required assets failed: arena/.test(error.message),
  );
  await assert.rejects(loadAll({ sounds: "nope" }), /Invalid asset manifest/);
  await assert.rejects(
    loadAll({ arena: "/arena.json" }, { fetchImpl: async () => response(200, { width: "wide" }) }),
    (error: unknown) => error instanceof RequiredAssetsError,
  );
});

test("Lobby refresh validates rooms, emits a typed event and joins only known rooms", async () => {
  const lobby = new Lobby({ fetchImpl: async () => response(200, { rooms: [room("orbit", "Orbit")] }) });
  let updated: readonly RoomInfo[] = [];
  lobby.events.on("roomsChanged", (rooms) => {
    updated = rooms;
  });
  await lobby.refresh();
  assert.equal(updated[0]?.id, "orbit");
  assert.deepEqual(lobby.join("orbit", "  Ada  "), { room: updated[0], playerName: "Ada" });
  assert.equal(lobby.join("orbit").playerName, "Pilot");
  assert.throws(() => lobby.join("missing", "Pilot"), RangeError);

  const broken = new Lobby({ fetchImpl: async () => response(200, { rooms: [{ id: "orbit" }] }) });
  await assert.rejects(broken.refresh(), /Unexpected rooms response/);
});

test("Lobby polling aborts its in-flight fetch when polling stops", async () => {
  const seen: { signal?: AbortSignal; rejected?: boolean } = {};
  const lobby = new Lobby({
    timeoutMs: 60_000,
    fetchImpl: (_url, init) => {
      const signal = signalOf(init);
      seen.signal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            seen.rejected = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  lobby.startPolling({ intervalMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(seen.signal);
  lobby.stopPolling();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seen.signal.aborted, true);
  assert.equal(seen.rejected, true);
});

test("Lobby polling recovers after its first refresh fails", async () => {
  let requests = 0;
  const lobby = new Lobby({
    fetchImpl: async () => {
      requests++;
      return requests === 1 ? response(503) : response(200, { rooms: [room("recovered", "Recovered")] });
    },
  });
  const refreshed = new Promise<readonly RoomInfo[]>((resolve) => lobby.events.once("roomsChanged", resolve));
  lobby.startPolling({ intervalMs: 1 });
  const rooms = await refreshed;
  lobby.stopPolling();
  assert.ok(requests >= 2);
  assert.equal(rooms[0]?.id, "recovered");
});

test("Lobby requests time out and surface an AbortError", async () => {
  const lobby = new Lobby({
    timeoutMs: 5,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = signalOf(init);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  });
  const keepAlive = setTimeout(() => {}, 20);
  try {
    await assert.rejects(lobby.refresh(), { name: "TimeoutError" });
  } finally {
    clearTimeout(keepAlive);
  }
});
