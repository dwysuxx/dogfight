// World <-> plain data. The server snapshots with snapshotEntities; the client
// rebuilds real entity instances with entityFromSnapshot (for prediction and
// for drawing). hashWorld is the determinism probe: same seed + same inputs
// must give the same hash in Node and in every browser.
import { type EntitySnapshot, assertNever } from "../protocol.ts";
import { Asteroid } from "./asteroid.ts";
import { Bullet } from "./bullet.ts";
import { Explosion } from "./explosion.ts";
import { Pickup } from "./pickup.ts";
import { type PlayerLookup, Ship } from "./ship.ts";
import type { GameEntity, World } from "./world.ts";

export function entityFromSnapshot(data: EntitySnapshot, { players }: { players?: PlayerLookup } = {}): GameEntity {
  switch (data.kind) {
    case "ship":
      return Ship.fromSnapshot(data, { players });
    case "bullet":
      return Bullet.fromSnapshot(data);
    case "asteroid":
      return Asteroid.fromSnapshot(data);
    case "pickup":
      return Pickup.fromSnapshot(data);
    case "explosion":
      return Explosion.fromSnapshot(data);
    default:
      return assertNever(data, "entity kind");
  }
}

export function snapshotEntities(world: World): EntitySnapshot[] {
  const entities: EntitySnapshot[] = [];
  const all = world.all;
  for (let i = 0; i < all.length; i++) {
    const entity = all[i];
    if (entity?.alive) entities.push(entity.toSnapshot());
  }
  return entities;
}

// FNV-1a over the exact float bits of every entity's state. Exact bits, not
// toFixed(): a difference in the 15th digit is still a determinism bug.
export function hashWorld(world: World): string {
  // DataView with explicit little-endian, so the hash is the same on any CPU.
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    view.setFloat64(0, value, true);
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  };
  for (const e of world) {
    if (!e.alive) continue;
    for (const value of [e.id, e.pos.x, e.pos.y, e.vel.x, e.vel.y, e.angle]) mix(value);
    if (e.kind === "ship") for (const value of [e.hp, e.score, e.fireCooldown]) mix(value);
  }
  mix(world.tick);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
