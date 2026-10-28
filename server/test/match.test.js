import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "../src/match.js";
import { createTicker } from "../src/ticker.js";

const room = { id: "unit", arena: { width: 960, height: 540, asteroids: 0 }, maxPlayers: 4 };
const thrust = { left: false, right: false, thrust: true, fire: false };

test("a ship with no input this tick is frozen, not driven by a repeated stale input", () => {
  const match = new Match(room, { withBot: false });
  match.join({ id: "a", name: "A" });
  const ship = match.player("a").ship;
  match.receiveInputs("a", [{ seq: 1, controls: thrust }]);
  match.step();
  const after = ship.pos.clone();
  assert.ok(ship.vel.length() > 0);
  match.step(); // nothing queued
  assert.deepEqual([ship.pos.x, ship.pos.y], [after.x, after.y]);
  assert.equal(match.player("a").lastProcessedSeq, 1);
  assert.equal(match.stats.frozenTicks, 1);
});

test("after a stall the queue drains with sub-steps, but never faster than real time (speed hack)", () => {
  const match = new Match(room, { withBot: false });
  match.join({ id: "honest", name: "H" });
  match.join({ id: "cheat", name: "C" });
  for (let i = 0; i < 3; i++) match.step(); // stall: both earn credit
  match.receiveInputs("honest", [1, 2, 3, 4].map((seq) => ({ seq, controls: thrust })));
  match.step();
  assert.equal(match.player("honest").lastProcessedSeq, 4, "4 queued inputs applied in one tick");

  // The cheat sends two inputs per tick for 60 ticks: 120 inputs in 2 s.
  let seq = 0;
  for (let tick = 0; tick < 60; tick++) {
    match.receiveInputs("cheat", [
      { seq: ++seq, controls: thrust },
      { seq: ++seq, controls: thrust },
    ]);
    match.step();
  }
  const cheat = match.player("cheat");
  const applied = 120 - cheat.queue.length - match.stats.inputsDropped;
  assert.ok(applied <= 61 + 6, `applied ${applied} inputs in 61 ticks`);
  assert.ok(match.stats.inputsDropped > 0, "the excess is dropped, not simulated");
});

test("duplicate inputs from redundant messages are applied once", () => {
  const match = new Match(room, { withBot: false });
  match.join({ id: "a", name: "A" });
  match.receiveInputs("a", [{ seq: 1, controls: thrust }, { seq: 2, controls: thrust }]);
  match.receiveInputs("a", [{ seq: 1, controls: thrust }, { seq: 2, controls: thrust }, { seq: 3, controls: thrust }]);
  assert.deepEqual(match.player("a").queue.map((input) => input.seq), [1, 2, 3]);
});

test("the ticker keeps 30 Hz on absolute targets and reports duration and jitter", async () => {
  let ticks = 0;
  const ticker = createTicker({ rate: 30, tick: () => ticks++ });
  ticker.start();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  ticker.stop();
  assert.ok(ticks >= 30 && ticks <= 35, `${ticks} ticks in 1.1 s`);
  const { lastSecond, intervalMs } = ticker.stats();
  assert.ok(Math.abs(intervalMs - 33.333) < 0.01);
  assert.ok(lastSecond.ticks >= 28, `last second ran ${lastSecond.ticks} ticks`);
  assert.ok(lastSecond.avgJitterMs < 10, `avg jitter ${lastSecond.avgJitterMs} ms`);
});
