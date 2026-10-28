import assert from "node:assert/strict";
import { test } from "vitest";
import { entityId, playerId, seq } from "@dogfight/shared/brand.ts";
import type { BulletSnapshot, ExplosionSnapshot } from "@dogfight/shared/protocol.ts";
import { RenderCache } from "../src/net/render-cache.ts";

const bullet = (id: number, x: number): BulletSnapshot => ({
  id: entityId(id),
  kind: "bullet",
  x,
  y: 10,
  angle: 0,
  vx: 100,
  vy: 0,
  owner: playerId(1),
  seq: seq(1),
  ttl: 1,
  homing: false,
});
const pose = (x: number, age = 0) => ({ x, y: 10, angle: 0, age });

test("the render cache keeps one entity per id across frames and updates it in place", () => {
  const cache = new RenderCache();
  cache.begin();
  const first = cache.place(bullet(1, 5), pose(5), new Map());
  cache.end();
  cache.begin();
  const second = cache.place(bullet(1, 8), pose(8), new Map());
  cache.end();
  assert.equal(second, first, "same object, no new allocation per frame");
  assert.equal(second.pos.x, 8);
  assert.equal(second.prevPos, second.pos, "already interpolated: drawn at alpha 1");
});

test("entities not drawn this frame are evicted; a kind change makes a new entity", () => {
  const cache = new RenderCache();
  cache.begin();
  cache.place(bullet(1, 5), pose(5), new Map());
  cache.place(bullet(2, 5), pose(5), new Map());
  cache.end();
  cache.begin();
  cache.place(bullet(1, 6), pose(6), new Map());
  cache.end();
  assert.equal(cache.size, 1);
  assert.equal(cache.get(entityId(2)), undefined);

  const explosion: ExplosionSnapshot = { id: entityId(1), kind: "explosion", x: 0, y: 0, angle: 0, color: "#ff0000", count: 4, speed: 50, age: 0.1 };
  cache.begin();
  const reused = cache.place(explosion, pose(0, 0.3), new Map());
  cache.end();
  assert.equal(reused.kind, "explosion", "id 1 reused by a different kind: replaced, not mutated");
  if (reused.kind === "explosion") assert.equal(reused.age, 0.3);
});
