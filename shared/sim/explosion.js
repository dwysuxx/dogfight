import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { createRng } from "./rng.js";

// Many short-lived objects: each explosion owns a bunch of particles. It is
// one entity (not collidable) so the World stays small — but it is exactly the
// kind of churn Lab 7 will measure.
export class Explosion extends Entity {
  constructor({ pos, rng, count = 24, speed = 160, ttl = 0.8, color = "#ffb347" }) {
    super({ kind: "explosion", pos, radius: 0 });
    this.collides = false;
    this.ttl = ttl;
    this.age = 0;
    this.color = color;
    this.count = count;
    this.speed = speed;
    this.particles = Array.from({ length: count }, () => {
      const angle = rng() * Math.PI * 2;
      const v = speed * (0.3 + rng() * 0.7);
      const life = ttl * (0.5 + rng() * 0.5);
      return {
        x: pos.x,
        y: pos.y,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v,
        life,
        maxLife: life,
      };
    });
  }

  // Particles are cosmetic, so they are NOT sent: the client regrows them from
  // a seed (the id) and fast-forwards to the snapshot's age. 36 particles x 6
  // numbers would otherwise be most of every snapshot.
  static fromSnapshot(data) {
    const explosion = new Explosion({
      pos: new Vector2(data.x, data.y),
      rng: createRng(Math.imul(Number(data.id) || 1, 2654435761)),
      count: data.count,
      speed: data.speed,
      color: data.color,
    });
    explosion.id = data.id;
    if (data.age > 0) explosion.update(data.age);
    return explosion;
  }

  toSnapshot() {
    return {
      ...super.toSnapshot(),
      color: this.color,
      count: this.count,
      speed: this.speed,
      age: this.age,
    };
  }

  update(dt) {
    this.age += dt;
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    if (this.age >= this.ttl) this.alive = false;
  }
}
