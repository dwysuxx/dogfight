import { Entity } from "./entity.js";

export class Bullet extends Entity {
  constructor({ pos, vel, owner = null, damage = 20, ttl = 1.4 }) {
    super({ kind: "bullet", pos, vel, radius: 3, angle: Math.atan2(vel.y, vel.x) });
    this.owner = owner; // a direct reference (ids-only is a Lab 5 concern)
    this.damage = damage;
    this.ttl = ttl; // time to live, seconds
  }

  update(dt) {
    this.ttl -= dt;
    if (this.ttl <= 0) {
      this.alive = false;
      return;
    }
    super.update(dt);
    this.angle = Math.atan2(this.vel.y, this.vel.x);
    this.wrapAround();
  }
}
