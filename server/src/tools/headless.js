// Headless netcode check: the real server Match and the real client Predictor,
// connected by a simulated network (virtual time, seeded jitter and drops,
// every message through the binary codec). Measures the reconciliation
// correction, which must be ~0 when client and server agree, and grows when
// determinism is broken on purpose.
import * as binary from "@dogfight/shared/codec/binary.js";
import { MAX_INPUTS_PER_MESSAGE, TICK_SECONDS } from "@dogfight/shared/protocol/messages.js";
import { Predictor } from "@dogfight/shared/net/prediction.js";
import { createRng } from "@dogfight/shared/sim/rng.js";
import { Match } from "../match.js";

const TICK_MS = TICK_SECONDS * 1000;

// A pilot flying a busy scripted pattern: turns, thrust bursts, fire.
const flight = (step, phase) => ({
  left: (step + phase) % 90 < 25,
  right: (step + phase) % 140 > 110,
  thrust: (step + phase) % 60 < 40,
  fire: (step + phase) % 12 === 0,
});

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
} = {}) {
  const random = createRng(seed);
  const room = { id: "netcode", arena: { width: 960, height: 540, asteroids }, maxPlayers: 4 };
  const match = new Match(room, { withBot });
  const events = []; // { at, fn }, kept sorted by time
  const schedule = (at, fn) => {
    let i = events.length;
    while (i > 0 && events[i - 1].at > at) i--;
    events.splice(i, 0, { at, fn });
  };
  // One direction of one connection: lag + jitter, never reordered (TCP), maybe dropped.
  const link = () => {
    let last = 0;
    return (now, fn) => {
      if (random() < drop) return;
      last = Math.max(last, now + lag + random() * jitter);
      schedule(last, fn);
    };
  };

  const clients = [];
  for (let i = 0; i < pilots; i++) {
    const id = `pilot-${i}`;
    const playerId = match.join({ id, name: id });
    const client = {
      id,
      phase: i * 37,
      seq: 0,
      recent: [],
      up: link(),
      down: link(),
      corrections: [],
      predictor: new Predictor({
        bounds: room.arena,
        playerId,
        perturb: i === 0 ? perturb : null,
      }),
    };
    clients.push(client);
  }

  const end = seconds * 1000;
  // Clients step at the tick rate, out of phase with the server.
  for (const [index, client] of clients.entries()) {
    for (let t = 5 + index * 7, step = 0; t < end; t += TICK_MS, step++) {
      schedule(t, (now) => {
        const controls = flight(step, client.phase);
        const seq = ++client.seq;
        client.recent.push({ seq, controls });
        if (client.recent.length > MAX_INPUTS_PER_MESSAGE) client.recent.shift();
        const bytes = binary.encode({ type: "input", inputs: client.recent });
        client.up(now, () => match.receiveInputs(client.id, binary.decode(bytes).inputs));
        client.predictor.applyInput(seq, controls);
      });
    }
  }
  for (let t = TICK_MS; t < end; t += TICK_MS) {
    schedule(t, (now) => {
      match.step();
      const shared = binary.encode(match.snapshot());
      for (const client of clients) {
        const bytes = binary.withAck(shared, match.player(client.id).lastProcessedSeq);
        client.down(now, () => {
          const correction = client.predictor.reconcile(binary.decode(bytes));
          if (correction !== null && now > 1000) client.corrections.push(correction);
        });
      }
    });
  }

  while (events.length) {
    const { at, fn } = events.shift();
    fn(at);
  }

  return clients.map(({ corrections }) => {
    const sorted = [...corrections].sort((a, b) => a - b);
    return {
      snapshots: corrections.length,
      mean: corrections.reduce((a, b) => a + b, 0) / corrections.length,
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted.at(-1),
      stats: match.stats,
    };
  });
}
