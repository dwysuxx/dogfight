import { performance } from "node:perf_hooks";

const MAX_TICKS_BEHIND = 5;

export interface TickWindow {
  readonly ticks: number;
  readonly avgDurationMs: number;
  readonly maxDurationMs: number;
  readonly avgJitterMs: number;
  readonly maxJitterMs: number;
}

export interface TickerStats {
  readonly rate: number;
  readonly intervalMs: number;
  readonly totalTicks: number;
  readonly overruns: number;
  readonly lastSecond: TickWindow;
  // Tick duration percentiles over the last RECENT_TICKS ticks (~10 s).
  readonly recent: { readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number };
}

const RECENT_TICKS = 300;

export interface Ticker {
  readonly interval: number;
  readonly running: boolean;
  start(): void;
  stop(): void;
  stats(): TickerStats;
}

// A fixed-rate loop on absolute target times. setInterval(fn, 33) drifts
// (every late callback pushes the next one later) and Node may coalesce
// timers. Here each tick is scheduled against `target`, which advances by
// exactly one interval per tick, so lateness is corrected instead of
// accumulated. If the process falls more than MAX_TICKS_BEHIND behind (a GC
// pause, a blocked event loop, a tick slower than its interval) we resync
// instead of running a burst of catch-up ticks, and count an overrun.
export function createTicker({
  rate,
  tick,
  now = () => performance.now(),
}: {
  rate: number;
  tick: () => void;
  now?: () => number;
}): Ticker {
  const interval = 1000 / rate;
  let target = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  const empty = () => ({ ticks: 0, duration: 0, maxDuration: 0, jitter: 0, maxJitter: 0 });
  let window = empty();
  let last: TickWindow = { ticks: 0, avgDurationMs: 0, maxDurationMs: 0, avgJitterMs: 0, maxJitterMs: 0 };
  let windowStarted = 0;
  let totalTicks = 0;
  let overruns = 0;
  const recent = new Float64Array(RECENT_TICKS); // ring of tick durations, no allocation per tick

  function run(): void {
    if (!running) return;
    const started = now();
    const jitter = Math.abs(started - target);
    tick();
    const finished = now();
    const duration = finished - started;
    recent[totalTicks % RECENT_TICKS] = duration;
    totalTicks++;

    window.ticks++;
    window.duration += duration;
    window.maxDuration = Math.max(window.maxDuration, duration);
    window.jitter += jitter;
    window.maxJitter = Math.max(window.maxJitter, jitter);
    if (finished - windowStarted >= 1000) {
      last = {
        ticks: window.ticks,
        avgDurationMs: window.duration / window.ticks,
        maxDurationMs: window.maxDuration,
        avgJitterMs: window.jitter / window.ticks,
        maxJitterMs: window.maxJitter,
      };
      window = empty();
      windowStarted = finished;
    }

    target += interval;
    if (finished - target > interval * MAX_TICKS_BEHIND) {
      overruns++;
      target = finished + interval;
    }
    timer = setTimeout(run, Math.max(0, target - now()));
  }

  return {
    interval,
    start() {
      if (running) return;
      running = true;
      target = now() + interval;
      windowStarted = now();
      timer = setTimeout(run, interval);
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    get running() {
      return running;
    },
    // Last full second: ticks run, tick duration and lateness (jitter).
    stats() {
      const sorted = recent.slice(0, Math.min(totalTicks, RECENT_TICKS)).sort();
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return {
        rate,
        intervalMs: interval,
        totalTicks,
        overruns,
        lastSecond: last,
        recent: { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? 0 },
      };
    },
  };
}
