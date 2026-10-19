import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchJson,
  HttpError,
  loadAll,
  loadImage,
  withRetry,
} from "../src/assets/loader.js";
import { Lobby } from "../src/lobby/lobby.js";

const response = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? "Not Found" : "Service Unavailable",
  json: async () => body,
});

test("fetchJson rejects HTTP errors and does not retry client errors", async () => {
  let requests = 0;
  await assert.rejects(
    withRetry(
      () =>
        fetchJson("/missing.json", {
          fetchImpl: async () => {
            requests++;
            return response(404);
          },
        }),
      { attempts: 4, baseMs: 0 },
    ),
    (error) => error instanceof HttpError && error.status === 404,
  );
  assert.equal(requests, 1);
});

test("fetchJson identifies malformed JSON without retrying it", async () => {
  let requests = 0;
  await assert.rejects(
    withRetry(
      () =>
        fetchJson("/broken.json", {
          fetchImpl: async () => {
            requests++;
            return { ok: true, json: async () => { throw new SyntaxError("Unexpected token"); } };
          },
        }),
      { attempts: 3, baseMs: 0 },
    ),
    /Invalid JSON response/,
  );
  assert.equal(requests, 1);
});

test("loadImage exposes HTTP 4xx status so retry never repeats missing assets", async () => {
  let requests = 0;
  await assert.rejects(
    withRetry(
      () =>
        loadImage("/missing.svg", {
          fetchImpl: async () => {
            requests++;
            return response(404);
          },
          ImageCtor: class {},
        }),
      { attempts: 4, baseMs: 0 },
    ),
    (error) => error instanceof HttpError && error.status === 404,
  );
  assert.equal(requests, 1);
});

test("withRetry retries transient server failures with a bounded attempt count", async () => {
  let requests = 0;
  const value = await withRetry(async () => {
    requests++;
    if (requests < 3) throw new HttpError(response(503), "/rooms");
    return "ready";
  }, { attempts: 3, baseMs: 0 });
  assert.equal(value, "ready");
  assert.equal(requests, 3);
});

test("loadAll reports per-resource progress and makes optional sound failures non-fatal", async () => {
  const progress = [];
  const warnings = [];
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
  assert.equal(assets.sounds.missing, undefined);
  assert.deepEqual(warnings, ["sound:missing"]);
  assert.deepEqual(progress.at(-1), [1, 2, 2]);
});

test("loadAll fails clearly when a required resource is unavailable", async () => {
  await assert.rejects(
    loadAll(
      { arena: "/missing.json" },
      { fetchImpl: async () => response(404) },
    ),
    (error) => error instanceof AggregateError && /Required assets failed: arena/.test(error.message),
  );
});

test("Lobby refresh dispatches rooms and joins only known rooms", async () => {
  const lobby = new Lobby({
    fetchImpl: async () => response(200, { rooms: [{ id: "orbit", name: "Orbit" }] }),
  });
  let updatedRooms;
  lobby.addEventListener("roomsChanged", (event) => {
    updatedRooms = event.detail;
  });
  await lobby.refresh();
  assert.equal(updatedRooms[0].id, "orbit");
  assert.deepEqual(lobby.join("orbit", "  Ada  "), {
    room: updatedRooms[0],
    playerName: "Ada",
  });
  assert.equal(lobby.join("orbit").playerName, "Pilot");
  assert.throws(() => lobby.join("missing", "Pilot"), RangeError);
});

test("Lobby polling aborts its in-flight fetch when polling stops", async () => {
  let requestSignal;
  let requestRejected = false;
  const lobby = new Lobby({
    timeoutMs: 60_000,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            requestRejected = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
  });
  lobby.startPolling({ intervalMs: 60_000 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(requestSignal);
  lobby.stopPolling();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestRejected, true);
});

test("Lobby polling recovers after its first refresh fails", async () => {
  let requests = 0;
  const lobby = new Lobby({
    fetchImpl: async () => {
      requests++;
      return requests === 1
        ? response(503)
        : response(200, { rooms: [{ id: "recovered", name: "Recovered" }] });
    },
  });
  const refreshed = new Promise((resolve) =>
    lobby.addEventListener("roomsChanged", (event) => resolve(event.detail), { once: true }),
  );
  lobby.startPolling({ intervalMs: 1 });
  const rooms = await refreshed;
  lobby.stopPolling();
  assert.ok(requests >= 2);
  assert.equal(rooms[0].id, "recovered");
});

test("Lobby requests time out and surface an AbortError", async () => {
  const lobby = new Lobby({
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
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
