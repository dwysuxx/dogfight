import assert from "node:assert/strict";
import { test } from "node:test";
import { interpolateEntity, SnapshotBuffer } from "../src/snapshot-buffer.js";

const snapshot = (tick) => ({ tick, entities: [] });

test("SnapshotBuffer interpolates on a delayed tick timeline", () => {
  const buffer = new SnapshotBuffer({ tickRate: 60, interpolationDelayMs: 100 });
  buffer.push(snapshot(0), 1000);
  buffer.push(snapshot(3), 1050);
  buffer.push(snapshot(6), 1100);
  buffer.push(snapshot(9), 1150);

  const sample = buffer.sample(1175);
  assert.equal(sample.before.tick, 3);
  assert.equal(sample.after.tick, 6);
  assert.equal(sample.alpha, 0.5);
});

test("SnapshotBuffer ignores duplicate ticks and never moves its render timeline backward", () => {
  const buffer = new SnapshotBuffer({ tickRate: 60, interpolationDelayMs: 100 });
  buffer.push(snapshot(0), 1000);
  buffer.push(snapshot(3), 1050);
  buffer.push(snapshot(6), 1100);
  const beforeLatePacket = buffer.sample(1160);
  assert.ok(beforeLatePacket.alpha > 0);
  assert.equal(buffer.push(snapshot(6), 1160), false);
  buffer.push(snapshot(9), 1160);
  const afterLatePacket = buffer.sample(1160);
  assert.equal(afterLatePacket.before.tick, beforeLatePacket.before.tick);
  assert.equal(afterLatePacket.after.tick, beforeLatePacket.after.tick);
  assert.equal(afterLatePacket.alpha, beforeLatePacket.alpha);
});

test("the interpolation delay is adjustable live, in ms", () => {
  const buffer = new SnapshotBuffer({ tickRate: 30, interpolationDelayMs: 100 });
  assert.equal(buffer.interpolationDelayTicks, 3);
  buffer.interpolationDelayMs = 200;
  assert.equal(buffer.interpolationDelayTicks, 6);
  assert.equal(buffer.interpolationDelayMs, 200);
});

test("wrapped ships and bullets interpolate across the arena seam instead of the whole screen", () => {
  const bounds = { width: 960, height: 540 };
  const before = { kind: "bullet", x: 2, y: 120, angle: 0 };
  const after = { kind: "bullet", x: 962, y: 122, angle: 0 };

  const half = interpolateEntity(before, after, 0.5, bounds);
  assert.ok(Math.abs(half.x - -1) < 1e-9, "moves 3 px left across the seam, not 960 px right");
  assert.equal(half.y, 121);

  const asteroid = interpolateEntity(
    { kind: "asteroid", x: 2, y: 120, angle: 0 },
    { kind: "asteroid", x: 950, y: 122, angle: 0 },
    0.5,
    bounds,
  );
  assert.equal(asteroid.x, 476, "asteroids bounce, so they never take the seam");
});

test("angles interpolate along the shortest arc", () => {
  const bounds = { width: 960, height: 540 };
  const mid = interpolateEntity(
    { kind: "ship", x: 0, y: 0, angle: 3.1 },
    { kind: "ship", x: 0, y: 0, angle: -3.1 },
    0.5,
    bounds,
  );
  assert.ok(Math.abs(Math.abs(mid.angle) - Math.PI) < 0.01);
});
