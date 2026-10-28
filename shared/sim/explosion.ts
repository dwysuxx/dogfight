import type { ExplosionSnapshot } from "../protocol.ts";
import { Entity } from "./entity.ts";
import { type Rng, createRng } from "./rng.ts";
import { Vector2 } from "./vector.ts";

export interface ExplosionOptions {
  pos: Vector2;
  rng: Rng;
  count?: number;
  speed?: number;
  ttl?: number;
  color?: string;
}

// Many short-lived particles per explosion. Lab 7: they live in typed arrays
// (struct of arrays) instead of one object per particle: one allocation per
// explosion instead of 36, a dense homogeneous layout for the update loop,
// and positions that are a pure function of age (x = x0 + vx * age), so the
// client can show any age without re-simulating or re-allocating.
export class Explosion extends Entity {
  readonly kind = "explosion";
  ttl: number;
  age = 0;
  color: string;
  count: number;
  speed: number;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly maxLife: Float64Array;

  constructor({ pos, rng, count = 24, speed = 160, ttl = 0.8, color = "#ffb347" }: ExplosionOptions) {
    super({ pos, radius: 0 });
    this.collides = false;
    this.ttl = ttl;
    this.color = color;
    this.count = count;
    this.speed = speed;
    const n = Math.max(0, Math.trunc(count));
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.maxLife = new Float64Array(n);
    // Same rng calls in the same order as before: the server's world rng
    // stream (and so the determinism hash) is unchanged.
    for (let i = 0; i < n; i++) {
      const angle = rng() * Math.PI * 2;
      const v = speed * (0.3 + rng() * 0.7);
      const life = ttl * (0.5 + rng() * 0.5);
      this.vx[i] = Math.cos(angle) * v;
      this.vy[i] = Math.sin(angle) * v;
      this.maxLife[i] = life;
    }
  }

  get particleCount(): number {
    return this.vx.length;
  }

  // Particle i at the current age.
  particleX(i: number): number {
    return this.pos.x + (this.vx[i] ?? 0) * this.age;
  }

  particleY(i: number): number {
    return this.pos.y + (this.vy[i] ?? 0) * this.age;
  }

  // Remaining life as a fraction of the particle's lifetime (<= 0: gone).
  particleLife(i: number): number {
    const maxLife = this.maxLife[i] ?? 0;
    return maxLife > 0 ? (maxLife - this.age) / maxLife : 0;
  }

  // Particles are cosmetic, so they are NOT sent: the client regrows them from
  // a seed (the id) and jumps to the snapshot's age.
  static fromSnapshot(data: ExplosionSnapshot): Explosion {
    const explosion = new Explosion({
      pos: new Vector2(data.x, data.y),
      rng: createRng(Math.imul(data.id || 1, 2654435761)),
      count: data.count,
      speed: data.speed,
      color: data.color,
    });
    return explosion.applySnapshot(data);
  }

  applySnapshot(data: ExplosionSnapshot): this {
    this.id = data.id;
    this.age = data.age;
    this.alive = this.age < this.ttl;
    return this;
  }

  toSnapshot(): ExplosionSnapshot {
    return { ...this.common(), kind: "explosion", color: this.color, count: this.count, speed: this.speed, age: this.age };
  }

  override update(dt: number): void {
    this.age += dt;
    if (this.age >= this.ttl) this.alive = false;
  }
}
