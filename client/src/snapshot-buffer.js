import { lerp, lerpAngle } from "@dogfight/shared/sim/math.js";
import { TICK_RATE } from "@dogfight/shared/protocol/messages.js";

// Remote entities are drawn in the PAST: at now - interpolationDelay, between
// the two snapshots that bracket that moment. Two snapshot intervals (~66 ms
// at 30 Hz) is the textbook minimum; 100 ms also rides out one lost snapshot
// plus typical jitter. Adjustable live from the netgraph.
const DEFAULT_TICK_RATE = TICK_RATE;
const DEFAULT_INTERPOLATION_DELAY_MS = 100;
const DEFAULT_MAX_SNAPSHOTS = 20;

// Ships and bullets wrap around the arena (with a margin of their radius), so
// "between x=950 and x=4" means across the seam, not across the screen.
const WRAP_RADIUS = { ship: 12, bullet: 3 };

function lerpAxis(from, to, alpha, span) {
  let delta = to - from;
  if (span) {
    if (delta > span / 2) delta -= span;
    else if (delta < -span / 2) delta += span;
  }
  return from + delta * alpha;
}

// One entity's wire data at `alpha` between two snapshots (plain data in,
// plain data out; the caller turns it into an entity with entityFromSnapshot).
export function interpolateEntity(before, after, alpha, bounds) {
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
  if (after.kind === "explosion") result.age = lerp(before.age, after.age, alpha);
  return result;
}

export class SnapshotBuffer {
  #snapshots = [];
  #lastRenderTick = -Infinity;

  constructor({
    tickRate = DEFAULT_TICK_RATE,
    interpolationDelayMs = DEFAULT_INTERPOLATION_DELAY_MS,
    maxSnapshots = DEFAULT_MAX_SNAPSHOTS,
  } = {}) {
    this.tickRate = tickRate;
    this.interpolationDelayMs = interpolationDelayMs;
    this.maxSnapshots = maxSnapshots;
    this.renderTick = 0;
  }

  get interpolationDelayMs() {
    return (this.interpolationDelayTicks * 1000) / this.tickRate;
  }

  set interpolationDelayMs(ms) {
    this.interpolationDelayTicks = (ms * this.tickRate) / 1000;
  }

  get latest() {
    return this.#snapshots.at(-1) ?? null;
  }

  push(state, receivedAt) {
    const latest = this.#snapshots.at(-1);
    if (latest && state.tick <= latest.state.tick) return false;
    this.#snapshots.push({ state, receivedAt });
    if (this.#snapshots.length > this.maxSnapshots) this.#snapshots.shift();
    return true;
  }

  sample(now) {
    if (this.#snapshots.length === 0) return null;
    if (this.#snapshots.length === 1) {
      const only = this.#snapshots[0].state;
      return { before: only, after: only, alpha: 1 };
    }

    const latest = this.#snapshots.at(-1);
    const elapsed = Math.max(0, now - latest.receivedAt);
    const estimatedTick = latest.state.tick + (elapsed * this.tickRate) / 1000;
    const targetTick = Math.min(latest.state.tick, estimatedTick - this.interpolationDelayTicks);
    this.#lastRenderTick = Math.max(this.#lastRenderTick, targetTick);
    this.renderTick = this.#lastRenderTick;

    if (this.#lastRenderTick <= this.#snapshots[0].state.tick) {
      return {
        before: this.#snapshots[0].state,
        after: this.#snapshots[1].state,
        alpha: 0,
      };
    }

    for (let i = 0; i < this.#snapshots.length - 1; i++) {
      const before = this.#snapshots[i].state;
      const after = this.#snapshots[i + 1].state;
      if (this.#lastRenderTick > after.tick) continue;
      const span = after.tick - before.tick;
      const alpha = span > 0 ? (this.#lastRenderTick - before.tick) / span : 1;
      return { before, after, alpha: Math.max(0, Math.min(1, alpha)) };
    }

    const only = latest.state;
    return { before: only, after: only, alpha: 1 };
  }

  clear() {
    this.#snapshots.length = 0;
    this.#lastRenderTick = -Infinity;
  }
}
