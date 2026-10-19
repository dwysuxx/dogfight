import { createRng } from "./rng.js";
import { findCollisions } from "./collision.js";
import { resolveCollision } from "./rules.js";

const NO_INPUTS = new Map();

// The entity manager. Entities live in a Map<id, Entity> (not a plain object:
// numeric keys stay numbers, real .size, insertion order, no inherited keys).
export class World {
  #entities = new Map();
  #pending = []; // spawned during a step; added when the step ends
  #timers = [];
  #systems = [];
  #stepping = false;

  constructor({ width = 960, height = 540, seed = 1, collisions = findCollisions } = {}) {
    this.bounds = { width, height };
    this.rng = createRng(seed);
    this.collisions = collisions; // swappable: world -> iterable of [a, b]
    this.time = 0;
    this.tick = 0;
  }

  resize(width, height) {
    this.bounds = { width, height };
  }

  spawn(entity) {
    entity.world = this;
    // Mid-step spawns are deferred so we never grow the Map while iterating it.
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  // Deferred: only marks the entity dead; the sweep at the end of step() removes it.
  despawn(id) {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id) {
    return this.#entities.get(id);
  }

  get size() {
    return this.#entities.size;
  }

  // for...of over the world walks every entity without building an array.
  *[Symbol.iterator]() {
    yield* this.#entities.values();
  }

  *ofKind(kind) {
    for (const e of this) if (e.kind === kind) yield e;
  }

  countKind(kind) {
    let n = 0;
    for (const e of this.ofKind(kind)) if (e.alive) n++;
    return n;
  }

  schedule(delay, fn) {
    this.#timers.push({ left: delay, fn });
  }

  addSystem(fn) {
    this.#systems.push(fn);
  }

  // inputs: Map<entityId, {left, right, thrust, fire}>
  step(dt, inputs = NO_INPUTS) {
    this.#stepping = true;

    for (const e of this) e.savePrevious();
    for (const e of this) {
      if (!e.alive) continue;
      const controls = inputs.get(e.id);
      if (controls) e.controls = controls;
      e.update(dt);
    }

    for (const [a, b] of this.collisions(this)) {
      if (a.alive && b.alive) resolveCollision(a, b, this);
    }

    this.#runTimers(dt);
    for (const system of this.#systems) system(this, dt);

    this.#stepping = false;
    for (const e of this.#pending) this.#entities.set(e.id, e);
    this.#pending.length = 0;
    this.#sweep();

    this.time += dt;
    this.tick++;
  }

  #runTimers(dt) {
    for (const t of this.#timers) t.left -= dt;
    const due = this.#timers.filter((t) => t.left <= 0);
    this.#timers = this.#timers.filter((t) => t.left > 0);
    for (const t of due) t.fn();
  }

  #sweep() {
    const dead = [];
    for (const e of this.#entities.values()) if (!e.alive) dead.push(e);
    for (const e of dead) {
      this.#entities.delete(e.id);
      e.world = null;
    }
  }
}
