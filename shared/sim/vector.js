// Vector2: the "pure" methods (add, sub, scale, normalize, rotate) return a
// NEW vector, so `a.add(b)` never mutates `a`. The *InPlace variants exist for
// hot paths (per-entity, per-step integration) where allocating is wasteful.
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  clone() {
    return new Vector2(this.x, this.y);
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }

  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }

  dot(v) {
    return this.x * v.x + this.y * v.y;
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y;
  }

  length() {
    return Math.hypot(this.x, this.y);
  }

  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y);
  }

  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2() : this.scale(1 / len);
  }

  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  // --- in-place variants (mutate and return `this`) ---

  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }

  copy(v) {
    this.x = v.x;
    this.y = v.y;
    return this;
  }

  addInPlace(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }

  addScaledInPlace(v, k) {
    this.x += v.x * k;
    this.y += v.y * k;
    return this;
  }

  scaleInPlace(k) {
    this.x *= k;
    this.y *= k;
    return this;
  }
}
