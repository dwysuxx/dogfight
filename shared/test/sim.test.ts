import { test } from "node:test";
import assert from "node:assert/strict";

import { entityId, seq } from "../brand.ts";
import type { Controls } from "../protocol.ts";
import { botControls } from "../sim/ai.ts";
import { Asteroid } from "../sim/asteroid.ts";
import { withHoming } from "../sim/behaviors.ts";
import { Bullet } from "../sim/bullet.ts";
import { findCollisions } from "../sim/collision.ts";
import { Entity, type StepControls } from "../sim/entity.ts";
import { createGame } from "../sim/game.ts";
import { Pickup } from "../sim/pickup.ts";
import { createRng } from "../sim/rng.ts";
import { Ship } from "../sim/ship.ts";
import { Vector2 } from "../sim/vector.ts";
import { type StepInputs, World } from "../sim/world.ts";

const DT = 1 / 60;
const quietWorld = () => new World({ seed: 3 });
const stepFor = (world: World, seconds: number, inputs?: StepInputs) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) world.step(DT, inputs);
};
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("expected a value");
  return value;
}
const rock = (x: number, y: number, radius = 20, vel = new Vector2()) =>
  new Asteroid({ pos: new Vector2(x, y), vel, radius, rng: createRng(1) });

test("Vector2 is immutable: every method returns a new vector", () => {
  const a = new Vector2(3, 4);
  const b = a.add(new Vector2(1, 1));
  assert.deepEqual([a.x, a.y], [3, 4]);
  assert.deepEqual([b.x, b.y], [4, 5]);
  assert.equal(a.length(), 5);
  assert.ok(Math.abs(a.normalize().length() - 1) < 1e-12);
  assert.deepEqual(new Vector2().normalize(), new Vector2());
  const r = new Vector2(1, 0).rotate(Math.PI / 2);
  assert.ok(Math.abs(r.x) < 1e-12 && Math.abs(r.y - 1) < 1e-12);
  assert.equal(a.dot(new Vector2(2, 1)), 10);
  const f = Vector2.fromAngle(0, 5);
  assert.deepEqual([f.x, f.y], [5, 0]);
  assert.deepEqual(a.addScaled(new Vector2(1, 2), 2), new Vector2(5, 8));
  assert.deepEqual([a.x, a.y], [3, 4], "still untouched");
});

test("Entity ids are unique, and the counter is private but resettable", () => {
  Entity.resetIds();
  const ids = [rock(0, 0), rock(0, 0), rock(0, 0)].map((e) => e.id);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(Object.keys(Entity).includes("#nextId"), false);
});

test("inheritance is one level deep", () => {
  for (const Cls of [Ship, Bullet, Asteroid, Pickup]) {
    assert.equal(Object.getPrototypeOf(Cls), Entity, `${Cls.name} extends Entity directly`);
  }
  assert.equal(Object.getPrototypeOf(Entity), Function.prototype);
});

test("World: Map store, iterable, ofKind narrows by kind, deferred despawn", () => {
  const world = quietWorld();
  const ship = world.spawn(new Ship({ pos: new Vector2(100, 100) }));
  const asteroid = world.spawn(rock(600, 300));
  assert.equal(world.size, 2);
  assert.equal(world.get(ship.id), ship);
  const asteroids: Asteroid[] = [...world.ofKind("asteroid")];
  assert.deepEqual(asteroids, [asteroid]);
  assert.deepEqual([...world].length, 2);

  world.despawn(asteroid.id);
  assert.equal(world.get(asteroid.id), asteroid, "still there until the sweep");
  assert.equal(asteroid.alive, false);
  world.step(DT);
  assert.equal(world.get(asteroid.id), undefined, "swept at the end of the step");
  assert.equal(world.size, 1);
});

test("a world with assignIds numbers its own u16 ids; keepId adopts one", () => {
  const world = new World({ assignIds: true });
  const a = world.spawn(rock(0, 0));
  const b = world.spawn(rock(0, 0));
  assert.deepEqual([a.id, b.id], [1, 2]);
  const adopted = rock(0, 0);
  adopted.id = entityId(500);
  world.spawn(adopted, { keepId: true });
  assert.equal(world.get(entityId(500)), adopted);
});

test("Ship.fire spawns a bullet from the nose with inherited velocity and the input seq", () => {
  const world = quietWorld();
  const ship = world.spawn(new Ship({ pos: new Vector2(200, 200), angle: 0 }));
  ship.vel = new Vector2(50, 0);
  ship.controls = { left: false, right: false, thrust: false, fire: true, seq: seq(42) };
  const bullet = must(ship.fire());
  assert.ok(bullet instanceof Bullet);
  assert.ok(bullet.pos.x > ship.pos.x, "starts ahead of the ship");
  assert.equal(bullet.vel.x, 50 + 520);
  assert.equal(bullet.seq, 42);
  assert.equal(ship.fire(), null, "cooldown blocks the second shot");
});

test("the `this` bug: a detached fire() throws, a listener fire() silently does nothing, fixes work", () => {
  const world = quietWorld();
  const ship = world.spawn(new Ship({ pos: new Vector2(200, 200) }));

  const detached = ship.fire;
  assert.throws(() => detached(), TypeError);

  const button = new EventTarget();
  button.addEventListener("click", ship.fire);
  button.dispatchEvent(new Event("click"));
  world.step(DT);
  assert.equal(world.countKind("bullet"), 0, "no bullet: `this` was the button");

  button.addEventListener("click", () => ship.fire());
  button.dispatchEvent(new Event("click"));
  world.step(DT);
  assert.equal(world.countKind("bullet"), 1);
});

test("hp is private: readable through the getter only", () => {
  const ship = new Ship({ pos: new Vector2() });
  assert.equal(ship.hp, Ship.MAX_HP);
  // `ship.hp = 1` no longer compiles; at runtime the getter-only accessor refuses it.
  assert.equal(Reflect.set(ship, "hp", 1), false);
  assert.equal(ship.hp, Ship.MAX_HP);
  assert.equal(ship.takeDamage(30), false);
  assert.equal(ship.hp, 70);
  assert.equal(ship.takeDamage(500), true);
  assert.equal(ship.hp, 0);
});

test("collisions: the system only emits pairs; bullets damage asteroids", () => {
  const world = quietWorld();
  const asteroid = world.spawn(rock(300, 300, 30));
  const shooter = world.spawn(new Ship({ pos: new Vector2(50, 50) }));
  const bullet = world.spawn(
    new Bullet({ pos: new Vector2(300, 300), vel: new Vector2(10, 0), owner: shooter, damage: 20 }),
  );

  const pairs = [...findCollisions(world)];
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0]?.includes(asteroid) && pairs[0].includes(bullet));

  world.step(DT);
  assert.equal(asteroid.hp, 10);
  assert.equal(bullet.alive, false);
  assert.equal(world.get(bullet.id), undefined);
});

test("destroying an asteroid awards score, spawns an explosion and emits typed events", () => {
  const world = quietWorld();
  const shooter = world.spawn(new Ship({ pos: new Vector2(50, 50) }));
  world.spawn(rock(300, 300, 18));
  world.spawn(new Bullet({ pos: new Vector2(300, 300), vel: new Vector2(), owner: shooter, damage: 100 }));
  const exploded: string[] = [];
  world.events.on("exploded", ({ entity }) => exploded.push(entity.kind));
  world.events.on("scoreChanged", ({ score }) => assert.equal(score, 10));
  world.step(DT);
  assert.equal(shooter.score, 10);
  assert.equal(world.countKind("explosion"), 1);
  assert.equal(world.countKind("asteroid"), 0);
  assert.deepEqual(exploded, ["asteroid"]);
});

test("a destroyed ship explodes and respawns after 2 s with full hp and a shield", () => {
  const world = quietWorld();
  const killer = world.spawn(new Ship({ pos: new Vector2(50, 50) }));
  const victim = world.spawn(new Ship({ pos: new Vector2(400, 300) }));
  victim.takeDamage(90);
  world.spawn(new Bullet({ pos: new Vector2(400, 300), vel: new Vector2(), owner: killer, damage: 50 }));

  world.step(DT);
  assert.equal(victim.alive, false);
  assert.equal(killer.score, 50);
  assert.equal(world.countKind("explosion"), 1);
  assert.equal(world.get(victim.id), undefined);

  stepFor(world, 1.8);
  assert.equal(victim.alive, false, "still waiting");
  stepFor(world, 0.5);
  assert.equal(victim.alive, true);
  assert.equal(victim.hp, Ship.MAX_HP);
  assert.ok(victim.effects.has("shield"));
  assert.equal(world.get(victim.id), victim);
});

test("a shield absorbs damage", () => {
  const ship = new Ship({ pos: new Vector2() });
  ship.effects.set("shield", 5);
  assert.equal(ship.takeDamage(999), false);
  assert.equal(ship.hp, Ship.MAX_HP);
});

test("pickups apply an effect to a ship and disappear", () => {
  const world = quietWorld();
  const ship = world.spawn(new Ship({ pos: new Vector2(300, 300) }));
  const pickup = world.spawn(new Pickup({ pos: new Vector2(300, 300), effect: "rapidfire" }));
  world.step(DT);
  assert.ok((ship.effects.get("rapidfire") ?? 0) > 7);
  assert.equal(world.get(pickup.id), undefined);
});

test("composition: the same homing behavior steers a bullet AND an asteroid", () => {
  const world = quietWorld();
  const target = world.spawn(new Ship({ pos: new Vector2(500, 100) }));
  const bullet = world.spawn(new Bullet({ pos: new Vector2(500, 400), vel: new Vector2(200, 0), ttl: 5 }));
  withHoming(bullet, { targets: ["ship"], turnRate: 4 });
  const hunter = world.spawn(rock(100, 100, 20, new Vector2(0, 60)));
  withHoming(hunter, { targets: ["ship"], turnRate: 4 });

  stepFor(world, 0.5);
  assert.ok(bullet.vel.y < 0, "bullet turned up, towards the ship");
  assert.ok(hunter.vel.x > 0, "asteroid turned right, towards the ship");
  assert.ok(Math.abs(bullet.vel.length() - 200) < 1e-9, "speed is preserved");
  assert.ok(target.alive);
});

test("asteroids bounce off the edges, ships wrap around", () => {
  const world = quietWorld();
  const asteroid = world.spawn(rock(30, 270, 20, new Vector2(-200, 0)));
  const ship = world.spawn(new Ship({ pos: new Vector2(2, 270), angle: Math.PI }));
  ship.vel = new Vector2(-200, 0);
  stepFor(world, 0.5);
  assert.ok(asteroid.vel.x > 0, "bounced");
  assert.ok(ship.pos.x > 800, "wrapped to the far side");
});

function playerAndBot(seed: number) {
  const { world, player, bot } = createGame({ seed });
  return { world, player: must(player), bot: must(bot) };
}

const inputsFor = (player: Ship, controls: Controls, bot: Ship, world: World): StepInputs =>
  new Map<typeof player.id, StepControls>([
    [player.id, controls],
    [bot.id, botControls(world, bot)],
  ]);

test("determinism: same seed + same inputs => identical world; another seed differs", () => {
  const run = (seed: number) => {
    const { world, player, bot } = playerAndBot(seed);
    for (let t = 0; t < 900; t++) {
      world.step(DT, inputsFor(player, { left: t % 120 < 30, right: false, thrust: true, fire: t % 10 === 0 }, bot, world));
    }
    const state = [...world].map((e) => [e.kind, e.id, +e.pos.x.toFixed(6), +e.pos.y.toFixed(6)]);
    return JSON.stringify({ state, scores: [player.score, bot.score], hp: [player.hp, bot.hp] });
  };
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
});

test("a long simulation stays finite and keeps the asteroid count topped up", () => {
  const { world, player, bot } = playerAndBot(5);
  for (let t = 0; t < 3600; t++) {
    world.step(DT, inputsFor(player, { left: false, right: t % 90 < 20, thrust: t % 200 < 120, fire: true }, bot, world));
  }
  for (const e of world) {
    assert.ok(Number.isFinite(e.pos.x) && Number.isFinite(e.pos.y), `${e.kind} position is finite`);
  }
  assert.ok(world.countKind("asteroid") >= 1);
  assert.ok(world.countKind("bullet") < 200, "bullets expire via ttl");
});
