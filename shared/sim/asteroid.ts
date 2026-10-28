import type { AsteroidSnapshot } from "../protocol.ts";
import { withHoming } from "./behaviors.ts";
import { Entity } from "./entity.ts";
import type { Rng } from "./rng.ts";
import { Vector2 } from "./vector.ts";

export interface AsteroidOptions {
  pos: Vector2;
  vel: Vector2;
  radius: number;
  spin?: number;
  // Either an rng to draw the outline from, or the outline itself.
  rng?: Rng;
  shape?: readonly number[];
  hp?: number;
}

export class Asteroid extends Entity {
  readonly kind = "asteroid";
  #hp: number;
  maxHp: number;
  spin: number;
  readonly shape: readonly number[];

  constructor({ pos, vel, radius, spin = 0, rng, shape, hp }: AsteroidOptions) {
    super({ pos, vel, radius });
    this.maxHp = Math.round(radius);
    this.#hp = hp ?? this.maxHp;
    this.spin = spin;
    // Visual outline only; drawn from the seeded rng so it is reproducible.
    this.shape = shape ?? Array.from({ length: 11 }, () => 0.75 + (rng ? rng() : 0.5) * 0.4);
  }

  static fromSnapshot(data: AsteroidSnapshot): Asteroid {
    const asteroid = new Asteroid({
      pos: new Vector2(data.x, data.y),
      vel: new Vector2(),
      radius: data.radius,
      shape: data.shape,
      hp: data.hp,
    });
    return asteroid.applySnapshot(data);
  }

  // The outline never changes for an id, so only the live fields are copied.
  applySnapshot(data: AsteroidSnapshot): this {
    this.id = data.id;
    this.angle = data.angle;
    this.radius = data.radius;
    this.#hp = data.hp;
    this.maxHp = data.maxHp;
    if (!data.homing) this.behaviors.length = 0;
    else if (this.behaviors.length === 0) withHoming(this, { targets: ["ship"] });
    return this;
  }

  toSnapshot(): AsteroidSnapshot {
    return {
      ...this.common(),
      kind: "asteroid",
      radius: this.radius,
      hp: this.#hp,
      maxHp: this.maxHp,
      homing: this.behaviors.length > 0,
      shape: this.shape,
    };
  }

  get hp(): number {
    return this.#hp;
  }

  // Returns true when this hit destroyed the asteroid.
  takeDamage(amount: number): boolean {
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  override update(dt: number): void {
    super.update(dt);
    this.angle += this.spin * dt;
    this.#bounce();
  }

  // Asteroids bounce off the arena edges (ships and bullets wrap instead).
  #bounce(): void {
    const b = this.world?.bounds;
    if (!b) return;
    const r = this.radius;
    if (this.pos.x - r < 0 && this.vel.x < 0) this.vel = this.vel.withX(-this.vel.x);
    else if (this.pos.x + r > b.width && this.vel.x > 0) this.vel = this.vel.withX(-this.vel.x);
    if (this.pos.y - r < 0 && this.vel.y < 0) this.vel = this.vel.withY(-this.vel.y);
    else if (this.pos.y + r > b.height && this.vel.y > 0) this.vel = this.vel.withY(-this.vel.y);
  }
}
