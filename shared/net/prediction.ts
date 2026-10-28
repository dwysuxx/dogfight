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
import type { PlayerId, Seq, Tick } from "../brand.ts";
import { type Controls, type StateMessage, TICK_SECONDS } from "../protocol.ts";
import { Bullet } from "../sim/bullet.ts";
import type { Bounds } from "../sim/entity.ts";
import { type PlayerLookup, Ship } from "../sim/ship.ts";
import { Vector2 } from "../sim/vector.ts";
import { type GameEntity, World, type WorldEvents } from "../sim/world.ts";

const NO_COLLISIONS = () => [];
const MAX_PENDING = 90; // 3 s of inputs; beyond that the server is not listening
const SNAP_DISTANCE = 120; // bigger corrections are teleports (respawn), not errors
const SMOOTHING_SECONDS = 0.04; // offset time constant: ~95% gone after 120 ms

export interface PredictorOptions {
  bounds: Bounds;
  playerId: PlayerId;
  players?: PlayerLookup;
  dt?: number;
  perturb?: ((ship: Ship) => void) | null;
  onFire?: ((event: WorldEvents["fired"]) => void) | null;
}

export class Predictor {
  readonly bounds: Bounds;
  readonly playerId: PlayerId;
  readonly players: PlayerLookup; // kept current by the caller
  readonly dt: number;
  readonly perturb: ((ship: Ship) => void) | null; // the determinism-break experiment
  readonly onFire: ((event: WorldEvents["fired"]) => void) | null;
  offset = new Vector2(); // visual-only smoothing offset for the own ship
  lastCorrection = 0;
  #world: World;
  #ship: Ship | null = null;
  #pending: { seq: Seq; controls: Controls }[] = [];
  #lastTick = -1;
  #replaying = false;

  constructor({ bounds, playerId, players = new Map(), dt = TICK_SECONDS, perturb = null, onFire = null }: PredictorOptions) {
    this.bounds = bounds;
    this.playerId = playerId;
    this.players = players;
    this.dt = dt;
    this.perturb = perturb;
    this.onFire = onFire;
    this.#world = this.#createWorld();
  }

  get ship(): Ship | null {
    return this.#ship?.alive ? this.#ship : null;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  *entities(): Generator<GameEntity> {
    for (const entity of this.#world) if (entity.alive) yield entity;
  }

  // Called once per client simulation step with the input just sent.
  applyInput(seq: Seq, controls: Controls): void {
    this.#pending.push({ seq, controls });
    if (this.#pending.length > MAX_PENDING) this.#pending.shift();
    this.#step(seq, controls);
  }

  // Returns the correction in px, or null when the snapshot was stale.
  reconcile(state: StateMessage): number | null {
    if (state.tick <= this.#lastTick) return null;
    this.#lastTick = state.tick satisfies Tick;
    const before = this.ship?.pos ?? null;

    while (this.#pending.length && (this.#pending[0]?.seq ?? Infinity) <= state.ack) this.#pending.shift();

    this.#world = this.#createWorld();
    const shipData = state.entities.find((e) => e.kind === "ship" && !e.bot && e.owner === this.playerId);
    this.#ship = shipData?.kind === "ship" ? Ship.fromSnapshot(shipData, { players: this.players }) : null;
    if (this.#ship) this.#world.spawn(this.#ship, { keepId: true });
    for (const data of state.entities) {
      if (data.kind !== "bullet" || data.owner !== this.playerId) continue;
      this.#world.spawn(Bullet.fromSnapshot(data, { owner: this.#ship }), { keepId: true });
    }

    this.#replaying = true;
    for (const { seq, controls } of this.#pending) this.#step(seq, controls);
    this.#replaying = false;

    const after = this.ship;
    if (!before || !after) {
      this.lastCorrection = 0;
      this.offset = new Vector2();
      return 0;
    }
    const error = this.#wrappedDelta(before, after);
    this.lastCorrection = error.length();
    this.offset = this.lastCorrection > SNAP_DISTANCE ? new Vector2() : this.offset.add(error);
    return this.lastCorrection;
  }

  // Decay the smoothing offset; call once per rendered frame.
  smooth(frameSeconds: number): void {
    this.offset = this.offset.scale(Math.exp(-frameSeconds / SMOOTHING_SECONDS));
    if (this.offset.lengthSq() < 1e-4) this.offset = new Vector2();
  }

  #step(seq: Seq, controls: Controls): void {
    const ship = this.#ship;
    this.#world.step(this.dt, ship ? new Map([[ship.id, { ...controls, seq }]]) : undefined);
    if (this.perturb && this.ship) this.perturb(this.ship);
  }

  #createWorld(): World {
    // No collisions: hits, pickups and asteroid bumps are the server's call,
    // and show up as corrections. Fresh predicted bullets get world-assigned
    // ids that skip the server ids already in this small world.
    const world = new World({
      width: this.bounds.width,
      height: this.bounds.height,
      collisions: NO_COLLISIONS,
      assignIds: true,
    });
    world.events.on("fired", (event) => {
      if (!this.#replaying) this.onFire?.(event);
    });
    return world;
  }

  // before - after, taking the shortest way across the wrap-around seam.
  #wrappedDelta(before: Vector2, after: Ship): Vector2 {
    const delta = before.sub(after.pos);
    const margin = after.radius * 2;
    const spanX = this.bounds.width + margin;
    const spanY = this.bounds.height + margin;
    let { x, y } = delta;
    if (x > spanX / 2) x -= spanX;
    else if (x < -spanX / 2) x += spanX;
    if (y > spanY / 2) y -= spanY;
    else if (y < -spanY / 2) y += spanY;
    return new Vector2(x, y);
  }
}
