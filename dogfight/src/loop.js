export function createLoop({ step = 1 / 60, simulate, render, onStats } = {}) {
  let accumulator = 0;
  let last = null;
  let rafId = null;
  let running = false;

  // Rolling per-second stats.
  let stepsThisSecond = 0;
  let framesThisSecond = 0;
  let statsTimer = 0;
  let stepsPerSecond = 0;
  let framesPerSecond = 0;
  let lastFrameDuration = 0;

  function frame(now) {
    if (!running) return;

    if (last === null) last = now;
    const rawDelta = (now - last) / 1000; 
    last = now;
    lastFrameDuration = rawDelta * 1000; 

    const delta = Math.min(rawDelta, 0.25);
    accumulator += delta;

    while (accumulator >= step) {
      simulate(step); 
      accumulator -= step;
      stepsThisSecond++;
    }

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
