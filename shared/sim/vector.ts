// Vector2 is immutable: x and y are readonly and every method returns a NEW
// vector, so `a.add(b)` can never change `a` (the Lab 2 convention, now
// enforced by the compiler). Entities move by replacing their vectors:
// `this.pos = this.pos.addScaled(this.vel, dt)`.
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }

  // this + v * k, with exactly the arithmetic of the old addScaledInPlace
  // (determinism: the same float operations in the same order).
  addScaled(v: Vector2, k: number): Vector2 {
    return new Vector2(this.x + v.x * k, this.y + v.y * k);
  }

  withX(x: number): Vector2 {
    return new Vector2(x, this.y);
  }

  withY(y: number): Vector2 {
    return new Vector2(this.x, y);
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y;
  }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  distanceTo(v: Vector2): number {
    return Math.hypot(this.x - v.x, this.y - v.y);
  }

  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? new Vector2() : this.scale(1 / len);
  }

  rotate(angle: number): Vector2 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
}
