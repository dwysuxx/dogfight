import { createRng } from "./rng.js";
import { findCollisions } from "./collision.js";
import { resolveCollision } from "./rules.js";

const NO_INPUTS = new Map();

// The entity manager. Entities live in a Map<id, Entity> (not a plain object:
// numeric keys stay numbers, real .size, insertion order, no inherited keys).
export class World extends EventTarget {
  #entities = new Map();
  #pending = []; // spawned during a step; added when the step ends
  #timers = [];
  #systems = [];
  #stepping = false;
  #assignIds;
  #idPrefix;
  #nextEntityId = 1;
  #named = new WeakSet(); // entities that already received an id from this world

  constructor({
    width = 960,
    height = 540,
    seed = 1,
    collisions = findCollisions,
    idPrefix = null,
    assignIds = idPrefix !== null,
  } = {}) {
    super();
    this.bounds = { width, height };
    this.rng = createRng(seed);
    this.collisions = collisions; // swappable: world -> iterable of [a, b]
    this.#assignIds = assignIds;
    this.#idPrefix = idPrefix;
    this.time = 0;
    this.tick = 0;
  }

  resize(width, height) {
    this.bounds = { width, height };
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // With assignIds the world numbers its own entities: ids are per world (two
  // rooms never collide) and, without a prefix, fit the binary protocol's
  // Uint16. A respawned entity keeps its id; keepId adopts an id from elsewhere
  // (a server snapshot rebuilt on the client).
  spawn(entity, { keepId = false } = {}) {
    if (this.#assignIds && !keepId && !this.#named.has(entity)) entity.id = this.#newId();
    this.#named.add(entity);
    entity.world = this;
    // Mid-step spawns are deferred so we never grow the Map while iterating it.
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  #newId() {
    if (this.#idPrefix !== null) return `${this.#idPrefix}${this.#nextEntityId++}`;
    // Numeric ids wrap inside 1..65535 and skip ids that are still alive.
    for (let tries = 0; tries < 0xffff; tries++) {
      const id = this.#nextEntityId;
      this.#nextEntityId = (this.#nextEntityId % 0xffff) + 1;
      if (!this.#entities.has(id) && !this.#pending.some((e) => e.id === id)) return id;
    }
    throw new RangeError("World is out of entity ids");
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

  // inputs: Map<entityId, {left, right, thrust, fire, seq?}>
  step(dt, inputs = NO_INPUTS) {
    this.#stepping = true;

    for (const e of this) e.savePrevious();
    for (const e of this) {
      // frozen: the server had no input for this ship this tick (see Match).
      if (!e.alive || e.frozen) continue;
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
