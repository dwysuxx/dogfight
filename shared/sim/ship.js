import { Entity } from "./entity.js";
import { Vector2 } from "./vector.js";
import { Bullet } from "./bullet.js";
import { BULLET_HOMING, withHoming } from "./behaviors.js";
import { wrapAngle } from "./math.js";

const ROTATE_SPEED = Math.PI * 1.6; // rad/s
const THRUST_ACCEL = 260; // px/s^2
const DRAG = 0.62; // fraction of velocity lost per second
const MAX_SPEED = 320; // px/s
const BULLET_SPEED = 520; // px/s, added to the ship's own velocity
const FIRE_COOLDOWN = 0.25; // s
const RAPID_COOLDOWN = 0.09; // s
const NO_CONTROLS = Object.freeze({
  left: false,
  right: false,
  thrust: false,
  fire: false,
});

// Ship extends Entity: the only inheritance level in the project.
// `controls` is a plain {left, right, thrust, fire} object (from the keyboard
// or the bot), so the simulation never touches the DOM.
export class Ship extends Entity {
  static MAX_HP = 100;
  #hp = Ship.MAX_HP; // private: only takeDamage()/respawn() change it

  constructor({
    pos,
    angle = -Math.PI / 2,
    color = "#e8f0ff",
    name = "ship",
    damage = 20,
    hp = Ship.MAX_HP,
  } = {}) {
    super({ kind: "ship", pos, angle, radius: 12 });
    this.#hp = hp;
    this.name = name;
    this.color = color;
    this.damage = damage; // damage of this ship's bullets
    this.controls = NO_CONTROLS;
    this.effects = new Map(); // effect name -> seconds left (shield, rapidfire, homing)
    this.score = 0;
    this.thrusting = false;
    this.fireCooldown = 0;
    this.contactCooldown = 0;
    this.playerId = 0; // the room's small numeric player id (0 = bot / nobody)
    this.isBot = false;
  }

  // `players` maps playerId -> { name, color } (the client's roster).
  static fromSnapshot(data, { players } = {}) {
    const player = players?.get(data.owner);
    const ship = new Ship({
      pos: new Vector2(data.x, data.y),
      angle: data.angle,
      hp: data.hp,
      name: data.bot ? "bot" : (player?.name ?? "pilot"),
      color: data.bot ? "#ff8a8a" : (player?.color ?? "#e8f0ff"),
      damage: data.bot ? 10 : 20,
    });
    ship.id = data.id;
    ship.vel.set(data.vx, data.vy);
    ship.score = data.score;
    ship.playerId = data.owner;
    ship.isBot = data.bot;
    ship.thrusting = data.thrusting;
    ship.fireCooldown = data.fireCooldown;
    for (const [name, left] of Object.entries(data.effects)) ship.effects.set(name, left);
    return ship;
  }

  toSnapshot() {
    return {
      ...super.toSnapshot(),
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

  get hp() {
    return this.#hp;
  }

  // Returns true when this hit destroyed the ship. A shield absorbs everything.
  takeDamage(amount) {
    if (this.effects.has("shield")) return false;
    this.#hp = Math.max(0, this.#hp - amount);
    return this.#hp === 0;
  }

  respawn(pos) {
    this.#hp = Ship.MAX_HP;
    this.alive = true;
    this.vel.set(0, 0);
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
  // detaches it. See README and src/demo/this-bug.js.
  fire() {
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
    bullet.seq = this.controls.seq ?? 0;
    if (this.effects.has("homing")) withHoming(bullet, { ...BULLET_HOMING, ignoreId: this.id });
    const spawned = this.world.spawn(bullet);
    this.world.emit("fired", { ship: this, bullet });
    return spawned;
  }

  update(dt) {
    const c = this.controls;
    if (c.left) this.angle -= ROTATE_SPEED * dt;
    if (c.right) this.angle += ROTATE_SPEED * dt;
    this.angle = wrapAngle(this.angle); // bounded, so it fits the Int16 wire format

    this.thrusting = c.thrust;
    if (c.thrust)
      this.vel.addScaledInPlace(Vector2.fromAngle(this.angle), THRUST_ACCEL * dt);

    this.vel.scaleInPlace(Math.max(0, 1 - DRAG * dt));
    const speed = this.vel.length();
    if (speed > MAX_SPEED) this.vel.scaleInPlace(MAX_SPEED / speed);

    this.#tickTimers(dt);
    if (c.fire) this.fire();

    super.update(dt);
    this.wrapAround();
  }

  #tickTimers(dt) {
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.contactCooldown = Math.max(0, this.contactCooldown - dt);
    // Updating/deleting the CURRENT key while iterating a Map is safe.
    for (const [name, left] of this.effects) {
      if (left - dt <= 0) this.effects.delete(name);
      else this.effects.set(name, left - dt);
    }
  }
}
