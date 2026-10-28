import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { type PlayerId, entityId, playerId, seq, tick } from "../brand.ts";
import { replay } from "../net/prediction.ts";
import type { Controls, StateMessage } from "../protocol.ts";
import { Asteroid } from "../sim/asteroid.ts";
import { Bullet } from "../sim/bullet.ts";
import { collisionPairs } from "../sim/collision.ts";
import { Explosion } from "../sim/explosion.ts";
import { Pickup } from "../sim/pickup.ts";
import { createRng } from "../sim/rng.ts";
import { Ship } from "../sim/ship.ts";
import { entityFromSnapshot } from "../sim/snapshot.ts";
import { Vector2 } from "../sim/vector.ts";
import { World } from "../sim/world.ts";

const DT = 1 / 30;
const rock = (x: number, y: number, radius = 20) => new Asteroid({ pos: new Vector2(x, y), vel: new Vector2(), radius, rng: createRng(1) });
const pairs = (world: World) => collisionPairs(world).length;

describe("collision cases", () => {
  test("touching circles collide (distance == r1 + r2)", () => {
    const world = new World();
    world.spawn(rock(100, 100, 20));
    world.spawn(rock(140, 100, 20));
    assert.equal(pairs(world), 1);
  });

  test("overlapping circles collide, separated ones do not", () => {
    const world = new World();
    world.spawn(rock(100, 100, 20));
    const other = world.spawn(rock(130, 100, 20));
    assert.equal(pairs(world), 1);
    other.pos = new Vector2(141, 100);
    assert.equal(pairs(world), 0, "1 px gap: a miss");
  });

  test("non-colliding entities (explosions) are never paired", () => {
    const world = new World();
    world.spawn(rock(100, 100));
    world.spawn(new Explosion({ pos: new Vector2(100, 100), rng: createRng(1) }));
    assert.equal(pairs(world), 0);
  });

  // Discrete collision checks positions once per step: anything that moves
  // further than the combined diameter in one step can pass through.
  const sweep = (bulletSpeed: number) => {
    let hits = 0;
    for (let offset = 0; offset < 60; offset++) {
      const world = new World();
      const target = world.spawn(new Ship({ pos: new Vector2(500, 300) }));
      world.spawn(new Bullet({ pos: new Vector2(400 + offset * 0.5, 300), vel: new Vector2(bulletSpeed, 0), ttl: 2 }));
      for (let i = 0; i < 20; i++) world.step(DT);
      if (target.hp < Ship.MAX_HP) hits++;
    }
    return hits;
  };

  test("at the game's fastest closing speed a bullet cannot tunnel through a ship", () => {
    // 520 px/s muzzle + 320 px/s max ship speed = 840 px/s = 28 px per step,
    // less than the 30 px a bullet (r 3) and a ship (r 12) span together.
    assert.equal(sweep(840), 60, "every start offset hits");
  });

  test("a twice-faster bullet WOULD tunnel: the known limit of discrete collision", () => {
    assert.ok(sweep(1800) < 60, "some start offsets skip straight through");
  });
});

describe("snapshots round-trip through every entity kind", () => {
  test("toSnapshot -> entityFromSnapshot preserves the wire data", () => {
    const world = new World({ assignIds: true });
    const ship = world.spawn(new Ship({ pos: new Vector2(10, 20), angle: 1 }));
    ship.playerId = playerId(3);
    ship.effects.set("shield", 1.5);
    const all = [
      ship,
      world.spawn(new Bullet({ pos: new Vector2(1, 2), vel: new Vector2(3, 4), owner: ship })),
      world.spawn(rock(50, 60, 25)),
      world.spawn(new Pickup({ pos: new Vector2(7, 8), effect: "homing" })),
      world.spawn(new Explosion({ pos: new Vector2(9, 9), rng: createRng(2), count: 10, color: "#123456" })),
    ];
    for (const entity of all) {
      const data = entity.toSnapshot();
      assert.deepEqual(entityFromSnapshot(data).toSnapshot(), data, entity.kind);
    }
  });

  test("an explosion is regrown from its seed and fast-forwarded to its age", () => {
    const explosion = Explosion.fromSnapshot({
      id: entityId(5),
      kind: "explosion",
      x: 0,
      y: 0,
      angle: 0,
      color: "#ff0000",
      count: 12,
      speed: 100,
      age: 0.4,
    });
    assert.equal(explosion.particleCount, 12);
    assert.equal(explosion.age, 0.4);
    const again = Explosion.fromSnapshot(explosion.toSnapshot());
    assert.deepEqual(again.vx, explosion.vx, "same seed, same particles");
    assert.deepEqual(again.maxLife, explosion.maxLife);
  });

  test("particle positions are a pure function of age (no per-frame re-simulation)", () => {
    const explosion = new Explosion({ pos: new Vector2(100, 50), rng: createRng(3), count: 5, speed: 80 });
    explosion.update(0.25);
    const x = explosion.particleX(2);
    assert.ok(Math.abs(x - (100 + (explosion.vx[2] ?? 0) * 0.25)) < 1e-9);
    explosion.update(10);
    assert.equal(explosion.alive, false);
    assert.ok(explosion.particleLife(2) < 0, "spent");
  });
});

describe("reconciliation is a pure function of (snapshot, pending inputs)", () => {
  const me: PlayerId = playerId(1);
  const bounds = { width: 960, height: 540 };
  const thrust: Controls = { left: false, right: true, thrust: true, fire: false };

  // The authoritative world: the same Ship code the client predicts with.
  function server() {
    const world = new World({ width: 960, height: 540, assignIds: true, collisions: () => [] });
    const ship = world.spawn(new Ship({ pos: new Vector2(300, 300) }));
    ship.playerId = me;
    return { world, ship };
  }
  const snapshot = (world: World, ship: Ship, ack: number): StateMessage => ({
    type: "state",
    tick: tick(world.tick),
    ack: seq(ack),
    events: [],
    entities: [ship.toSnapshot()],
  });
  const inputs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => ({ seq: seq(from + i), controls: thrust }));

  test("a correct prediction reconciles to exactly the server's future", () => {
    const { world, ship } = server();
    const all = inputs(1, 10);
    // The server has applied 1..6 when it snapshots...
    for (const input of all.slice(0, 6)) world.step(DT, new Map([[ship.id, { ...input.controls, seq: input.seq }]]));
    const state = snapshot(world, ship, 6);
    // ...and later applies 7..10.
    for (const input of all.slice(6)) world.step(DT, new Map([[ship.id, { ...input.controls, seq: input.seq }]]));

    const predicted = replay(state, all, { bounds, playerId: me });
    assert.deepEqual(predicted.pending.map((input) => input.seq), [7, 8, 9, 10], "acked inputs dropped");
    assert.ok(predicted.ship);
    assert.ok(predicted.ship.pos.distanceTo(ship.pos) < 1e-9, "replaying 7..10 lands where the server will be");
  });

  test("same arguments, same result: replay has no hidden state", () => {
    const { world, ship } = server();
    const state = snapshot(world, ship, 0);
    const a = replay(state, inputs(1, 5), { bounds, playerId: me });
    const b = replay(state, inputs(1, 5), { bounds, playerId: me });
    assert.deepEqual(a.ship?.toSnapshot(), b.ship?.toSnapshot());
  });

  test("a server correction (e.g. a collision push) propagates through the replay", () => {
    const { world, ship } = server();
    const state = snapshot(world, ship, 0);
    const pushed: StateMessage = { ...state, entities: [{ ...ship.toSnapshot(), x: ship.pos.x + 25 }] };
    const original = replay(state, inputs(1, 3), { bounds, playerId: me });
    const corrected = replay(pushed, inputs(1, 3), { bounds, playerId: me });
    assert.ok(original.ship && corrected.ship);
    assert.ok(Math.abs(corrected.ship.pos.x - original.ship.pos.x - 25) < 1e-9);
  });

  test("no own ship in the snapshot (destroyed): nothing to predict, inputs still pending", () => {
    const state: StateMessage = { type: "state", tick: tick(1), ack: seq(2), events: [], entities: [] };
    const predicted = replay(state, inputs(1, 5), { bounds, playerId: me });
    assert.equal(predicted.ship, null);
    assert.equal(predicted.pending.length, 3);
  });
});
