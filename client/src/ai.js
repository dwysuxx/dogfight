import { wrapAngle } from "./sim/math.js";

const IDLE = Object.freeze({ left: false, right: false, thrust: false, fire: false });

// A tiny opponent: turns towards the nearest other ship, closes in, and fires
// in bursts. It returns the same {left,right,thrust,fire} shape the keyboard
// does, so the simulation cannot tell them apart. No randomness: deterministic.
export function botControls(world, self) {
  if (!self || !self.alive) return IDLE;

  let target = null;
  let best = Infinity;
  for (const s of world.ofKind("ship")) {
    if (s === self || !s.alive) continue;
    const d = s.pos.distanceTo(self.pos);
    if (d < best) {
      best = d;
      target = s;
    }
  }
  if (!target) return IDLE;

  const desired = Math.atan2(target.pos.y - self.pos.y, target.pos.x - self.pos.x);
  const diff = wrapAngle(desired - self.angle);
  const aligned = Math.abs(diff) < 0.12;
  return {
    left: diff < -0.08,
    right: diff > 0.08,
    thrust: best > 280 && Math.abs(diff) < 0.6,
    fire: aligned && best < 480 && world.tick % 20 < 6, // bursts, ~30% duty
  };
}
