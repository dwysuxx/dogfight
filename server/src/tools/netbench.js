// npm run netbench — the numbers behind the README tables:
//   1. JSON vs binary snapshots/inputs at 30 Hz with 4 players (+ bot, 6 asteroids)
//   2. setInterval vs the absolute-target ticker (5 s each)
//   3. reconciliation corrections from the headless netcode run
import { performance } from "node:perf_hooks";
import * as binary from "@dogfight/shared/codec/binary.js";
import * as json from "@dogfight/shared/codec/json.js";
import { MAX_INPUTS_PER_MESSAGE, TICK_RATE } from "@dogfight/shared/protocol/messages.js";
import { Match } from "../match.js";
import { createTicker } from "../ticker.js";
import { runNetcode } from "./headless.js";

const PLAYERS = 4;
const TICKS = TICK_RATE * 30;

function codecBenchmark() {
  const room = { id: "bench", arena: { width: 960, height: 540, asteroids: 6 }, maxPlayers: 4 };
  const match = new Match(room);
  for (let i = 0; i < PLAYERS; i++) match.join({ id: `p${i}`, name: `pilot${i}` });
  const rows = {
    json: { snapshotBytes: 0, inputBytes: 0, micros: 0 },
    binary: { snapshotBytes: 0, inputBytes: 0, micros: 0 },
  };
  const recent = [];
  let entities = 0;
  for (let tick = 1; tick <= TICKS; tick++) {
    const controls = { left: tick % 50 < 15, right: tick % 70 > 60, thrust: tick % 40 < 25, fire: tick % 8 === 0 };
    recent.push({ seq: tick, controls });
    if (recent.length > MAX_INPUTS_PER_MESSAGE) recent.shift();
    for (let i = 0; i < PLAYERS; i++) match.receiveInputs(`p${i}`, [{ seq: tick, controls }]);
    match.step();
    const snapshot = { ...match.snapshot(), ack: tick };
    entities += snapshot.entities.length;
    const input = { type: "input", inputs: recent };

    for (const [name, codec] of [["json", json], ["binary", binary]]) {
      const started = performance.now();
      const encoded = codec.encode(snapshot);
      codec.decode(encoded);
      rows[name].micros += (performance.now() - started) * 1000;
      rows[name].snapshotBytes += typeof encoded === "string" ? Buffer.byteLength(encoded) : encoded.byteLength;
      const inputMessage = codec.encode(input);
      rows[name].inputBytes += typeof inputMessage === "string" ? Buffer.byteLength(inputMessage) : inputMessage.byteLength;
    }
  }
  console.log(`\n### JSON vs binary — ${PLAYERS} players + bot, ${TICKS} ticks at ${TICK_RATE} Hz, ~${(entities / TICKS).toFixed(1)} entities/snapshot\n`);
  console.log("| Codec | Bytes/snapshot | KB/s per client (down) | KB/s per client (up) | Encode+decode µs |");
  console.log("|---|---|---|---|---|");
  for (const [name, row] of Object.entries(rows)) {
    const perSnapshot = row.snapshotBytes / TICKS;
    const perInput = row.inputBytes / TICKS;
    console.log(
      `| ${name === "json" ? "JSON" : "Binary (`DataView`)"} | ${perSnapshot.toFixed(0)} | ${((perSnapshot * TICK_RATE) / 1024).toFixed(2)} | ${((perInput * TICK_RATE) / 1024).toFixed(2)} | ${(row.micros / TICKS).toFixed(1)} |`,
    );
  }
  console.log(
    `\nratio JSON/binary: ${(rows.json.snapshotBytes / rows.binary.snapshotBytes).toFixed(1)}x smaller, ${(rows.json.micros / rows.binary.micros).toFixed(1)}x faster`,
  );
}

function summarize(times) {
  const intervals = times.slice(1).map((t, i) => t - times[i]);
  const target = 1000 / TICK_RATE;
  const deviations = intervals.map((interval) => Math.abs(interval - target));
  const drift = times.at(-1) - times[0] - target * intervals.length;
  return {
    ticks: times.length,
    meanInterval: intervals.reduce((a, b) => a + b, 0) / intervals.length,
    meanDeviation: deviations.reduce((a, b) => a + b, 0) / deviations.length,
    maxDeviation: Math.max(...deviations),
    drift,
  };
}

async function timerBenchmark(seconds = 5) {
  const interval = await new Promise((resolve) => {
    const times = [];
    const timer = setInterval(() => times.push(performance.now()), 33);
    setTimeout(() => {
      clearInterval(timer);
      resolve(summarize(times));
    }, seconds * 1000);
  });
  const absolute = await new Promise((resolve) => {
    const times = [];
    const ticker = createTicker({ rate: TICK_RATE, tick: () => times.push(performance.now()) });
    ticker.start();
    setTimeout(() => {
      ticker.stop();
      resolve(summarize(times));
    }, seconds * 1000);
  });
  console.log(`\n### Timers, ${seconds} s, target ${(1000 / TICK_RATE).toFixed(2)} ms\n`);
  console.log("| Timer | Ticks | Mean interval ms | Mean \\|error\\| ms | Max \\|error\\| ms | Drift after run ms |");
  console.log("|---|---|---|---|---|---|");
  for (const [name, row] of [["`setInterval(fn, 33)`", interval], ["absolute-target `setTimeout`", absolute]])
    console.log(
      `| ${name} | ${row.ticks} | ${row.meanInterval.toFixed(2)} | ${row.meanDeviation.toFixed(2)} | ${row.maxDeviation.toFixed(2)} | ${row.drift.toFixed(1)} |`,
    );
}

function netcodeBenchmark() {
  const runs = [
    ["LAN (0 ms)", { lag: 0, jitter: 0, drop: 0 }],
    ["~100 ms RTT ±30, 2% drop", { lag: 50, jitter: 30, drop: 0.02 }],
    ["~300 ms RTT ±100, 5% drop", { lag: 150, jitter: 100, drop: 0.05 }],
    ["~100 ms RTT + asteroids + bot", { lag: 50, jitter: 30, drop: 0.02, asteroids: 10, withBot: true }],
    [
      "~100 ms RTT, Math.random() in client step",
      { lag: 50, jitter: 30, drop: 0.02, perturb: (ship) => ship.vel.scaleInPlace(1 + (Math.random() - 0.5) * 0.08) },
    ],
  ];
  console.log("\n### Reconciliation correction, 2 pilots, 20 s headless (pilot 1)\n");
  console.log("| Conditions | Mean px | p95 px | Max px | Frozen ticks | Catch-up sub-steps |");
  console.log("|---|---|---|---|---|---|");
  for (const [label, options] of runs) {
    const [pilot] = runNetcode(options);
    console.log(
      `| ${label} | ${pilot.mean.toFixed(4)} | ${pilot.p95.toFixed(4)} | ${pilot.max.toFixed(3)} | ${pilot.stats.frozenTicks} | ${pilot.stats.catchUpSteps} |`,
    );
  }
}

codecBenchmark();
netcodeBenchmark();
await timerBenchmark();
