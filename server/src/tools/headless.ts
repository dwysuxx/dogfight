// Headless netcode check: the real server Match and the real client Predictor,
// connected by a simulated network (virtual time, seeded jitter and drops,
// every message through the binary codec). Measures the reconciliation
// correction, which must be ~0 when client and server agree, and grows when
// determinism is broken on purpose.
import { type Seq, seq } from "@dogfight/shared/brand.ts";
import { binaryCodec, withAck } from "@dogfight/shared/codec/binary.ts";
import { Predictor } from "@dogfight/shared/net/prediction.ts";
import { type Controls, type InputFrame, MAX_INPUTS_PER_MESSAGE, TICK_SECONDS } from "@dogfight/shared/protocol.ts";
import { createRng } from "@dogfight/shared/sim/rng.ts";
import type { Ship } from "@dogfight/shared/sim/ship.ts";
import { Match, type MatchStats } from "../match.ts";

const TICK_MS = TICK_SECONDS * 1000;

// A pilot flying a busy scripted pattern: turns, thrust bursts, fire.
const flight = (step: number, phase: number): Controls => ({
  left: (step + phase) % 90 < 25,
  right: (step + phase) % 140 > 110,
  thrust: (step + phase) % 60 < 40,
  fire: (step + phase) % 12 === 0,
});

export interface NetcodeOptions {
  seconds?: number;
  lag?: number;
  jitter?: number;
  drop?: number;
  pilots?: number;
  asteroids?: number;
  withBot?: boolean;
  perturb?: ((ship: Ship) => void) | null;
  seed?: number;
}

export interface PilotResult {
  snapshots: number;
  mean: number;
  p95: number;
  max: number;
  stats: MatchStats;
}

type Scheduled = { at: number; fn: (now: number) => void };
type Link = (now: number, fn: (now: number) => void) => void;

interface SimulatedClient {
  id: string;
  phase: number;
  seq: number;
  recent: InputFrame[];
  up: Link;
  down: Link;
  corrections: number[];
  predictor: Predictor;
}

export function runNetcode({
  seconds = 20,
  lag = 50,
  jitter = 30,
  drop = 0.02,
  pilots = 2,
  asteroids = 0,
  withBot = false,
  perturb = null,
  seed = 1,
}: NetcodeOptions = {}): PilotResult[] {
  const random = createRng(seed);
  const room = { id: "netcode", arena: { width: 960, height: 540, asteroids }, maxPlayers: 4 };
  const match = new Match(room, { withBot });
  const events: Scheduled[] = []; // kept sorted by time
  const schedule = (at: number, fn: (now: number) => void) => {
    let i = events.length;
    while (i > 0 && (events[i - 1]?.at ?? 0) > at) i--;
    events.splice(i, 0, { at, fn });
  };
  // One direction of one connection: lag + jitter, never reordered (TCP), maybe dropped.
  const link = (): Link => {
    let last = 0;
    return (now: number, fn: (now: number) => void) => {
      if (random() < drop) return;
      last = Math.max(last, now + lag + random() * jitter);
      schedule(last, fn);
    };
  };

  const clients = Array.from({ length: pilots }, (_, i): SimulatedClient => {
    const id = `pilot-${i}`;
    const playerId = match.join({ id, name: id });
    return {
      id,
      phase: i * 37,
      seq: 0,
      recent: [],
      up: link(),
      down: link(),
      corrections: [],
      predictor: new Predictor({ bounds: room.arena, playerId, perturb: i === 0 ? perturb : null }),
    };
  });

  const end = seconds * 1000;
  // Clients step at the tick rate, out of phase with the server.
  for (const [index, client] of clients.entries()) {
    for (let t = 5 + index * 7, step = 0; t < end; t += TICK_MS, step++) {
      const at = step;
      schedule(t, (now) => {
        const controls = flight(at, client.phase);
        const next: Seq = seq(++client.seq);
        client.recent.push({ seq: next, controls });
        if (client.recent.length > MAX_INPUTS_PER_MESSAGE) client.recent.shift();
        const bytes = binaryCodec.encode({ type: "input", inputs: client.recent });
        client.up(now, () => {
          const decoded = binaryCodec.decode(bytes);
          if (decoded.ok && decoded.value.type === "input") match.receiveInputs(client.id, decoded.value.inputs);
        });
        client.predictor.applyInput(next, controls);
      });
    }
  }
  for (let t = TICK_MS; t < end; t += TICK_MS) {
    schedule(t, (now) => {
      match.step();
      const shared = binaryCodec.encode(match.snapshot());
      for (const client of clients) {
        const bytes = withAck(shared, match.player(client.id)?.lastProcessedSeq ?? seq(0));
        client.down(now, () => {
          const decoded = binaryCodec.decode(bytes);
          if (!decoded.ok || decoded.value.type !== "state") return;
          const correction = client.predictor.reconcile(decoded.value);
          if (correction !== null && now > 1000) client.corrections.push(correction);
        });
      }
    });
  }

  for (let next = events.shift(); next; next = events.shift()) next.fn(next.at);

  return clients.map(({ corrections }) => {
    const sorted = [...corrections].sort((a, b) => a - b);
    return {
      snapshots: corrections.length,
      mean: corrections.reduce((a, b) => a + b, 0) / corrections.length,
      p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      max: sorted.at(-1) ?? 0,
      stats: match.stats,
    };
  });
}
