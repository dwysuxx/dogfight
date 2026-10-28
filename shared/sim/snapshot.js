// World <-> plain data. The server snapshots with snapshotEntities; the client
// rebuilds real entity instances with entityFromSnapshot (for prediction and
// for drawing). hashWorld is the determinism probe: same seed + same inputs
// must give the same hash in Node and in every browser.
import { Asteroid } from "./asteroid.js";
import { Bullet } from "./bullet.js";
import { Explosion } from "./explosion.js";
import { Pickup } from "./pickup.js";
import { Ship } from "./ship.js";

const FROM_SNAPSHOT = {
  ship: (data, context) => Ship.fromSnapshot(data, context),
  bullet: (data, context) => Bullet.fromSnapshot(data, context),
  asteroid: (data) => Asteroid.fromSnapshot(data),
  pickup: (data) => Pickup.fromSnapshot(data),
  explosion: (data) => Explosion.fromSnapshot(data),
};

export function entityFromSnapshot(data, context = {}) {
  const create = FROM_SNAPSHOT[data.kind];
  if (!create) throw new TypeError(`Unknown entity kind ${data.kind}`);
  return create(data, context);
}

export function snapshotEntities(world) {
  const entities = [];
  for (const entity of world) if (entity.alive) entities.push(entity.toSnapshot());
  return entities;
}

// FNV-1a over the exact float bits of every entity's state. Exact bits, not
// toFixed(): a difference in the 15th digit is still a determinism bug.
export function hashWorld(world) {
  // DataView with explicit little-endian, so the hash is the same on any CPU.
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  let hash = 0x811c9dc5;
  const mix = (value) => {
    view.setFloat64(0, value, true);
    for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  };
  for (const e of world) {
    if (!e.alive) continue;
    for (const value of [Number(e.id) || 0, e.pos.x, e.pos.y, e.vel.x, e.vel.y, e.angle]) mix(value);
    if (e.kind === "ship") for (const value of [e.hp, e.score, e.fireCooldown]) mix(value);
  }
  mix(world.tick);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
