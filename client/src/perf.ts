// User Timing spans for the DevTools Performance panel (the "Timings" track):
// simulate, render, decode, reconcile. Off unless the page has ?perf=1, so a
// normal session does not buffer thousands of performance entries.
const enabled = typeof location !== "undefined" && new URLSearchParams(location.search).has("perf");

export function spanStart(name: string): void {
  if (enabled) performance.mark(`${name}:start`);
}

export function spanEnd(name: string): void {
  if (enabled) performance.measure(name, `${name}:start`);
}

// Called once a second: the entries are already in the recording.
export function flushSpans(): void {
  if (!enabled) return;
  performance.clearMarks();
  performance.clearMeasures();
}

// Frame times for the netgraph: a ring of the last 600 frames (10 s at 60
// fps) in a typed array, percentiles on demand.
export class FrameTimes {
  readonly #samples = new Float64Array(600);
  #count = 0;
  #next = 0;

  add(ms: number): void {
    this.#samples[this.#next] = ms;
    this.#next = (this.#next + 1) % this.#samples.length;
    this.#count = Math.min(this.#count + 1, this.#samples.length);
  }

  percentiles(): { p50: number; p95: number; p99: number } {
    const sorted = this.#samples.slice(0, this.#count).sort();
    const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
  }
}
