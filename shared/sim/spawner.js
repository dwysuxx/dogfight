import { Vector2 } from "./vector.js";
import { Asteroid } from "./asteroid.js";
import { Pickup, EFFECTS } from "./pickup.js";
import { withHoming } from "./behaviors.js";

const HUNTER_CHANCE = 0.2; // share of asteroids that chase ships

export function spawnAsteroid(world, { inside = false } = {}) {
  const { width, height } = world.bounds;
  const rng = world.rng;
  const radius = rng.range(18, 38);
  const speed = rng.range(25, 80);

  let pos;
  let angle;
  if (inside) {
    pos = new Vector2(
      rng.range(radius, width - radius),
      rng.range(radius, height - radius),
    );
    for (const ship of world.ofKind("ship")) {
      if (pos.distanceTo(ship.pos) < 200) pos = pos.add(new Vector2(width / 2, 0)); // keep clear of ships
    }
    pos.x = ((pos.x % width) + width) % width;
    angle = rng() * Math.PI * 2;
  } else {
    // enter from a random edge, heading roughly inwards
    const side = Math.floor(rng() * 4);
    if (side === 0) pos = new Vector2(-radius, rng.range(0, height));
    else if (side === 1) pos = new Vector2(width + radius, rng.range(0, height));
    else if (side === 2) pos = new Vector2(rng.range(0, width), -radius);
    else pos = new Vector2(rng.range(0, width), height + radius);
    const toCentre = Math.atan2(height / 2 - pos.y, width / 2 - pos.x);
    angle = toCentre + rng.range(-0.6, 0.6);
  }

  const asteroid = new Asteroid({
    pos,
    vel: Vector2.fromAngle(angle, speed),
    radius,
    spin: rng.range(-1, 1),
    rng,
  });
  if (rng() < HUNTER_CHANCE) {
    withHoming(asteroid, { targets: ["ship"], range: 700, turnRate: 0.6 });
  }
  return world.spawn(asteroid);
}

export function spawnPickup(world) {
  const { width, height } = world.bounds;
  const effect = world.rng.pick(Object.keys(EFFECTS));
  const pos = new Vector2(
    world.rng.range(80, width - 80),
    world.rng.range(80, height - 80),
  );
  return world.spawn(new Pickup({ pos, effect }));
}

// A system: a function (world, dt) that World.step runs every tick.
export function createSpawner({
  asteroids = 6,
  pickupEvery = 8,
  maxPickups = 2,
  asteroidDelay = 1.5,
} = {}) {
  let asteroidTimer = 0;
  let pickupTimer = pickupEvery;
  return (world, dt) => {
    asteroidTimer -= dt;
    if (asteroidTimer <= 0 && world.countKind("asteroid") < asteroids) {
      spawnAsteroid(world);
      asteroidTimer = asteroidDelay;
    }
    pickupTimer -= dt;
    if (pickupTimer <= 0) {
      pickupTimer = pickupEvery;
      if (world.countKind("pickup") < maxPickups) spawnPickup(world);
    }
  };
}
