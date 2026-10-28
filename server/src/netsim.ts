import { performance } from "node:perf_hooks";
import { type NetSim, NetSimSchema, type Result, check, fail } from "@dogfight/shared/protocol.ts";

// Latency injector. Wraps a connection's receive and send paths with an
// artificial one-way delay (lag + random jitter) and a drop rate. You cannot
// develop netcode on localhost: at 0 ms everything looks fine.
//
// WebSocket runs over TCP, which never reorders, so delivery times within a
// direction are kept monotonic: jitter shows up as bunching, like on a real
// connection. Drops only apply to messages marked droppable (inputs and
// snapshots), as if they travelled over an unreliable channel; join, chat and
// roster stay reliable.

const KEYS = ["lag", "jitter", "drop"] as const;

export function netSimFromQuery(searchParams: URLSearchParams, fallback: NetSim): Result<NetSim> {
  const conditions: Record<string, number> = { ...fallback };
  for (const key of KEYS) {
    const raw = searchParams.get(key);
    if (raw === null) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return fail("invalid-netsim", `${key} must be a number`);
    conditions[key] = value;
  }
  return check(NetSimSchema, conditions, "invalid-netsim");
}

export interface NetSimStats extends NetSim {
  readonly delayed: number;
  readonly dropped: number;
}

export interface NetSimulator {
  readonly conditions: NetSim;
  set(next: NetSim): void;
  receive(fn: () => void, options?: { droppable?: boolean }): boolean;
  send(fn: () => void, options?: { droppable?: boolean }): boolean;
  stats(): NetSimStats;
  dispose(): void;
}

export function createNetSim(conditions: NetSim, { random = Math.random }: { random?: () => number } = {}): NetSimulator {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const lanes = { in: { last: 0, pending: 0 }, out: { last: 0, pending: 0 } };
  const counters = { delayed: 0, dropped: 0 };
  let current = conditions;

  function schedule(laneName: keyof typeof lanes, fn: () => void, { droppable = false } = {}): boolean {
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
      return current;
    },
    set(next) {
      current = next;
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
