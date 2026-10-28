import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { BULLET_HOMING, withHoming } from "./behaviors.js";

export class Bullet extends Entity {
  constructor({ pos, vel, owner = null, damage = 20, ttl = 1.4 }) {
    super({ kind: "bullet", pos, vel, radius: 3, angle: Math.atan2(vel.y, vel.x) });
    this.owner = owner; // the Ship that fired it; the snapshot carries owner.playerId
    this.damage = damage;
    this.ttl = ttl; // time to live, seconds
    this.seq = 0; // input seq that fired it (see Ship.fire)
  }

  static fromSnapshot(data, { owner = null } = {}) {
    const bullet = new Bullet({
      pos: new Vector2(data.x, data.y),
      vel: new Vector2(data.vx, data.vy),
      owner,
      ttl: data.ttl,
    });
    bullet.id = data.id;
    bullet.seq = data.seq;
    bullet.ownerId = data.owner;
    if (data.homing) withHoming(bullet, { ...BULLET_HOMING, ignoreId: owner?.id ?? null });
    return bullet;
  }

  toSnapshot() {
    return {
      ...super.toSnapshot(),
      vx: this.vel.x,
      vy: this.vel.y,
      owner: this.owner?.playerId ?? 0,
      seq: this.seq,
      ttl: this.ttl,
      homing: this.behaviors.length > 0,
    };
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
