import { test } from "node:test";
import assert from "node:assert/strict";
import { seq } from "@dogfight/shared/brand.ts";
import type { Controls, InputFrame } from "@dogfight/shared/protocol.ts";
import { Match, type MatchPlayer } from "../src/match.ts";
import { createTicker } from "../src/ticker.ts";

const room = { id: "unit", arena: { width: 960, height: 540, asteroids: 0 }, maxPlayers: 4 };
const thrust: Controls = { left: false, right: false, thrust: true, fire: false };
const frames = (...seqs: number[]): InputFrame[] => seqs.map((n) => ({ seq: seq(n), controls: thrust }));

function player(match: Match, id: string): MatchPlayer {
  const found = match.player(id);
  assert.ok(found, `player ${id}`);
  return found;
}

test("a ship with no input this tick is frozen, not driven by a repeated stale input", () => {
  const match = new Match(room, { withBot: false });
  match.join({ id: "a", name: "A" });
  const { ship } = player(match, "a");
  match.receiveInputs("a", frames(1));
  match.step();
  const after = ship.pos;
  assert.ok(ship.vel.length() > 0);
  match.step(); // nothing queued
  assert.deepEqual([ship.pos.x, ship.pos.y], [after.x, after.y]);
  assert.equal(player(match, "a").lastProcessedSeq, 1);
  assert.equal(match.stats.frozenTicks, 1);
});

test("after a stall the queue drains with sub-steps, but never faster than real time (speed hack)", () => {
  const match = new Match(room, { withBot: false });
  match.join({ id: "honest", name: "H" });
  match.join({ id: "cheat", name: "C" });
  for (let i = 0; i < 3; i++) match.step(); // stall: both earn credit
  match.receiveInputs("honest", frames(1, 2, 3, 4));
  match.step();
  assert.equal(player(match, "honest").lastProcessedSeq, 4, "4 queued inputs applied in one tick");

  // The cheat sends two inputs per tick for 60 ticks: 120 inputs in 2 s.
  let n = 0;
  for (let tick = 0; tick < 60; tick++) {
    match.receiveInputs("cheat", frames(n + 1, n + 2));
    n += 2;
    match.step();
  }
  const applied = 120 - player(match, "cheat").queue.length - match.stats.inputsDropped;
  assert.ok(applied <= 61 + 6, `applied ${applied} inputs in 61 ticks`);
  assert.ok(match.stats.inputsDropped > 0, "the excess is dropped, not simulated");
});

test("duplicate inputs from redundant messages are applied once", () => {
  const match = new Match(room, { withBot: false });
  match.join({ id: "a", name: "A" });
  match.receiveInputs("a", frames(1, 2));
  match.receiveInputs("a", frames(1, 2, 3));
  assert.deepEqual(
    player(match, "a").queue.map((input) => input.seq),
    [1, 2, 3],
  );
});

test("the ticker keeps 30 Hz on absolute targets and reports duration and jitter", async () => {
  let ticks = 0;
  const ticker = createTicker({ rate: 30, tick: () => ticks++ });
  ticker.start();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  ticker.stop();
  // Bounds allow one Windows timer quantum (~15.6 ms) under a loaded test run;
  // what matters is that ticks do not drift, not how precise one timer is.
  assert.ok(ticks >= 29 && ticks <= 36, `${ticks} ticks in 1.1 s`);
  const { lastSecond, intervalMs } = ticker.stats();
  assert.ok(Math.abs(intervalMs - 33.333) < 0.01);
  assert.ok(lastSecond.ticks >= 28, `last second ran ${lastSecond.ticks} ticks`);
  assert.ok(lastSecond.avgJitterMs < 16, `avg jitter ${lastSecond.avgJitterMs} ms`);
});
