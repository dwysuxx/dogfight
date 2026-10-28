// The collision SYSTEM: takes the world, emits (a, b) pairs. It knows nothing
// about damage or scoring (that is rules.ts), so it can be swapped for a
// spatial hash later — World only needs "a function world -> iterable of pairs".
// Naive O(n^2); Lab 7 measures it.
import type { GameEntity, World } from "./world.ts";

export type CollisionPair = readonly [GameEntity, GameEntity];
export type CollisionSystem = (world: World) => Iterable<CollisionPair>;

export function* findCollisions(world: World): Generator<CollisionPair> {
  const bodies: GameEntity[] = [];
  for (const e of world) if (e.alive && e.collides) bodies.push(e);

  for (const [i, a] of bodies.entries()) {
    for (const b of bodies.slice(i + 1)) {
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const r = a.radius + b.radius;
      if (dx * dx + dy * dy <= r * r) yield [a, b];
    }
  }
}
