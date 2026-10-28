import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { type LoopStats, createLoop } from "../src/loop.ts";

// rAF stand-in on fake timers: a frame every `frameMs`, stamped with the
// (fake) performance clock.
const frames = (frameMs: number) => ({
  requestFrame: (callback: (now: number) => void) => Number(setTimeout(() => callback(performance.now()), frameMs)),
  cancelFrame: (handle: number) => clearTimeout(handle),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(() => {
  vi.useRealTimers();
});

test("the accumulator runs a fixed number of steps per second, whatever the frame rate", () => {
  for (const frameMs of [7, 16, 33, 50]) {
    let steps = 0;
    const loop = createLoop({ step: 1 / 30, simulate: () => steps++, render: () => {}, ...frames(frameMs) });
    loop.start();
    vi.advanceTimersByTime(3000);
    loop.stop();
    assert.ok(Math.abs(steps - 90) <= 2, `${frameMs} ms frames -> ${steps} steps in 3 s`);
  }
});

test("render gets the leftover fraction of a step as alpha in [0, 1)", () => {
  const alphas: number[] = [];
  const loop = createLoop({ step: 1 / 30, simulate: () => {}, render: (alpha) => alphas.push(alpha), ...frames(10) });
  loop.start();
  vi.advanceTimersByTime(500);
  loop.stop();
  assert.ok(alphas.length > 40);
  assert.ok(alphas.every((alpha) => alpha >= 0 && alpha < 1));
  assert.ok(new Set(alphas.map((a) => a.toFixed(2))).size > 2, "alpha varies between frames");
});

test("a long hitch is clamped: no spiral of death", () => {
  let steps = 0;
  let next = 16;
  const loop = createLoop({
    step: 1 / 30,
    simulate: () => steps++,
    render: () => {},
    requestFrame: (callback) => {
      const delay = next;
      next = 16;
      return Number(setTimeout(() => callback(performance.now()), delay));
    },
    cancelFrame: (handle) => clearTimeout(handle),
  });
  loop.start();
  vi.advanceTimersByTime(100);
  const before = steps;
  next = 2000; // the tab froze for 2 s
  vi.advanceTimersByTime(2100);
  loop.stop();
  assert.ok(steps - before <= 0.25 * 30 + 5, `${steps - before} steps after a 2 s hitch (cap 0.25 s)`);
});

test("stats are reported once per second", () => {
  const stats: LoopStats[] = [];
  const loop = createLoop({ step: 1 / 30, simulate: () => {}, render: () => {}, onStats: (s) => stats.push(s), ...frames(16) });
  loop.start();
  vi.advanceTimersByTime(3100);
  loop.stop();
  assert.equal(stats.length, 3);
  assert.ok(stats.every((s) => Math.abs(s.stepsPerSecond - 30) <= 1 && s.framesPerSecond >= 55));
});
