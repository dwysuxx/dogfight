// The collision SYSTEM: takes the world, reports (a, b) pairs to a visitor.
// It knows nothing about damage or scoring (that is rules.ts), so it can be
// swapped for a spatial hash later — World only needs "world + visitor".
// Naive O(n^2): at ~40 bodies it is not where the tick time goes (see the
// README's profile), so no spatial hash yet.
//
// Lab 7: a visitor instead of a generator. A generator allocates an
// iterator-result object per pair and per step; this allocates nothing.
import type { GameEntity, World } from "./world.ts";

export type CollisionPair = readonly [GameEntity, GameEntity];
export type PairVisitor = (a: GameEntity, b: GameEntity) => void;
export type CollisionSystem = (world: World, visit: PairVisitor) => void;

const bodies: GameEntity[] = []; // scratch, reused every call

export function findCollisions(world: World, visit: PairVisitor): void {
  bodies.length = 0;
  const all = world.all;
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e && e.alive && e.collides) bodies.push(e);
  }
  const n = bodies.length;
  for (let i = 0; i < n; i++) {
    const a = bodies[i];
    if (!a) continue;
    for (let j = i + 1; j < n; j++) {
      const b = bodies[j];
      if (!b) continue;
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const r = a.radius + b.radius;
      if (dx * dx + dy * dy <= r * r) visit(a, b);
    }
  }
  bodies.length = 0;
}

// Convenience for tests and tools: every pair as an array.
export function collisionPairs(world: World, system: CollisionSystem = findCollisions): CollisionPair[] {
  const pairs: CollisionPair[] = [];
  system(world, (a, b) => pairs.push([a, b]));
  return pairs;
}
