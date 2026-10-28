import { performance } from "node:perf_hooks";

// Latency injector. Wraps a connection's receive and send paths with an
// artificial one-way delay (lag + random jitter) and a drop rate. You cannot
// develop netcode on localhost: at 0 ms everything looks fine.
//
// WebSocket runs over TCP, which never reorders, so delivery times within a
// direction are kept monotonic: jitter shows up as bunching, like on a real
// connection. Drops only apply to messages marked droppable (inputs and
// snapshots), as if they travelled over an unreliable channel; join, chat and
// roster stay reliable.

export const NETSIM_LIMITS = Object.freeze({ lag: 1000, jitter: 500, drop: 0.5 });

export function validateNetSim(value) {
  const conditions = {};
  for (const [key, max] of Object.entries(NETSIM_LIMITS)) {
    const raw = value?.[key] ?? 0;
    const number = typeof raw === "string" ? Number(raw) : raw;
    if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > max)
      throw new RangeError(`${key} must be a number between 0 and ${max}`);
    conditions[key] = number;
  }
  return conditions;
}

export function netSimFromQuery(searchParams, fallback) {
  const fromQuery = {};
  for (const key of Object.keys(NETSIM_LIMITS))
    if (searchParams.has(key)) fromQuery[key] = searchParams.get(key);
  return validateNetSim({ ...fallback, ...fromQuery });
}

export function createNetSim(conditions, { random = Math.random } = {}) {
  const timers = new Set();
  const lanes = { in: { last: 0, pending: 0 }, out: { last: 0, pending: 0 } };
  const counters = { delayed: 0, dropped: 0 };
  let current = validateNetSim(conditions);

  function schedule(laneName, fn, { droppable = false } = {}) {
    if (droppable && current.drop > 0 && random() < current.drop) {
      counters.dropped++;
      return false;
    }
    const lane = lanes[laneName];
    const delay = current.lag + random() * current.jitter;
    if (delay <= 0 && lane.pending === 0) {
      fn();
      return true;
    }
    const now = performance.now();
    lane.last = Math.max(lane.last, now + delay);
    lane.pending++;
    counters.delayed++;
    const timer = setTimeout(() => {
      timers.delete(timer);
      lane.pending--;
      fn();
    }, lane.last - now);
    timers.add(timer);
    return true;
  }

  return {
    get conditions() {
      return { ...current };
    },
    set(next) {
      current = validateNetSim(next);
    },
    receive: (fn, options) => schedule("in", fn, options),
    send: (fn, options) => schedule("out", fn, options),
    stats: () => ({ ...current, ...counters }),
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}
