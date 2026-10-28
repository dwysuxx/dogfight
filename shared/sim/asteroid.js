import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { withHoming } from "./behaviors.js";

export class Asteroid extends Entity {
  #hp;

  constructor({ pos, vel, radius, spin = 0, rng, shape, hp }) {
    super({ kind: "asteroid", pos, vel, radius });
    this.maxHp = Math.round(radius);
    this.#hp = hp ?? this.maxHp;
    this.spin = spin;
    // Visual outline only; drawn from the seeded rng so it is reproducible.
    this.shape = shape ?? Array.from({ length: 11 }, () => 0.75 + rng() * 0.4);
  }

  static fromSnapshot(data) {
    const asteroid = new Asteroid({
      pos: new Vector2(data.x, data.y),
      vel: new Vector2(),
      radius: data.radius,
      shape: data.shape,
      hp: data.hp,
    });
    asteroid.id = data.id;
    asteroid.angle = data.angle;
    asteroid.maxHp = data.maxHp;
    if (data.homing) withHoming(asteroid, { targets: ["ship"] });
    return asteroid;
  }

  toSnapshot() {
    return {
      ...super.toSnapshot(),
      radius: this.radius,
      hp: this.#hp,
      maxHp: this.maxHp,
      homing: this.behaviors.length > 0,
      shape: this.shape,
    };
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
