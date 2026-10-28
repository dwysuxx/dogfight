// Headless netcode regression test (see src/tools/headless.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { runNetcode } from "../src/tools/headless.js";

test("prediction matches the server: ~0 px correction at 100 ms RTT, ±30 ms jitter, 2% drop", () => {
  const [pilot, other] = runNetcode();
  assert.ok(pilot.snapshots > 400);
  assert.ok(pilot.mean < 0.05, `mean correction ${pilot.mean}`);
  assert.ok(pilot.p95 < 0.05, `p95 correction ${pilot.p95}`);
  assert.ok(other.mean < 0.05, `second pilot ${other.mean}`);
});

test("collisions the client cannot predict show up as corrections, but stay rare", () => {
  const [pilot] = runNetcode({ asteroids: 10, withBot: true });
  assert.ok(pilot.max > 1, "asteroid bumps and hits are corrected");
  assert.ok(pilot.p95 < 1, `but most snapshots need no correction (p95 ${pilot.p95})`);
});

test("breaking determinism (Math.random in the client's step) makes corrections grow", () => {
  const [baseline] = runNetcode();
  const [broken] = runNetcode({
    perturb: (ship) => ship.vel.scaleInPlace(1 + (Math.random() - 0.5) * 0.08),
  });
  assert.ok(broken.mean > 0.5, `broken mean ${broken.mean}`);
  assert.ok(broken.mean > baseline.mean * 20);
});
