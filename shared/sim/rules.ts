// What happens when two things touch: damage, pickups, score, respawn.
import type { Asteroid } from "./asteroid.ts";
import type { Bullet } from "./bullet.ts";
import { Explosion } from "./explosion.ts";
import type { Pickup } from "./pickup.ts";
import type { Ship } from "./ship.ts";
import { Vector2 } from "./vector.ts";
import type { GameEntity, World } from "./world.ts";

const POINTS = { asteroid: 10, ship: 50 } as const;
const CONTACT_DAMAGE = 20;
const RESPAWN_DELAY = 2; // seconds

function bulletAsteroid(bullet: Bullet, asteroid: Asteroid, world: World): void {
  bullet.alive = false;
  world.events.emit("hit", { bullet, target: asteroid });
  if (!asteroid.takeDamage(bullet.damage)) return;
  asteroid.alive = false;
  world.events.emit("exploded", { entity: asteroid });
  world.spawn(
    new Explosion({ pos: asteroid.pos, rng: world.rng, count: 14 + asteroid.radius, speed: 120, color: "#c9b79c" }),
  );
  if (bullet.owner) {
    bullet.owner.score += POINTS.asteroid;
    world.events.emit("scoreChanged", { ship: bullet.owner, score: bullet.owner.score });
  }
}

function bulletShip(bullet: Bullet, ship: Ship, world: World): void {
  if (bullet.owner === ship) return; // never hit yourself
  bullet.alive = false;
  world.events.emit("hit", { bullet, target: ship });
  if (ship.takeDamage(bullet.damage)) destroyShip(world, ship, bullet.owner);
}

function asteroidShip(asteroid: Asteroid, ship: Ship, world: World): void {
  const away = ship.pos.sub(asteroid.pos);
  const dist = away.length() || 1;
  const normal = away.scale(1 / dist);
  const overlap = asteroid.radius + ship.radius - dist;
  if (overlap > 0) ship.shift(normal.scale(overlap)); // push out, don't stick

  if (ship.contactCooldown <= 0) {
    ship.contactCooldown = 0.8;
    ship.vel = ship.vel.add(normal.scale(140));
    world.events.emit("hit", { target: ship, source: asteroid });
    if (ship.takeDamage(CONTACT_DAMAGE)) destroyShip(world, ship, null);
  }
}

function pickupShip(pickup: Pickup, ship: Ship): void {
  pickup.apply(ship);
  pickup.alive = false;
}

// Pairs are matched on the discriminant, in either order. Narrowing on
// `kind` gives each handler its concrete classes, no casts.
function resolveOrdered(a: GameEntity, b: GameEntity, world: World): boolean {
  if (a.kind === "bullet" && b.kind === "asteroid") bulletAsteroid(a, b, world);
  else if (a.kind === "bullet" && b.kind === "ship") bulletShip(a, b, world);
  else if (a.kind === "asteroid" && b.kind === "ship") asteroidShip(a, b, world);
  else if (a.kind === "pickup" && b.kind === "ship") pickupShip(a, b);
  else return false;
  return true;
}

export function resolveCollision(a: GameEntity, b: GameEntity, world: World): void {
  if (!resolveOrdered(a, b, world)) resolveOrdered(b, a, world);
}

export function destroyShip(world: World, ship: Ship, killer: Ship | null): void {
  ship.alive = false;
  world.events.emit("exploded", { entity: ship });
  world.spawn(new Explosion({ pos: ship.pos, rng: world.rng, count: 36, speed: 220, color: ship.color }));
  if (killer && killer !== ship) {
    killer.score += POINTS.ship;
    world.events.emit("scoreChanged", { ship: killer, score: killer.score });
  }
  world.schedule(RESPAWN_DELAY, () => {
    ship.respawn(findSafeSpot(world, ship));
    world.spawn(ship);
    world.events.emit("respawned", { ship });
  });
}

// Pick the candidate with the most clearance from asteroids and other ships.
export function findSafeSpot(world: World, self: GameEntity): Vector2 {
  const { width, height } = world.bounds;
  let best = new Vector2(width / 2, height / 2);
  let bestClearance = -Infinity;
  for (let i = 0; i < 24; i++) {
    const p = new Vector2(world.rng.range(80, width - 80), world.rng.range(80, height - 80));
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
