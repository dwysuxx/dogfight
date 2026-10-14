// Small numeric helpers shared by the simulation and the renderer.
export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const lerp = (a, b, t) => a + (b - a) * t;

// Normalise an angle difference into (-PI, PI]. Used for "shortest turn"
// logic: homing steering, the bot's aiming and angle interpolation.
export function wrapAngle(angle) {
  const d = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return d === -Math.PI ? Math.PI : d;
}

export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
