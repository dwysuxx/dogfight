import { Vector2 } from "./vector.js";
import { runBehavior } from "./behaviors.js";

// Base class of everything that lives in the World. Inheritance is kept ONE
// level deep on purpose: Ship, Bullet, Asteroid, Pickup, Explosion all extend
// Entity directly. Anything that varies across kinds (homing, effects) is
// composed in via `behaviors`/`effects` instead of more `extends`.
export class Entity {
  static #nextId = 1;

  // Each new game starts counting from 1 again, so ids are reproducible.
  static resetIds() {
    Entity.#nextId = 1;
  }

  constructor({
    kind = "entity",
    pos = new Vector2(),
    vel = new Vector2(),
    angle = 0,
    radius = 0,
  } = {}) {
    this.id = Entity.#nextId++;
    this.kind = kind;
    this.pos = pos.clone();
    this.vel = vel.clone();
    this.angle = angle;
    this.radius = radius;
    this.alive = true;
    this.collides = true;
    this.world = null;
    this.behaviors = [];
    // The previous state is kept for the renderer's interpolation (Lab 1).
    this.prevPos = pos.clone();
    this.prevAngle = angle;
  }

  // The wire form: plain data only, so it survives structuredClone, JSON and
  // the DataView codec. Each kind adds its own fields and a static fromSnapshot.
  toSnapshot() {
    return { id: this.id, kind: this.kind, x: this.pos.x, y: this.pos.y, angle: this.angle };
  }

  savePrevious() {
    this.prevPos.copy(this.pos);
    this.prevAngle = this.angle;
  }

  update(dt) {
    for (const behavior of this.behaviors) runBehavior(this, behavior, dt);
    this.pos.addScaledInPlace(this.vel, dt);
  }

  // Move pos AND prevPos together: a jump that must not be interpolated
  // across (screen wrap, collision push-out).
  shift(offset) {
    this.pos.addInPlace(offset);
    this.prevPos.addInPlace(offset);
  }

  teleport(pos) {
    this.pos.copy(pos);
    this.prevPos.copy(pos);
  }

  // Asteroids-style wrap. Shifting prevPos by the same amount keeps the
  // interpolated motion continuous across the seam (no streak across the screen).
  wrapAround(margin = this.radius) {
    const bounds = this.world?.bounds;
    if (!bounds) return;
    const spanX = bounds.width + 2 * margin;
    const spanY = bounds.height + 2 * margin;
    if (this.pos.x < -margin) this.shift(new Vector2(spanX, 0));
    else if (this.pos.x > bounds.width + margin) this.shift(new Vector2(-spanX, 0));
    if (this.pos.y < -margin) this.shift(new Vector2(0, spanY));
    else if (this.pos.y > bounds.height + margin) this.shift(new Vector2(0, -spanY));
  }
}
