import { type EntityId, type Tick, isEntityId, tick } from "../brand.ts";
import { Bus } from "../bus.ts";
import type { Asteroid } from "./asteroid.ts";
import type { Bullet } from "./bullet.ts";
import { type CollisionSystem, findCollisions } from "./collision.ts";
import type { Bounds, StepControls } from "./entity.ts";
import type { Explosion } from "./explosion.ts";
import type { Pickup } from "./pickup.ts";
import { type Rng, createRng } from "./rng.ts";
import { resolveCollision } from "./rules.ts";
import type { Ship } from "./ship.ts";

// Everything that can live in a World: a discriminated union on `kind`, so a
// `switch (entity.kind)` narrows to the concrete class.
export type GameEntity = Ship | Bullet | Asteroid | Pickup | Explosion;

// The world's events, typed: the name decides the payload.
export type WorldEvents = {
  fired: { ship: Ship; bullet: Bullet };
  hit: { target: GameEntity; bullet?: Bullet; source?: GameEntity };
  exploded: { entity: GameEntity };
  scoreChanged: { ship: Ship; score: number };
  respawned: { ship: Ship };
};

export type System = (world: World, dt: number) => void;
export type StepInputs = ReadonlyMap<EntityId, StepControls>;

const NO_INPUTS: StepInputs = new Map();

export interface WorldOptions {
  width?: number;
  height?: number;
  seed?: number;
  collisions?: CollisionSystem;
  assignIds?: boolean;
}

// The entity manager. Entities live in a Map<id, Entity> (not a plain object:
// numeric keys stay numbers, real .size, insertion order, no inherited keys).
export class World {
  readonly events = new Bus<WorldEvents>();
  bounds: Bounds;
  readonly rng: Rng;
  collisions: CollisionSystem;
  time = 0;
  tick: Tick = tick(0);
  #entities = new Map<EntityId, GameEntity>();
  #pending: GameEntity[] = []; // spawned during a step; added when the step ends
  #timers: { left: number; fn: () => void }[] = [];
  #systems: System[] = [];
  #stepping = false;
  #assignIds: boolean;
  #nextEntityId = 1;
  #named = new WeakSet<GameEntity>(); // entities that already received an id from this world

  constructor({ width = 960, height = 540, seed = 1, collisions = findCollisions, assignIds = false }: WorldOptions = {}) {
    this.bounds = { width, height };
    this.rng = createRng(seed);
    this.collisions = collisions; // swappable: world -> iterable of [a, b]
    this.#assignIds = assignIds;
  }

  resize(width: number, height: number): void {
    this.bounds = { width, height };
  }

  // With assignIds the world numbers its own entities: ids are per world (two
  // rooms never collide) and fit the binary protocol's u16. A respawned
  // entity keeps its id; keepId adopts an id from elsewhere (a server
  // snapshot rebuilt on the client).
  spawn<T extends GameEntity>(entity: T, { keepId = false }: { keepId?: boolean } = {}): T {
    if (this.#assignIds && !keepId && !this.#named.has(entity)) entity.id = this.#newId();
    this.#named.add(entity);
    entity.world = this;
    // Mid-step spawns are deferred so we never grow the Map while iterating it.
    if (this.#stepping) this.#pending.push(entity);
    else this.#entities.set(entity.id, entity);
    return entity;
  }

  #newId(): EntityId {
    // Numeric ids wrap inside 1..65535 and skip ids that are still alive.
    for (let tries = 0; tries < 0xffff; tries++) {
      const id = this.#nextEntityId;
      this.#nextEntityId = (this.#nextEntityId % 0xffff) + 1;
      if (isEntityId(id) && !this.#entities.has(id) && !this.#pending.some((e) => e.id === id)) return id;
    }
    throw new RangeError("World is out of entity ids");
  }

  // Deferred: only marks the entity dead; the sweep at the end of step() removes it.
  despawn(id: EntityId): void {
    const entity = this.#entities.get(id);
    if (entity) entity.alive = false;
  }

  get(id: EntityId): GameEntity | undefined {
    return this.#entities.get(id);
  }

  get size(): number {
    return this.#entities.size;
  }

  // for...of over the world walks every entity without building an array.
  *[Symbol.iterator](): Generator<GameEntity> {
    yield* this.#entities.values();
  }

  // Narrowed by kind: ofKind("ship") yields Ship, not GameEntity.
  *ofKind<K extends GameEntity["kind"]>(kind: K): Generator<Extract<GameEntity, { kind: K }>> {
    for (const e of this) if (isKind(e, kind)) yield e;
  }

  countKind(kind: GameEntity["kind"]): number {
    let n = 0;
    for (const e of this.ofKind(kind)) if (e.alive) n++;
    return n;
  }

  schedule(delay: number, fn: () => void): void {
    this.#timers.push({ left: delay, fn });
  }

  addSystem(fn: System): void {
    this.#systems.push(fn);
  }

  step(dt: number, inputs: StepInputs = NO_INPUTS): void {
    this.#stepping = true;

    for (const e of this) e.savePrevious();
    for (const e of this) {
      if (!e.alive || e.frozen) continue;
      if (e.kind === "ship") {
        const controls = inputs.get(e.id);
        if (controls) e.controls = controls;
      }
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
    this.tick = tick(this.tick + 1);
  }

  #runTimers(dt: number): void {
    for (const t of this.#timers) t.left -= dt;
    const due = this.#timers.filter((t) => t.left <= 0);
    this.#timers = this.#timers.filter((t) => t.left > 0);
    for (const t of due) t.fn();
  }

  #sweep(): void {
    const dead: GameEntity[] = [];
    for (const e of this.#entities.values()) if (!e.alive) dead.push(e);
    for (const e of dead) {
      this.#entities.delete(e.id);
      e.world = null;
    }
  }
}

// A type guard over the discriminant, so ofKind can narrow without a cast.
export function isKind<K extends GameEntity["kind"]>(e: GameEntity, kind: K): e is Extract<GameEntity, { kind: K }> {
  return e.kind === kind;
}
