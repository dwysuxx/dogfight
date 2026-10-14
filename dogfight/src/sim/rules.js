// What happens when two things touch: damage, pickups, score, respawn.
import { Vector2 } from "./vector.js";
import { Explosion } from "./explosion.js";

const POINTS = { asteroid: 10, ship: 50 };
const CONTACT_DAMAGE = 20;
const RESPAWN_DELAY = 2; // seconds

// A table keyed by "kindA:kindB" instead of an if/else tree.
const handlers = {
  "bullet:asteroid"(bullet, asteroid, world) {
    bullet.alive = false;
    if (asteroid.takeDamage(bullet.damage)) {
      asteroid.alive = false;
      world.spawn(
        new Explosion({
          pos: asteroid.pos,
          rng: world.rng,
          count: 14 + asteroid.radius,
          speed: 120,
          color: "#c9b79c",
        }),
      );
      if (bullet.owner) bullet.owner.score += POINTS.asteroid;
    }
  },

  "bullet:ship"(bullet, ship, world) {
    if (bullet.owner === ship) return; // never hit yourself
    bullet.alive = false;
    if (ship.takeDamage(bullet.damage)) destroyShip(world, ship, bullet.owner);
  },

  "asteroid:ship"(asteroid, ship, world) {
    const away = ship.pos.sub(asteroid.pos);
    const dist = away.length() || 1;
    const normal = away.scale(1 / dist);
    const overlap = asteroid.radius + ship.radius - dist;
    if (overlap > 0) ship.shift(normal.scale(overlap)); // push out, don't stick

    if (ship.contactCooldown <= 0) {
      ship.contactCooldown = 0.8;
      ship.vel = ship.vel.add(normal.scale(140));
      if (ship.takeDamage(CONTACT_DAMAGE)) destroyShip(world, ship, null);
    }
  },

  "pickup:ship"(pickup, ship) {
    pickup.apply(ship);
    pickup.alive = false;
  },
};

export function resolveCollision(a, b, world) {
  const direct = handlers[`${a.kind}:${b.kind}`];
  if (direct) return direct(a, b, world);
  const swapped = handlers[`${b.kind}:${a.kind}`];
  if (swapped) return swapped(b, a, world);
}

export function destroyShip(world, ship, killer) {
  ship.alive = false;
  world.spawn(
    new Explosion({
      pos: ship.pos,
      rng: world.rng,
      count: 36,
      speed: 220,
      color: ship.color,
    }),
  );
  if (killer && killer !== ship) killer.score += POINTS.ship;
  world.schedule(RESPAWN_DELAY, () => {
    ship.respawn(findSafeSpot(world, ship));
    world.spawn(ship);
  });
}

// Pick the candidate with the most clearance from asteroids and other ships.
export function findSafeSpot(world, self) {
  const { width, height } = world.bounds;
  let best = new Vector2(width / 2, height / 2);
  let bestClearance = -Infinity;
  for (let i = 0; i < 24; i++) {
    const p = new Vector2(
      world.rng.range(80, width - 80),
      world.rng.range(80, height - 80),
    );
    let clearance = Infinity;
    for (const e of world) {
      if (e === self || !e.alive) continue;
      if (e.kind !== "asteroid" && e.kind !== "ship") continue;
      clearance = Math.min(clearance, p.distanceTo(e.pos) - e.radius);
    }
    if (clearance > 120) return p;
    if (clearance > bestClearance) {
      best = p;
      bestClearance = clearance;
    }
  }
  return best;
}
