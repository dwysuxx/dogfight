// Headless netcode regression test (see src/tools/headless.ts).
import { test } from "vitest";
import assert from "node:assert/strict";
import { type NetcodeOptions, type PilotResult, runNetcode } from "../src/tools/headless.ts";

function pilots(options?: NetcodeOptions): [PilotResult, PilotResult] {
  const [first, second] = runNetcode(options);
  assert.ok(first && second, "two pilots");
  return [first, second];
}

test("prediction matches the server: ~0 px correction at 100 ms RTT, ±30 ms jitter, 2% drop", () => {
  const [pilot, other] = pilots();
  assert.ok(pilot.snapshots > 400);
  assert.ok(pilot.mean < 0.05, `mean correction ${pilot.mean}`);
  assert.ok(pilot.p95 < 0.05, `p95 correction ${pilot.p95}`);
  assert.ok(other.mean < 0.05, `second pilot ${other.mean}`);
});

test("collisions the client cannot predict show up as corrections, but stay rare", () => {
  const [pilot] = pilots({ asteroids: 10, withBot: true });
  assert.ok(pilot.max > 1, "asteroid bumps and hits are corrected");
  assert.ok(pilot.p95 < 1, `but most snapshots need no correction (p95 ${pilot.p95})`);
});

test("breaking determinism (Math.random in the client's step) makes corrections grow", () => {
  const [baseline] = pilots();
  const [broken] = pilots({ perturb: (ship) => (ship.vel = ship.vel.scale(1 + (Math.random() - 0.5) * 0.08)) });
  assert.ok(broken.mean > 0.3, `broken mean ${broken.mean}`);
  assert.ok(broken.mean > baseline.mean * 20);
});
