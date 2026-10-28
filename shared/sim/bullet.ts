import { NO_PLAYER, NO_SEQ, type PlayerId, type Seq } from "../brand.ts";
import type { BulletSnapshot } from "../protocol.ts";
import { BULLET_HOMING, withHoming } from "./behaviors.ts";
import { Entity } from "./entity.ts";
import type { Ship } from "./ship.ts";
import { Vector2 } from "./vector.ts";

export interface BulletOptions {
  pos: Vector2;
  vel: Vector2;
  owner?: Ship | null;
  damage?: number;
  ttl?: number;
}

export class Bullet extends Entity {
  readonly kind = "bullet";
  owner: Ship | null; // the Ship that fired it; the snapshot carries owner.playerId
  ownerId: PlayerId = NO_PLAYER; // set when rebuilt from a snapshot without the Ship
  damage: number;
  ttl: number; // time to live, seconds
  seq: Seq = NO_SEQ; // input seq that fired it (see Ship.fire)

  constructor({ pos, vel, owner = null, damage = 20, ttl = 1.4 }: BulletOptions) {
    super({ pos, vel, radius: 3, angle: Math.atan2(vel.y, vel.x) });
    this.owner = owner;
    this.damage = damage;
    this.ttl = ttl;
  }

  static fromSnapshot(data: BulletSnapshot, { owner = null }: { owner?: Ship | null } = {}): Bullet {
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

  toSnapshot(): BulletSnapshot {
    return {
      ...this.common(),
      kind: "bullet",
      vx: this.vel.x,
      vy: this.vel.y,
      owner: this.owner?.playerId ?? this.ownerId,
      seq: this.seq,
      ttl: this.ttl,
      homing: this.behaviors.length > 0,
    };
  }

  override update(dt: number): void {
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
