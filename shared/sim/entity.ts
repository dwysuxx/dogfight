import { type EntityId, type Seq, entityId } from "../brand.ts";
import type { EntityKind } from "../protocol.ts";
import { type Behavior, runBehavior } from "./behaviors.ts";
import { Vector2 } from "./vector.ts";
import type { World } from "./world.ts";

// What drives a ship for one step: the keyboard, the bot, or a network input
// (which also carries the seq the client numbered it with).
export interface StepControls {
  readonly left: boolean;
  readonly right: boolean;
  readonly thrust: boolean;
  readonly fire: boolean;
  readonly seq?: Seq;
}

export interface Bounds {
  readonly width: number;
  readonly height: number;
}

export interface EntityOptions {
  pos?: Vector2;
  vel?: Vector2;
  angle?: number;
  radius?: number;
}

// Base class of everything that lives in the World. Inheritance is kept ONE
// level deep on purpose: Ship, Bullet, Asteroid, Pickup, Explosion all extend
// Entity directly. Anything that varies across kinds (homing, effects) is
// composed in via `behaviors`/`effects` instead of more `extends`.
// Each subclass narrows `kind` to its literal, which makes the GameEntity
// union (world.ts) a discriminated union.
export abstract class Entity {
  static #nextId = 1;

  // Each new game starts counting from 1 again, so ids are reproducible.
  static resetIds(): void {
    Entity.#nextId = 1;
  }

  abstract readonly kind: EntityKind;
  id: EntityId;
  pos: Vector2;
  vel: Vector2;
  angle: number;
  radius: number;
  alive = true;
  collides = true;
  frozen = false; // the server had no input for this ship this tick (see Match)
  world: World | null = null;
  behaviors: Behavior[] = [];
  // The previous state is kept for the renderer's interpolation (Lab 1).
  prevPos: Vector2;
  prevAngle: number;

  constructor({ pos = new Vector2(), vel = new Vector2(), angle = 0, radius = 0 }: EntityOptions = {}) {
    this.id = entityId(Entity.#nextId);
    Entity.#nextId = (Entity.#nextId % 0xffff) + 1; // u16 ids wrap
    this.pos = pos;
    this.vel = vel;
    this.angle = angle;
    this.radius = radius;
    this.prevPos = pos;
    this.prevAngle = angle;
  }

  // The fields every snapshot shares; each kind adds its own in toSnapshot().
  protected common(): { id: EntityId; x: number; y: number; angle: number } {
    return { id: this.id, x: this.pos.x, y: this.pos.y, angle: this.angle };
  }

  savePrevious(): void {
    this.prevPos = this.pos;
    this.prevAngle = this.angle;
  }

  update(dt: number): void {
    for (const behavior of this.behaviors) runBehavior(this, behavior, dt);
    this.pos = this.pos.addScaled(this.vel, dt);
  }

  // Move pos AND prevPos together: a jump that must not be interpolated
  // across (screen wrap, collision push-out).
  shift(offset: Vector2): void {
    this.pos = this.pos.add(offset);
    this.prevPos = this.prevPos.add(offset);
  }

  teleport(pos: Vector2): void {
    this.pos = pos;
    this.prevPos = pos;
  }

  // Asteroids-style wrap. Shifting prevPos by the same amount keeps the
  // interpolated motion continuous across the seam (no streak across the screen).
  wrapAround(margin = this.radius): void {
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
