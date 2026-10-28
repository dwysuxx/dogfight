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

export interface PendingInput {
  readonly seq: Seq;
  readonly controls: Controls;
}

export interface ReplayOptions {
  bounds: Bounds;
  playerId: PlayerId;
  players?: PlayerLookup;
  dt?: number;
  perturb?: ((ship: Ship) => void) | null;
}

export interface Prediction {
  readonly world: World;
  readonly ship: Ship | null;
  readonly pending: PendingInput[];
}

// The prediction world: no collisions (hits, pickups and asteroid bumps are
// the server's call and show up as corrections), and world-assigned ids so
// fresh predicted bullets never collide with the server ids in it.
export function createPredictionWorld(bounds: Bounds): World {
  return new World({ width: bounds.width, height: bounds.height, collisions: NO_COLLISIONS, assignIds: true });
}

// One predicted step: the same Ship/Bullet code the server runs.
export function stepPrediction(
  world: World,
  ship: Ship | null,
  { seq, controls }: PendingInput,
  dt: number,
  perturb: ((ship: Ship) => void) | null = null,
): void {
  world.step(dt, ship ? new Map([[ship.id, { ...controls, seq }]]) : undefined);
  if (perturb && ship?.alive) perturb(ship);
}

// Reconciliation as a pure function of (snapshot, pending inputs): start from
// the server's own ship and own bullets, drop the inputs the server already
// applied (seq <= ack), replay the rest in order. No hidden state: the same
// arguments always give the same prediction.
export function replay(
  state: StateMessage,
  pending: readonly PendingInput[],
  { bounds, playerId, players = new Map(), dt = TICK_SECONDS, perturb = null }: ReplayOptions,
): Prediction {
  const remaining = pending.filter((input) => input.seq > state.ack);
  const world = createPredictionWorld(bounds);
  const shipData = state.entities.find((e) => e.kind === "ship" && !e.bot && e.owner === playerId);
  const ship = shipData?.kind === "ship" ? Ship.fromSnapshot(shipData, { players }) : null;
  if (ship) world.spawn(ship, { keepId: true });
  for (const data of state.entities) {
    if (data.kind !== "bullet" || data.owner !== playerId) continue;
    world.spawn(Bullet.fromSnapshot(data, { owner: ship }), { keepId: true });
  }
  for (const input of remaining) stepPrediction(world, ship, input, dt, perturb);
  return { world, ship, pending: remaining };
}

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
  #pending: PendingInput[] = [];
  #lastTick = -1;

  constructor({ bounds, playerId, players = new Map(), dt = TICK_SECONDS, perturb = null, onFire = null }: PredictorOptions) {
    this.bounds = bounds;
    this.playerId = playerId;
    this.players = players;
    this.dt = dt;
    this.perturb = perturb;
    this.onFire = onFire;
    this.#world = this.#listen(createPredictionWorld(bounds));
  }

  get ship(): Ship | null {
    return this.#ship?.alive ? this.#ship : null;
  }

  get pendingCount(): number {
    return this.#pending.length;
  }

  // The live list (no generator: nothing allocated per frame).
  entities(): readonly GameEntity[] {
    return this.#world.all;
  }

  // Called once per client simulation step with the input just sent.
  applyInput(seq: Seq, controls: Controls): void {
    this.#pending.push({ seq, controls });
    if (this.#pending.length > MAX_PENDING) this.#pending.shift();
    stepPrediction(this.#world, this.#ship, { seq, controls }, this.dt, this.perturb);
  }

  // Returns the correction in px, or null when the snapshot was stale.
  reconcile(state: StateMessage): number | null {
    if (state.tick <= this.#lastTick) return null;
    this.#lastTick = state.tick satisfies Tick;
    const before = this.ship?.pos ?? null;

    const prediction = replay(state, this.#pending, this);
    this.#pending = prediction.pending;
    this.#ship = prediction.ship;
    this.#world = this.#listen(prediction.world); // after the replay: replayed shots stay silent

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

  #listen(world: World): World {
    world.events.on("fired", (event) => this.onFire?.(event));
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
