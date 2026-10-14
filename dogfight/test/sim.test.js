import { test } from "node:test";
import assert from "node:assert/strict";

import { Vector2 } from "../src/sim/vector.js";
import { Entity } from "../src/sim/entity.js";
import { World } from "../src/sim/world.js";
import { Ship } from "../src/sim/ship.js";
import { Bullet } from "../src/sim/bullet.js";
import { Asteroid } from "../src/sim/asteroid.js";
import { Pickup } from "../src/sim/pickup.js";
import { withHoming } from "../src/sim/behaviors.js";
import { findCollisions } from "../src/sim/collision.js";
import { createGame } from "../src/sim/game.js";
import { createRng } from "../src/sim/rng.js";
import { botControls } from "../src/ai.js";

const DT = 1 / 60;
const quietWorld = () => new World({ seed: 3 });
const stepFor = (world, seconds, inputs) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) world.step(DT, inputs);
};

test("Vector2: pure methods do not mutate, in-place variants do", () => {
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
  a.addInPlace(new Vector2(1, 1));
  assert.deepEqual([a.x, a.y], [4, 5]);
});

test("Entity ids are unique, and the counter is private but resettable", () => {
  Entity.resetIds();
  const ids = [new Entity(), new Entity(), new Entity()].map((e) => e.id);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(Object.keys(Entity).includes("#nextId"), false);
});

test("inheritance is one level deep", () => {
  for (const Cls of [Ship, Bullet, Asteroid, Pickup]) {
    assert.equal(
      Object.getPrototypeOf(Cls),
      Entity,
      `${Cls.name} extends Entity directly`,
    );
  }
  assert.equal(Object.getPrototypeOf(Entity), Function.prototype);
});

test("World: Map store, iterable, ofKind generator, deferred despawn", () => {
  const world = quietWorld();
  const ship = world.spawn(new Ship({ pos: new Vector2(100, 100) }));
  const rock = world.spawn(
    new Asteroid({
      pos: new Vector2(600, 300),
      vel: new Vector2(),
      radius: 20,
      rng: createRng(1),
    }),
  );
  assert.equal(world.size, 2);
  assert.equal(world.get(ship.id), ship);
  assert.deepEqual([...world.ofKind("asteroid")], [rock]);
  assert.deepEqual([...world].length, 2);

  world.despawn(rock.id);
  assert.equal(world.get(rock.id), rock, "still there until the sweep");
  assert.equal(rock.alive, false);
  world.step(DT);
  assert.equal(world.get(rock.id), undefined, "swept at the end of the step");
  assert.equal(world.size, 1);
});

test("Ship.fire spawns a bullet from the nose with inherited velocity", () => {
  const world = quietWorld();
  const ship = world.spawn(new Ship({ pos: new Vector2(200, 200), angle: 0 }));
  ship.vel.set(50, 0);
  const bullet = ship.fire();
  assert.ok(bullet instanceof Bullet);
  assert.ok(bullet.pos.x > ship.pos.x, "starts ahead of the ship");
  assert.equal(bullet.vel.x, 50 + 520);
  assert.equal(ship.fire(), null, "cooldown blocks the second shot");
});

test("the `this` bug: a detached fire() throws, a listener fire() silently does nothing, fixes work", () => {
  const world = quietWorld();
  const ship = world.spawn(new Ship({ pos: new Vector2(200, 200) }));

  const detached = ship.fire;
  assert.throws(() => detached(), TypeError);

  const button = new EventTarget();
  const wrong = ship.fire;
  button.addEventListener("click", wrong);
  button.dispatchEvent(new Event("click"));
  world.step(DT);
  assert.equal(world.countKind("bullet"), 0, "no bullet: `this` was the button");

  button.addEventListener("click", () => ship.fire());
  button.dispatchEvent(new Event("click"));
  world.step(DT);
  assert.equal(world.countKind("bullet"), 1);
});

test("hp is private: readable through the getter, not writable", () => {
  const ship = new Ship({ pos: new Vector2() });
  assert.equal(ship.hp, Ship.MAX_HP);
  assert.throws(() => {
    ship.hp = 1;
  }, TypeError);
  assert.equal(ship.takeDamage(30), false);
  assert.equal(ship.hp, 70);
  assert.equal(ship.takeDamage(500), true);
  assert.equal(ship.hp, 0);
});

test("collisions: the system only emits pairs; bullets damage asteroids", () => {
  const world = quietWorld();
  const rock = world.spawn(
    new Asteroid({
      pos: new Vector2(300, 300),
      vel: new Vector2(),
      radius: 30,
      rng: createRng(1),
    }),
  );
  const shooter = world.spawn(new Ship({ pos: new Vector2(50, 50) }));
  const bullet = world.spawn(
    new Bullet({
      pos: new Vector2(300, 300),
      vel: new Vector2(10, 0),
      owner: shooter,
      damage: 20,
    }),
  );

  const pairs = [...findCollisions(world)];
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].includes(rock) && pairs[0].includes(bullet));

  world.step(DT);
  assert.equal(rock.hp, 10);
  assert.equal(bullet.alive, false);
  assert.equal(world.get(bullet.id), undefined);
});

test("destroying an asteroid awards score and spawns an explosion", () => {
  const world = quietWorld();
  const shooter = world.spawn(new Ship({ pos: new Vector2(50, 50) }));
  world.spawn(
    new Asteroid({
      pos: new Vector2(300, 300),
      vel: new Vector2(),
      radius: 18,
      rng: createRng(1),
    }),
  );
  world.spawn(
    new Bullet({
      pos: new Vector2(300, 300),
      vel: new Vector2(),
      owner: shooter,
      damage: 100,
    }),
  );
  world.step(DT);
  assert.equal(shooter.score, 10);
  assert.equal(world.countKind("explosion"), 1);
  assert.equal(world.countKind("asteroid"), 0);
});

test("a destroyed ship explodes and respawns after 2 s with full hp and a shield", () => {
  const world = quietWorld();
  const killer = world.spawn(new Ship({ pos: new Vector2(50, 50) }));
  const victim = world.spawn(new Ship({ pos: new Vector2(400, 300) }));
  victim.takeDamage(90);
  world.spawn(
    new Bullet({
      pos: new Vector2(400, 300),
      vel: new Vector2(),
      owner: killer,
      damage: 50,
    }),
  );

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
  const pickup = world.spawn(
    new Pickup({ pos: new Vector2(300, 300), effect: "rapidfire" }),
  );
  world.step(DT);
  assert.ok(ship.effects.get("rapidfire") > 7);
  assert.equal(world.get(pickup.id), undefined);
});

test("composition: the same homing behavior steers a bullet AND an asteroid", () => {
  const world = quietWorld();
  const target = world.spawn(new Ship({ pos: new Vector2(500, 100) }));

  const bullet = world.spawn(
    new Bullet({ pos: new Vector2(500, 400), vel: new Vector2(200, 0), ttl: 5 }),
  );
  withHoming(bullet, { targets: ["ship"], turnRate: 4 });
  const rock = world.spawn(
    new Asteroid({
      pos: new Vector2(100, 100),
      vel: new Vector2(0, 60),
      radius: 20,
      rng: createRng(1),
    }),
  );
  withHoming(rock, { targets: ["ship"], turnRate: 4 });

  stepFor(world, 0.5);
  assert.ok(bullet.vel.y < 0, "bullet turned up, towards the ship");
  assert.ok(rock.vel.x > 0, "asteroid turned right, towards the ship");
  assert.ok(Math.abs(bullet.vel.length() - 200) < 1e-9, "speed is preserved");
  assert.ok(target.alive);
});

test("asteroids bounce off the edges, ships wrap around", () => {
  const world = quietWorld();
  const rock = world.spawn(
    new Asteroid({
      pos: new Vector2(30, 270),
      vel: new Vector2(-200, 0),
      radius: 20,
      rng: createRng(1),
    }),
  );
  const ship = world.spawn(new Ship({ pos: new Vector2(2, 270), angle: Math.PI }));
  ship.vel.set(-200, 0);
  stepFor(world, 0.5);
  assert.ok(rock.vel.x > 0, "bounced");
  assert.ok(ship.pos.x > 800, "wrapped to the far side");
});

test("determinism: same seed + same inputs => identical world; another seed differs", () => {
  const run = (seed) => {
    const { world, player, bot } = createGame({ seed });
    for (let t = 0; t < 900; t++) {
      world.step(
        DT,
        new Map([
          [
            player.id,
            { left: t % 120 < 30, right: false, thrust: true, fire: t % 10 === 0 },
          ],
          [bot.id, botControls(world, bot)],
        ]),
      );
    }
    const state = [...world].map((e) => [
      e.kind,
      e.id,
      +e.pos.x.toFixed(6),
      +e.pos.y.toFixed(6),
    ]);
    return JSON.stringify({
      state,
      scores: [player.score, bot.score],
      hp: [player.hp, bot.hp],
    });
  };
  assert.equal(run(7), run(7));
  assert.notEqual(run(7), run(8));
});

test("a long simulation stays finite and keeps the asteroid count topped up", () => {
  const { world, player, bot } = createGame({ seed: 5 });
  for (let t = 0; t < 3600; t++) {
    world.step(
      DT,
      new Map([
        [
          player.id,
          { left: false, right: t % 90 < 20, thrust: t % 200 < 120, fire: true },
        ],
        [bot.id, botControls(world, bot)],
      ]),
    );
  }
  for (const e of world) {
    assert.ok(
      Number.isFinite(e.pos.x) && Number.isFinite(e.pos.y),
      `${e.kind} position is finite`,
    );
  }
  assert.ok(world.countKind("asteroid") >= 1);
  assert.ok(world.countKind("bullet") < 200, "bullets expire via ttl");
});
