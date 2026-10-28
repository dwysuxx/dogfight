import { NO_CONTROLS } from "../protocol.ts";
import type { StepControls } from "./entity.ts";
import { wrapAngle } from "./math.ts";
import type { Ship } from "./ship.ts";
import type { World } from "./world.ts";

// A tiny opponent: turns towards the nearest other ship, closes in, and fires
// in bursts. It returns the same {left,right,thrust,fire} shape the keyboard
// does, so the simulation cannot tell them apart. No randomness: deterministic.
export function botControls(world: World, self: Ship | null): StepControls {
  if (!self || !self.alive) return NO_CONTROLS;

  let target: Ship | null = null;
  let best = Infinity;
  for (const s of world.ofKind("ship")) {
    if (s === self || !s.alive) continue;
    const d = s.pos.distanceTo(self.pos);
    if (d < best) {
      best = d;
      target = s;
    }
  }
  if (!target) return NO_CONTROLS;

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
