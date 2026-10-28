import { NO_PLAYER, NO_SEQ, type PlayerId } from "../brand.ts";
import { type EffectName, NO_CONTROLS, type ShipSnapshot } from "../protocol.ts";
import { BULLET_HOMING, withHoming } from "./behaviors.ts";
import { Bullet } from "./bullet.ts";
import { Entity, type StepControls } from "./entity.ts";
import { wrapAngle } from "./math.ts";
import { Vector2 } from "./vector.ts";

const ROTATE_SPEED = Math.PI * 1.6; // rad/s
const THRUST_ACCEL = 260; // px/s^2
const DRAG = 0.62; // fraction of velocity lost per second
const MAX_SPEED = 320; // px/s
const BULLET_SPEED = 520; // px/s, added to the ship's own velocity
const FIRE_COOLDOWN = 0.25; // s
const RAPID_COOLDOWN = 0.09; // s

export interface ShipOptions {
  pos?: Vector2;
  angle?: number;
  color?: string;
  name?: string;
  damage?: number;
  hp?: number;
}

// playerId -> how to show that player (the client's roster).
export type PlayerLookup = ReadonlyMap<PlayerId, { readonly name: string; readonly color: string }>;

// Ship extends Entity: the only inheritance level in the project.
// `controls` is a plain {left, right, thrust, fire} object (from the keyboard,
// the bot or the network), so the simulation never touches the DOM.
export class Ship extends Entity {
  static readonly MAX_HP = 100;
  readonly kind = "ship";
  #hp: number; // private: only takeDamage()/respawn() change it
  name: string;
  color: string;
  damage: number; // damage of this ship's bullets
  controls: StepControls = NO_CONTROLS;
  effects = new Map<EffectName, number>(); // effect -> seconds left
  score = 0;
  thrusting = false;
  fireCooldown = 0;
  contactCooldown = 0;
  playerId: PlayerId = NO_PLAYER; // the room's small numeric player id (0 = bot / nobody)
  isBot = false;

  constructor({ pos, angle = -Math.PI / 2, color = "#e8f0ff", name = "ship", damage = 20, hp = Ship.MAX_HP }: ShipOptions = {}) {
    super({ pos, angle, radius: 12 });
    this.#hp = hp;
    this.name = name;
    this.color = color;
    this.damage = damage;
  }

  static fromSnapshot(data: ShipSnapshot, context: { players?: PlayerLookup } = {}): Ship {
    return new Ship({ pos: new Vector2(data.x, data.y), angle: data.angle }).applySnapshot(data, context);
  }

  // Everything except the position, in place: the renderer keeps one Ship per
  // id and places it itself (interpolated), instead of a new Ship per frame.
  applySnapshot(data: ShipSnapshot, { players }: { players?: PlayerLookup } = {}): this {
    const player = players?.get(data.owner);
    this.id = data.id;
    this.angle = data.angle;
    this.#hp = data.hp;
    this.name = data.bot ? "bot" : (player?.name ?? "pilot");
    this.color = data.bot ? "#ff8a8a" : (player?.color ?? "#e8f0ff");
    this.damage = data.bot ? 10 : 20;
    if (this.vel.x !== data.vx || this.vel.y !== data.vy) this.vel = new Vector2(data.vx, data.vy);
    this.score = data.score;
    this.playerId = data.owner;
    this.isBot = data.bot;
    this.thrusting = data.thrusting;
    this.fireCooldown = data.fireCooldown;
    this.effects.clear();
    for (const name of EFFECT_LIST) {
      const left = data.effects[name];
      if (left !== undefined) this.effects.set(name, left);
    }
    return this;
  }

  toSnapshot(): ShipSnapshot {
    return {
      ...this.common(),
      kind: "ship",
      vx: this.vel.x,
      vy: this.vel.y,
      hp: this.#hp,
      score: this.score,
      owner: this.playerId,
      bot: this.isBot,
      thrusting: this.thrusting,
      fireCooldown: this.fireCooldown,
      effects: Object.fromEntries(this.effects),
    };
  }

  get hp(): number {
    return this.#hp;
  }

  // Returns true when this hit destroyed the ship. A shield absorbs everything.
  takeDamage(amount: number): boolean {
    if (this.effects.has("shield")) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  respawn(pos: Vector2): void {
    this.#hp = Ship.MAX_HP;
    this.alive = true;
    this.vel = new Vector2(0, 0);
    this.teleport(pos);
    this.angle = this.prevAngle = -Math.PI / 2;
    this.effects.clear();
    this.effects.set("shield", 2); // short invulnerability after respawn
    this.fireCooldown = 0;
    this.contactCooldown = 0;
    this.thrusting = false;
  }

  // NOTE (the `this` bug): this method reads `this.alive`/`this.world`, so it
  // only works when called as `ship.fire()`. Passing `ship.fire` as a callback
  // detaches it. See README and src/demo/this-bug.ts.
  fire(): Bullet | null {
    if (!this.alive || !this.world || this.fireCooldown > 0) return null;
    const rapid = this.effects.has("rapidfire");
    this.fireCooldown = rapid ? RAPID_COOLDOWN : FIRE_COOLDOWN;

    const dir = Vector2.fromAngle(this.angle);
    const bullet = new Bullet({
      pos: this.pos.add(dir.scale(this.radius + 5)),
      vel: this.vel.add(dir.scale(BULLET_SPEED)), // inherits the ship's velocity
      owner: this,
      damage: this.damage,
    });
    // The input that fired it: the client's predicted bullet and the server's
    // authoritative one are matched by (owner, seq).
    bullet.seq = this.controls.seq ?? NO_SEQ;
    if (this.effects.has("homing")) withHoming(bullet, { ...BULLET_HOMING, ignoreId: this.id });
    const spawned = this.world.spawn(bullet);
    this.world.events.emit("fired", { ship: this, bullet });
    return spawned;
  }

  override update(dt: number): void {
    const c = this.controls;
    if (c.left) this.angle -= ROTATE_SPEED * dt;
    if (c.right) this.angle += ROTATE_SPEED * dt;
    this.angle = wrapAngle(this.angle); // bounded, so it fits the Int16 wire format

    this.thrusting = c.thrust;
    if (c.thrust) this.vel = this.vel.addScaled(Vector2.fromAngle(this.angle), THRUST_ACCEL * dt);

    this.vel = this.vel.scale(Math.max(0, 1 - DRAG * dt));
    const speed = this.vel.length();
    if (speed > MAX_SPEED) this.vel = this.vel.scale(MAX_SPEED / speed);

    this.#tickTimers(dt);
    if (c.fire) this.fire();

    super.update(dt);
    this.wrapAround();
  }

  #tickTimers(dt: number): void {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.contactCooldown = Math.max(0, this.contactCooldown - dt);
    // Updating/deleting the CURRENT key while iterating a Map is safe.
    this.effects.forEach(this.#tickEffect, dt); // forEach: no iterator objects per step
  }

  #tickEffect = function (this: number, left: number, name: EffectName, effects: Map<EffectName, number>): void {
    if (left - this <= 0) effects.delete(name);
    else effects.set(name, left - this);
  }
}

const EFFECT_LIST: readonly EffectName[] = ["shield", "rapidfire", "homing"];
const EFFECTS: ReadonlySet<string> = new Set<EffectName>(EFFECT_LIST);
export const isEffect = (name: string): name is EffectName => EFFECTS.has(name);
