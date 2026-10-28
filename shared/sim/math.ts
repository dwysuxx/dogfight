// Small numeric helpers shared by the simulation and the renderer.
export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Normalise an angle difference into (-PI, PI]. Used for "shortest turn"
// logic: homing steering, the bot's aiming and angle interpolation.
export function wrapAngle(angle: number): number {
  const d = ((((angle + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return d === -Math.PI ? Math.PI : d;
}

export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;
