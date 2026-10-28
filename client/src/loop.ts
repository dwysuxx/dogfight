// The game loop: a fixed-timestep simulation driven by requestAnimationFrame.
// See Glenn Fiedler's "Fix Your Timestep!" — this is that pattern, with
// stats bookkeeping (steps/s, frames/s, frame time) added for the HUD.

export interface LoopStats {
  readonly stepsPerSecond: number;
  readonly framesPerSecond: number;
  readonly lastFrameDuration: number;
}

export interface LoopOptions {
  step?: number;
  simulate: (dt: number) => void;
  render: (alpha: number) => void;
  onStats?: (stats: LoopStats) => void;
}

export interface Loop {
  start(): void;
  stop(): void;
  getStats(): LoopStats;
}

export function createLoop({ step = 1 / 60, simulate, render, onStats }: LoopOptions): Loop {
  let accumulator = 0;
  let last: number | null = null;
  let rafId: number | null = null;
  let running = false;

  // Rolling per-second stats.
  let stepsThisSecond = 0;
  let framesThisSecond = 0;
  let statsTimer = 0;
  let stepsPerSecond = 0;
  let framesPerSecond = 0;
  let lastFrameDuration = 0;

  function frame(now: number): void {
    if (!running) return;

    if (last === null) last = now;
    const rawDelta = (now - last) / 1000; // seconds, unclamped
    last = now;
    lastFrameDuration = rawDelta * 1000; // ms, for the HUD — shows real jank

    // Clamp the delta fed into the accumulator. Without this, a single long
    // hitch (tab switch, GC pause, a breakpoint) would force the while-loop
    // below to run hundreds of simulate() calls in a row trying to catch
    // up — the "spiral of death". Capping at 0.25s means the simulation
    // will look like it briefly paused rather than exploding.
    const delta = Math.min(rawDelta, 0.25);
    accumulator += delta;

    while (accumulator >= step) {
      simulate(step); // always the same dt: deterministic physics
      accumulator -= step;
      stepsThisSecond++;
    }

    // Whatever fraction of a step is left over is how far between the
    // previous and current simulation state we are, visually.
    const alpha = accumulator / step; // in [0, 1)
    render(alpha);
    framesThisSecond++;

    statsTimer += rawDelta;
    if (statsTimer >= 1) {
      stepsPerSecond = stepsThisSecond;
      framesPerSecond = framesThisSecond;
      stepsThisSecond = 0;
      framesThisSecond = 0;
      statsTimer = 0;
      onStats?.({ stepsPerSecond, framesPerSecond, lastFrameDuration });
    }

    rafId = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      last = null;
      accumulator = 0;
      rafId = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
    getStats() {
      return { stepsPerSecond, framesPerSecond, lastFrameDuration };
    },
  };
}
