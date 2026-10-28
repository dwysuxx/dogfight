import assert from "node:assert/strict";
import { test } from "vitest";
import { entityId, playerId, seq } from "@dogfight/shared/brand.ts";
import type { BulletSnapshot, EntitySnapshot } from "@dogfight/shared/protocol.ts";
import { type Sample, SnapshotBuffer, interpolateEntity } from "../src/snapshot-buffer.ts";

const snapshot = (tick: number) => ({ tick, entities: [] });
const bounds = { width: 960, height: 540 };

function present<S>(sample: Sample<S> | null): Sample<S> {
  assert.ok(sample, "the buffer has snapshots");
  return sample;
}

const bullet = (x: number, y: number): BulletSnapshot => ({
  id: entityId(1),
  kind: "bullet",
  x,
  y,
  angle: 0,
  vx: 0,
  vy: 0,
  owner: playerId(1),
  seq: seq(1),
  ttl: 1,
  homing: false,
});

test("SnapshotBuffer interpolates on a delayed tick timeline", () => {
  const buffer = new SnapshotBuffer({ tickRate: 60, interpolationDelayMs: 100 });
  buffer.push(snapshot(0), 1000);
  buffer.push(snapshot(3), 1050);
  buffer.push(snapshot(6), 1100);
  buffer.push(snapshot(9), 1150);

  const sample = present(buffer.sample(1175));
  assert.equal(sample.before.tick, 3);
  assert.equal(sample.after.tick, 6);
  assert.equal(sample.alpha, 0.5);
});

test("SnapshotBuffer ignores duplicate ticks and never moves its render timeline backward", () => {
  const buffer = new SnapshotBuffer({ tickRate: 60, interpolationDelayMs: 100 });
  buffer.push(snapshot(0), 1000);
  buffer.push(snapshot(3), 1050);
  buffer.push(snapshot(6), 1100);
  const beforeLatePacket = present(buffer.sample(1160));
  assert.ok(beforeLatePacket.alpha > 0);
  assert.equal(buffer.push(snapshot(6), 1160), false);
  buffer.push(snapshot(9), 1160);
  const afterLatePacket = present(buffer.sample(1160));
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
  const half = interpolateEntity(bullet(2, 120), bullet(962, 122), 0.5, bounds);
  assert.ok(Math.abs(half.x - -1) < 1e-9, "moves 3 px left across the seam, not 960 px right");
  assert.equal(half.y, 121);
  assert.equal(half.kind, "bullet", "a bullet in, a bullet out (generic)");

  const rock = (x: number): EntitySnapshot => ({
    id: entityId(2),
    kind: "asteroid",
    x,
    y: 120,
    angle: 0,
    radius: 20,
    hp: 20,
    maxHp: 20,
    homing: false,
    shape: Array.from({ length: 11 }, () => 1),
  });
  assert.equal(interpolateEntity(rock(2), rock(950), 0.5, bounds).x, 476, "asteroids bounce, so they never take the seam");
});

test("angles interpolate along the shortest arc", () => {
  const at = (angle: number): BulletSnapshot => ({ ...bullet(0, 0), angle });
  const mid = interpolateEntity(at(3.1), at(-3.1), 0.5, bounds);
  assert.ok(Math.abs(Math.abs(mid.angle) - Math.PI) < 0.01);
});
