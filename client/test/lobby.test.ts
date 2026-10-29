import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { Lobby } from "../src/lobby/lobby.ts";

afterEach(() => vi.unstubAllGlobals());

const room = { id: "abc123", name: "Mine", players: 0, capacity: 16, arena: { width: 960, height: 540, asteroids: 6 } };

// Regression: the default fetch was stored on the Lobby and called as
// `this.fetchImpl(...)`; browsers reject a fetch whose `this` is not the
// window ("Illegal invocation"), so creating a room always failed.
test("Lobby's default fetch keeps working when called through the instance", async () => {
  vi.stubGlobal(
    "fetch",
    function (this: unknown, _url: string, init?: { method?: string }) {
      if (this !== undefined && this !== globalThis) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      const body = init?.method === "POST" ? room : { rooms: [room] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: init?.method === "POST" ? 201 : 200 }));
    },
  );
  const lobby = new Lobby();
  const created = await lobby.createRoom("Mine");
  assert.equal(created.id, "abc123");
  assert.deepEqual(lobby.rooms.map(({ id }) => id), ["abc123"]);
});
