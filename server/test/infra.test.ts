import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { type HeartbeatPeer, startHeartbeat } from "../src/heartbeat.ts";
import { createTokenBucket } from "../src/rate-limit.ts";

afterEach(() => {
  vi.useRealTimers();
});

test("token bucket: a burst is allowed, then the rate, and it refills over time", () => {
  let now = 0;
  const bucket = createTokenBucket({ ratePerSecond: 10, burst: 3, now: () => now });
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
  now += 100; // 0.1 s at 10/s = one token
  assert.equal(bucket.take(), true);
  assert.equal(bucket.take(), false);
  now += 10_000; // refill never exceeds the burst
  assert.equal(bucket.tokens, 0);
  assert.deepEqual([bucket.take(), bucket.take(), bucket.take(), bucket.take()], [true, true, true, false]);
});

test("token bucket under fake timers: 60 msg/s sustains exactly 60 messages per second", () => {
  vi.useFakeTimers({ now: 0 });
  const bucket = createTokenBucket({ ratePerSecond: 60, burst: 60 });
  let accepted = 0;
  for (let i = 0; i < 600; i++) {
    if (bucket.take()) accepted++;
    vi.advanceTimersByTime(5); // a client spamming 200 msg/s for 3 s
  }
  assert.ok(accepted >= 60 + 180 - 1 && accepted <= 60 + 180 + 1, `${accepted} accepted`);
});

function peer(): HeartbeatPeer & { pings: number; terminated: boolean } {
  return {
    alive: true,
    open: true,
    pings: 0,
    terminated: false,
    ping() {
      this.pings++;
    },
    terminate() {
      this.terminated = true;
    },
  };
}

test("heartbeat: live peers are pinged each interval, silent ones are terminated", () => {
  vi.useFakeTimers();
  const responsive = peer();
  const silent = peer();
  const stop = startHeartbeat(() => [responsive, silent], 1000);

  vi.advanceTimersByTime(1000);
  assert.deepEqual([responsive.pings, silent.pings], [1, 1]);
  responsive.alive = true; // its pong arrived; the silent peer never answers

  vi.advanceTimersByTime(1000);
  assert.equal(responsive.pings, 2);
  assert.equal(responsive.terminated, false);
  assert.equal(silent.terminated, true);

  stop();
  vi.advanceTimersByTime(5000);
  assert.equal(responsive.pings, 2, "stopped");
});
