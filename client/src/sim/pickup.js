import { Entity } from "./entity.js";

// What each pickup does is DATA (a row in this table), not a subclass.
export const EFFECTS = {
  shield: { duration: 6, label: "S", color: "#4ad7ff" },
  rapidfire: { duration: 8, label: "R", color: "#ffd84a" },
  homing: { duration: 8, label: "H", color: "#ff7a4a" },
};

// Stationary and collidable, but NOT a ship: it extends Entity directly and
// has no engine, no hp, no weapon. Under a Ship-based hierarchy this
// is the case that breaks the tree.
export class Pickup extends Entity {
  constructor({ pos, effect, ttl = 14 }) {
    super({ kind: "pickup", pos, radius: 11 });
    this.effect = effect;
    this.ttl = ttl;
  }

  apply(ship) {
    ship.effects.set(this.effect, EFFECTS[this.effect].duration);
  }

  update(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) this.alive = false;
    super.update(dt);
  }
}
