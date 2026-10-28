// Client-side prediction + server reconciliation (Gambetta, parts 2 and 3).
//
// The client owns a tiny private World holding only what it can predict: its
// own ship and its own bullets. Every local input is applied immediately with
// the SAME Ship/Bullet code the server runs, so the ship responds at once.
// When a snapshot arrives:
//   1. reset own ship + own bullets to the server's authoritative state,
//   2. drop pending inputs with seq <= ack (the server has applied them),
//   3. replay the remaining inputs in order.
// If the prediction was right the result equals the old prediction and
// nothing moves; the difference is the "correction", which is shown in the
// netgraph and hidden visually by a decaying offset (smoothing).
import { Bullet } from "../sim/bullet.js";
import { Ship } from "../sim/ship.js";
import { Vector2 } from "../sim/vector.js";
import { World } from "../sim/world.js";
import { TICK_SECONDS } from "../protocol/messages.js";

const NO_COLLISIONS = () => [];
const MAX_PENDING = 90; // 3 s of inputs; beyond that the server is not listening
const SNAP_DISTANCE = 120; // bigger corrections are teleports (respawn), not errors
const SMOOTHING_SECONDS = 0.04; // offset time constant: ~95% gone after 120 ms

export class Predictor {
  #world;
  #ship = null;
  #pending = [];
  #lastTick = -1;
  #replaying = false;

  constructor({ bounds, playerId, players = new Map(), dt = TICK_SECONDS, perturb = null, onFire = null }) {
    this.bounds = bounds;
    this.playerId = playerId;
    this.players = players; // playerId -> { name, color }, kept current by the caller
    this.dt = dt;
    this.perturb = perturb; // the determinism-break experiment hooks in here
    this.onFire = onFire;
    this.offset = new Vector2(); // visual-only smoothing offset for the own ship
    this.lastCorrection = 0;
    this.#world = this.#createWorld();
  }

  get ship() {
    return this.#ship?.alive ? this.#ship : null;
  }

  get pendingCount() {
    return this.#pending.length;
  }

  *entities() {
    for (const entity of this.#world) if (entity.alive) yield entity;
  }

  // Called once per client simulation step with the input just sent.
  applyInput(seq, controls) {
    this.#pending.push({ seq, controls });
    if (this.#pending.length > MAX_PENDING) this.#pending.shift();
    this.#step(seq, controls);
  }

  // Returns the correction in px, or null when the snapshot was stale.
  reconcile(state) {
    if (state.tick <= this.#lastTick) return null;
    this.#lastTick = state.tick;
    const before = this.ship ? this.ship.pos.clone() : null;

    while (this.#pending.length && this.#pending[0].seq <= state.ack) this.#pending.shift();

    this.#world = this.#createWorld();
    const shipData = state.entities.find(
      (e) => e.kind === "ship" && !e.bot && e.owner === this.playerId,
    );
    this.#ship = shipData ? Ship.fromSnapshot(shipData, { players: this.players }) : null;
    if (this.#ship) this.#world.spawn(this.#ship, { keepId: true });
    for (const data of state.entities) {
      if (data.kind !== "bullet" || data.owner !== this.playerId) continue;
      this.#world.spawn(Bullet.fromSnapshot(data, { owner: this.#ship }), { keepId: true });
    }

    this.#replaying = true;
    for (const { seq, controls } of this.#pending) this.#step(seq, controls);
    this.#replaying = false;

    if (!before || !this.ship) {
      this.lastCorrection = 0;
      this.offset.set(0, 0);
      return 0;
    }
    const error = this.#wrappedDelta(before, this.ship.pos);
    this.lastCorrection = error.length();
    if (this.lastCorrection > SNAP_DISTANCE) this.offset.set(0, 0);
    else this.offset.addInPlace(error);
    return this.lastCorrection;
  }

  // Decay the smoothing offset; call once per rendered frame.
  smooth(frameSeconds) {
    this.offset.scaleInPlace(Math.exp(-frameSeconds / SMOOTHING_SECONDS));
    if (this.offset.lengthSq() < 1e-4) this.offset.set(0, 0);
  }

  #step(seq, controls) {
    const inputs = this.#ship ? new Map([[this.#ship.id, { ...controls, seq }]]) : undefined;
    this.#world.step(this.dt, inputs);
    if (this.perturb && this.ship) this.perturb(this.ship);
  }

  #createWorld() {
    // No collisions: hits, pickups and asteroid bumps are the server's call,
    // and show up as corrections. "p" ids keep fresh predicted bullets from
    // colliding with server ids in the world's Map.
    const world = new World({
      width: this.bounds.width,
      height: this.bounds.height,
      collisions: NO_COLLISIONS,
      idPrefix: "p",
    });
    world.addEventListener("fired", (event) => {
      if (!this.#replaying) this.onFire?.(event.detail);
    });
    return world;
  }

  // before - after, taking the shortest way across the wrap-around seam.
  #wrappedDelta(before, after) {
    const delta = before.sub(after);
    const margin = this.#ship.radius * 2;
    const spanX = this.bounds.width + margin;
    const spanY = this.bounds.height + margin;
    if (delta.x > spanX / 2) delta.x -= spanX;
    else if (delta.x < -spanX / 2) delta.x += spanX;
    if (delta.y > spanY / 2) delta.y -= spanY;
    else if (delta.y < -spanY / 2) delta.y += spanY;
    return delta;
  }
}
