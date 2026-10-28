import type { Bounds } from "@dogfight/shared/sim/entity.ts";
import { lerp, lerpAngle } from "@dogfight/shared/sim/math.ts";
import { type EntitySnapshot, TICK_RATE } from "@dogfight/shared/protocol.ts";

// Remote entities are drawn in the PAST: at now - interpolationDelay, between
// the two snapshots that bracket that moment. Two snapshot intervals (~66 ms
// at 30 Hz) is the textbook minimum; 100 ms also rides out one lost snapshot
// plus typical jitter. Adjustable live from the netgraph.
const DEFAULT_INTERPOLATION_DELAY_MS = 100;
const DEFAULT_MAX_SNAPSHOTS = 20;

// Ships and bullets wrap around the arena (with a margin of their radius), so
// "between x=950 and x=4" means across the seam, not across the screen.
const WRAP_RADIUS: Partial<Record<EntitySnapshot["kind"], number>> = { ship: 12, bullet: 3 };

function lerpAxis(from: number, to: number, alpha: number, span: number): number {
  let delta = to - from;
  if (span) {
    if (delta > span / 2) delta -= span;
    else if (delta < -span / 2) delta += span;
  }
  return from + delta * alpha;
}

export interface Pose {
  x: number;
  y: number;
  angle: number;
  age: number; // explosions only
}

// Allocation-free version for the render loop: writes into `out`.
export function interpolatePose(out: Pose, before: EntitySnapshot | undefined, after: EntitySnapshot, alpha: number, bounds: Bounds): Pose {
  const age = after.kind === "explosion" ? after.age : 0;
  if (!before || before === after || alpha >= 1 || before.kind !== after.kind) {
    out.x = after.x;
    out.y = after.y;
    out.angle = after.angle;
    out.age = age;
    return out;
  }
  const radius = WRAP_RADIUS[after.kind];
  out.x = lerpAxis(before.x, after.x, alpha, radius === undefined ? 0 : bounds.width + radius * 2);
  out.y = lerpAxis(before.y, after.y, alpha, radius === undefined ? 0 : bounds.height + radius * 2);
  out.angle = lerpAngle(before.angle, after.angle, alpha);
  out.age = before.kind === "explosion" ? lerp(before.age, age, alpha) : age;
  return out;
}

// One entity's wire data at `alpha` between two snapshots. Generic over the
// exact snapshot type, so a ShipSnapshot in gives a ShipSnapshot out.
export function interpolateEntity<E extends EntitySnapshot>(before: E | undefined, after: E, alpha: number, bounds: Bounds): E {
  if (!before || before === after || alpha >= 1) return after;
  const radius = WRAP_RADIUS[after.kind];
  const spanX = radius === undefined ? 0 : bounds.width + radius * 2;
  const spanY = radius === undefined ? 0 : bounds.height + radius * 2;
  const result = {
    ...after,
    x: lerpAxis(before.x, after.x, alpha, spanX),
    y: lerpAxis(before.y, after.y, alpha, spanY),
    angle: lerpAngle(before.angle, after.angle, alpha),
  };
  if (result.kind === "explosion" && before.kind === "explosion") return { ...result, age: lerp(before.age, result.age, alpha) };
  return result;
}

export interface Sample<S> {
  readonly before: S;
  readonly after: S;
  readonly alpha: number;
}

// Works for any snapshot with a tick: the real StateMessage, or a test double.
export class SnapshotBuffer<S extends { readonly tick: number }> {
  readonly tickRate: number;
  readonly maxSnapshots: number;
  interpolationDelayTicks = 0;
  renderTick = 0;
  #snapshots: { state: S; receivedAt: number }[] = [];
  #lastRenderTick = -Infinity;

  constructor({
    tickRate = TICK_RATE,
    interpolationDelayMs = DEFAULT_INTERPOLATION_DELAY_MS,
    maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
  }: { tickRate?: number; interpolationDelayMs?: number; maxSnapshots?: number } = {}) {
    this.tickRate = tickRate;
    this.maxSnapshots = maxSnapshots;
    this.interpolationDelayMs = interpolationDelayMs;
  }

  get interpolationDelayMs(): number {
    return (this.interpolationDelayTicks * 1000) / this.tickRate;
  }

  set interpolationDelayMs(ms: number) {
    this.interpolationDelayTicks = (ms * this.tickRate) / 1000;
  }

  get latest(): { readonly state: S; readonly receivedAt: number } | null {
    return this.#snapshots.at(-1) ?? null;
  }

  push(state: S, receivedAt: number): boolean {
    const latest = this.#snapshots.at(-1);
    if (latest && state.tick <= latest.state.tick) return false;
    this.#snapshots.push({ state, receivedAt });
    if (this.#snapshots.length > this.maxSnapshots) this.#snapshots.shift();
    return true;
  }

  sample(now: number): Sample<S> | null {
    const first = this.#snapshots[0];
    const latest = this.#snapshots.at(-1);
    if (!first || !latest) return null;
    const second = this.#snapshots[1];
    if (!second) return { before: first.state, after: first.state, alpha: 1 };

    const elapsed = Math.max(0, now - latest.receivedAt);
    const estimatedTick = latest.state.tick + (elapsed * this.tickRate) / 1000;
    const targetTick = Math.min(latest.state.tick, estimatedTick - this.interpolationDelayTicks);
    this.#lastRenderTick = Math.max(this.#lastRenderTick, targetTick);
    this.renderTick = this.#lastRenderTick;

    if (this.#lastRenderTick <= first.state.tick) return { before: first.state, after: second.state, alpha: 0 };

    const snapshots = this.#snapshots;
    for (let i = 0; i + 1 < snapshots.length; i++) {
      const entry = snapshots[i];
      const next = snapshots[i + 1];
      if (!entry || !next) break;
      const before = entry.state;
      const after = next.state;
      if (this.#lastRenderTick > after.tick) continue;
      const span = after.tick - before.tick;
      const alpha = span > 0 ? (this.#lastRenderTick - before.tick) / span : 1;
      return { before, after, alpha: Math.max(0, Math.min(1, alpha)) };
    }
    return { before: latest.state, after: latest.state, alpha: 1 };
  }

  clear(): void {
    this.#snapshots.length = 0;
    this.#lastRenderTick = -Infinity;
  }
}
