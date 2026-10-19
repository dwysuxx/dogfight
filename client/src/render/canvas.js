// Device-pixel-ratio-aware canvas setup. Without this, everything drawn is
// blurry on retina/high-DPI displays: the canvas's backing bitmap must be
// dpr times larger than its CSS size, then scaled back down via the
// transform so drawing code can still work in CSS pixels.
export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = window.innerWidth;
    const cssHeight = window.innerHeight;
    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener("resize", resize);

  return {
    ctx,
    getSize: () => ({ width: window.innerWidth, height: window.innerHeight }),
  };
}
