import { Entity } from "./entity.js";

export class Asteroid extends Entity {
  #hp;

  constructor({ pos, vel, radius, spin = 0, rng }) {
    super({ kind: "asteroid", pos, vel, radius });
    this.#hp = Math.round(radius);
    this.maxHp = this.#hp;
    this.spin = spin;
    // Visual outline only; drawn from the seeded rng so it is reproducible.
    this.shape = Array.from({ length: 11 }, () => 0.75 + rng() * 0.4);
  }

  get hp() {
    return this.#hp;
  }

  // Returns true when this hit destroyed the asteroid.
  takeDamage(amount) {
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  update(dt) {
    super.update(dt);
    this.angle += this.spin * dt;
    this.#bounce();
  }

  // Asteroids bounce off the arena edges (ships and bullets wrap instead).
  #bounce() {
    const b = this.world?.bounds;
    if (!b) return;
    const r = this.radius;
    if (this.pos.x - r < 0 && this.vel.x < 0) this.vel.x = -this.vel.x;
    else if (this.pos.x + r > b.width && this.vel.x > 0) this.vel.x = -this.vel.x;
    if (this.pos.y - r < 0 && this.vel.y < 0) this.vel.y = -this.vel.y;
    else if (this.pos.y + r > b.height && this.vel.y > 0) this.vel.y = -this.vel.y;
  }
}
