// Composition, "behavior as data" flavour (Nystrom's Component pattern).
//
// A behavior is a plain object like { type: "homing", targets: [...], ... }
// pushed onto `entity.behaviors`. The code that runs it is chosen by an
// exhaustive switch below. Any entity — a bullet, an asteroid, tomorrow a
// missile — can get any behavior without a class hierarchy, and the data is
// safe to serialize.
import type { EntityId } from "../brand.ts";
import { type EntityKind, assertNever } from "../protocol.ts";
import type { Entity } from "./entity.ts";
import { clamp, wrapAngle } from "./math.ts";
import { Vector2 } from "./vector.ts";

export interface HomingBehavior {
  readonly type: "homing";
  readonly targets: readonly EntityKind[];
  readonly range: number;
  readonly turnRate: number;
  readonly ignoreId: EntityId | null;
}
export type Behavior = HomingBehavior;

// What a ship with the homing pickup gives its bullets.
export const BULLET_HOMING = Object.freeze({
  targets: ["ship", "asteroid"],
  range: 420,
  turnRate: 3.2,
} as const);

export function runBehavior(entity: Entity, behavior: Behavior, dt: number): void {
  switch (behavior.type) {
    case "homing":
      return steerHoming(entity, behavior, dt);
    default:
      return assertNever(behavior.type, "behavior");
  }
}

// Turn the velocity towards the nearest valid target, keeping the speed.
function steerHoming(entity: Entity, cfg: HomingBehavior, dt: number): void {
  const world = entity.world;
  if (!world) return;

  let best: Entity | null = null;
  let bestSq = cfg.range * cfg.range;
  const all = world.all;
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (!t || !t.alive || t === entity || t.id === cfg.ignoreId) continue;
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

// The "mixin" helper: attach homing to ANY entity.
export function withHoming<T extends Entity>(
  entity: T,
  {
    targets,
    range = 450,
    turnRate = 3,
    ignoreId = null,
  }: { targets: readonly EntityKind[]; range?: number; turnRate?: number; ignoreId?: EntityId | null },
): T {
  entity.behaviors.push({ type: "homing", targets, range, turnRate, ignoreId });
  return entity;
}
