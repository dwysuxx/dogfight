// Composition, "behavior as data" flavour (Nystrom's Component pattern).
//
// A behavior is a plain object like { type: "homing", targets: [...], ... }
// pushed onto `entity.behaviors`. The code that runs it lives in the registry
// below. Any entity — a bullet, an asteroid, tomorrow a missile — can get any
// behavior without a class hierarchy, and the data is safe to serialize.
import { Vector2 } from "./vector.js";
import { clamp, wrapAngle } from "./math.js";

const registry = {
  homing: steerHoming,
};

export function runBehavior(entity, behavior, dt) {
  registry[behavior.type]?.(entity, behavior, dt);
}

// Turn the velocity towards the nearest valid target, keeping the speed.
function steerHoming(entity, cfg, dt) {
  const world = entity.world;
  if (!world) return;

  let best = null;
  let bestSq = cfg.range * cfg.range;
  for (const t of world) {
    if (!t.alive || t === entity || t.id === cfg.ignoreId) continue;
    if (!cfg.targets.includes(t.kind)) continue;
    const dSq = t.pos.sub(entity.pos).lengthSq();
    if (dSq < bestSq) {
      best = t;
      bestSq = dSq;
    }
  }
  if (!best) return;

  const speed = entity.vel.length();
  if (speed === 0) return;
  const heading = Math.atan2(entity.vel.y, entity.vel.x);
  const desired = Math.atan2(best.pos.y - entity.pos.y, best.pos.x - entity.pos.x);
  const maxTurn = cfg.turnRate * dt;
  const turn = clamp(wrapAngle(desired - heading), -maxTurn, maxTurn);
  entity.vel = Vector2.fromAngle(heading + turn, speed);
}

// What a ship with the homing pickup gives its bullets.
export const BULLET_HOMING = Object.freeze({
  targets: ["ship", "asteroid"],
  range: 420,
  turnRate: 3.2,
});

// The "mixin" helper: attach homing to ANY entity.
export function withHoming(
  entity,
  { targets, range = 450, turnRate = 3, ignoreId = null },
) {
  entity.behaviors.push({ type: "homing", targets, range, turnRate, ignoreId });
  return entity;
}
