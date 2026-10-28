import type { EffectName, PickupSnapshot } from "../protocol.ts";
import { Entity } from "./entity.ts";
import type { Ship } from "./ship.ts";
import { Vector2 } from "./vector.ts";

// What each pickup does is DATA (a row in this table), not a subclass.
// `satisfies` checks every effect has a row without widening the literals.
export const EFFECTS = {
  shield: { duration: 6, label: "S", color: "#4ad7ff" },
  rapidfire: { duration: 8, label: "R", color: "#ffd84a" },
  homing: { duration: 8, label: "H", color: "#ff7a4a" },
} as const satisfies Record<EffectName, { duration: number; label: string; color: string }>;

// Stationary and collidable, but NOT a ship: it extends Entity directly and
// has no engine, no hp, no weapon. Under a Ship-based hierarchy this
// is the case that breaks the tree.
export class Pickup extends Entity {
  readonly kind = "pickup";
  effect: EffectName;
  ttl: number;

  constructor({ pos, effect, ttl = 14 }: { pos: Vector2; effect: EffectName; ttl?: number }) {
    super({ pos, radius: 11 });
    this.effect = effect;
    this.ttl = ttl;
  }

  static fromSnapshot(data: PickupSnapshot): Pickup {
    return new Pickup({ pos: new Vector2(data.x, data.y), effect: data.effect }).applySnapshot(data);
  }

  applySnapshot(data: PickupSnapshot): this {
    this.id = data.id;
    this.effect = data.effect;
    return this;
  }

  toSnapshot(): PickupSnapshot {
    return { ...this.common(), kind: "pickup", effect: this.effect };
  }

  apply(ship: Ship): void {
    ship.effects.set(this.effect, EFFECTS[this.effect].duration);
  }

  override update(dt: number): void {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
    super.update(dt);
  }
}
