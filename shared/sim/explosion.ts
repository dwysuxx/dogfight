import type { ExplosionSnapshot } from "../protocol.ts";
import { Entity } from "./entity.ts";
import { type Rng, createRng } from "./rng.ts";
import { Vector2 } from "./vector.ts";

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
}

export interface ExplosionOptions {
  pos: Vector2;
  rng: Rng;
  count?: number;
  speed?: number;
  ttl?: number;
  color?: string;
}

// Many short-lived objects: each explosion owns a bunch of particles. It is
// one entity (not collidable) so the World stays small — but it is exactly the
// kind of churn Lab 7 will measure.
export class Explosion extends Entity {
  readonly kind = "explosion";
  ttl: number;
  age = 0;
  color: string;
  count: number;
  speed: number;
  readonly particles: Particle[];

  constructor({ pos, rng, count = 24, speed = 160, ttl = 0.8, color = "#ffb347" }: ExplosionOptions) {
    super({ pos, radius: 0 });
    this.collides = false;
    this.ttl = ttl;
    this.color = color;
    this.count = count;
    this.speed = speed;
    this.particles = Array.from({ length: count }, () => {
      const angle = rng() * Math.PI * 2;
      const v = speed * (0.3 + rng() * 0.7);
      const life = ttl * (0.5 + rng() * 0.5);
      return { x: pos.x, y: pos.y, vx: Math.cos(angle) * v, vy: Math.sin(angle) * v, life, maxLife: life };
    });
  }

  // Particles are cosmetic, so they are NOT sent: the client regrows them from
  // a seed (the id) and fast-forwards to the snapshot's age. 36 particles x 6
  // numbers would otherwise be most of every snapshot.
  static fromSnapshot(data: ExplosionSnapshot): Explosion {
    const explosion = new Explosion({
      pos: new Vector2(data.x, data.y),
      rng: createRng(Math.imul(data.id || 1, 2654435761)),
      count: data.count,
      speed: data.speed,
      color: data.color,
    });
    explosion.id = data.id;
    if (data.age > 0) explosion.update(data.age);
    return explosion;
  }

  toSnapshot(): ExplosionSnapshot {
    return { ...this.common(), kind: "explosion", color: this.color, count: this.count, speed: this.speed, age: this.age };
  }

  override update(dt: number): void {
    this.age += dt;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    if (this.age >= this.ttl) this.alive = false;
  }
}
