// Frame benchmark: the REAL client code (GameSession: decode, reconcile,
// interpolation, renderables + drawEntity on a no-op canvas) against the REAL
// server Match with 8 bots, a heavily shooting player and asteroids, for 30 s
// of game time at 60 fps / 30 Hz. Measures per-frame client work, per-tick
// server work and every GC pause (PerformanceObserver "gc").
//
//   node bench/frame-bench.ts [label]            -> bench/results/<label>.json
//   node --cpu-prof --cpu-prof-dir=bench/profiles bench/frame-bench.ts
//   node --heap-prof --heap-prof-dir=bench/profiles bench/frame-bench.ts
import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { PerformanceObserver, constants } from "node:perf_hooks";
import { seq } from "@dogfight/shared/brand.ts";
import { binaryCodec, withAck } from "@dogfight/shared/codec/binary.ts";
import type { InputFrame } from "@dogfight/shared/protocol.ts";
import { GameConnection } from "../client/src/connection.ts";
import { GameSession } from "../client/src/net/session.ts";
import { drawEntity } from "../client/src/render/draw.ts";
import { Bot } from "../server/src/bots.ts";
import { Match } from "../server/src/match.ts";

const label = process.argv[2] ?? "run";
const SECONDS = Number(process.env["BENCH_SECONDS"] ?? 30);
const FPS = 60;
const BOTS = 8;
const room = { id: "bench", arena: { width: 1280, height: 720, asteroids: 10 }, maxPlayers: 16 };

// A canvas context whose every call does nothing (painting is the GPU's and
// the browser's cost; this measures our JavaScript).
const noop = () => {};
const ctx = new Proxy(
  {},
  {
    get: (_target, key) => (key === "canvas" ? {} : noop),
    set: () => true,
  },
);
function isContext(value: unknown): value is CanvasRenderingContext2D {
  return typeof value === "object" && value !== null;
}
if (!isContext(ctx)) throw new Error("unreachable");

// The client's connection, but wired straight into the in-process server.
class BenchConnection extends GameConnection {
  readonly match: Match;
  constructor(match: Match) {
    super({ url: "ws://bench.invalid/ws", codec: "binary" });
    this.match = match;
  }
  override sendInputs(inputs: readonly InputFrame[]): boolean {
    const decoded = binaryCodec.decode(binaryCodec.encode({ type: "input", inputs }));
    if (decoded.ok && decoded.value.type === "input") this.match.receiveInputs("me", decoded.value.inputs);
    return true;
  }
  override sendPing(): boolean {
    return true;
  }
}

const percentile = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
function summarize(samples: number[]) {
  const sorted = Float64Array.from(samples).sort();
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
  };
}

const gc = { minor: 0, major: 0, incremental: 0, minorMs: 0, majorMs: 0, maxPauseMs: 0, majorAtGameSecond: new Array<number>() };
let measureStartedAt = Infinity; // performance.now() when measuring began
let measureStartedFrame = 0;
const frameStartedAt: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail: unknown = "detail" in entry ? entry.detail : undefined;
    const kind = typeof detail === "object" && detail !== null && "kind" in detail ? detail.kind : 0;
    gc.maxPauseMs = Math.max(gc.maxPauseMs, entry.duration);
    if (entry.startTime < measureStartedAt) continue; // before the measured window
    if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
      gc.major++;
      gc.majorMs += entry.duration;
      const frame = frameStartedAt.findIndex((t) => t > entry.startTime);
      gc.majorAtGameSecond.push(Number((((frame < 0 ? frameStartedAt.length : frame) - measureStartedFrame) / FPS).toFixed(1)));
    } else if (kind === constants.NODE_PERFORMANCE_GC_MINOR) {
      gc.minor++;
      gc.minorMs += entry.duration;
    } else gc.incremental++;
  }
});

const match = new Match(room);
const bots = Array.from({ length: BOTS }, (_, i) => new Bot(`bot-${i}`, `Bot ${i + 1}`, i + 1));
for (const bot of bots) match.join(bot);
const playerId = match.join({ id: "me", name: "Bench" });
const connection = new BenchConnection(match);
const session = new GameSession({ connection, arena: room.arena });
connection.events.emit("joined", {
  type: "joined",
  room: "bench",
  player: { id: "me", playerId, name: "Bench" },
  arena: room.arena,
  tickRate: 30,
  codec: "binary",
  netsim: { lag: 0, jitter: 0, drop: 0 },
});
connection.events.emit("roster", { type: "roster", room: "bench", players: match.roster() });

const frameMs: number[] = [];
const tickMs: number[] = [];
let clock = 0; // virtual ms, fed to the session as "now"
let entitiesSeen = 0;
let drawn = 0;

function serverTick(): void {
  const started = performance.now();
  for (const bot of bots) match.receiveInputs(bot.id, [bot.next(match.world, match.player(bot.id)?.ship)]);
  match.step();
  const shared = binaryCodec.encode(match.snapshot());
  const bytes = withAck(shared, match.player("me")?.lastProcessedSeq ?? seq(0));
  tickMs.push(performance.now() - started);
  pendingSnapshot = bytes;
}
let pendingSnapshot: Uint8Array<ArrayBuffer> | null = null;

// --alloc: sample EVERY allocation, including objects the GC already
// collected (plain --heap-prof only shows what is still alive at the end,
// which hides per-frame garbage). Written as a .heapprofile for DevTools.
const allocations = process.argv.includes("--alloc") ? new Session() : null;

// Warm-up: let the JIT see the code before measuring (2 s of game time).
const WARMUP_FRAMES = 2 * FPS;
observer.observe({ entryTypes: ["gc"] });
for (let frame = 0; frame < WARMUP_FRAMES + SECONDS * FPS; frame++) {
  clock += 1000 / FPS;
  const measuring = frame >= WARMUP_FRAMES;
  if (frame % 2 === 0) serverTick();
  const started = performance.now();
  frameStartedAt.push(started);
  if (frame === WARMUP_FRAMES) {
    measureStartedAt = started;
    measureStartedFrame = frameStartedAt.length - 1;
  }
  if (pendingSnapshot) {
    // The client's receive path: decode + reconcile (+ events for sounds).
    const decoded = binaryCodec.decode(pendingSnapshot);
    if (decoded.ok && decoded.value.type === "state") connection.events.emit("state", decoded.value);
    pendingSnapshot = null;
  }
  if (frame % 2 === 0) session.step({ left: frame % 120 < 30, right: false, thrust: frame % 90 < 60, fire: true });
  const items = session.renderables(clock, 1 / FPS, (frame % 2) / 2);
  for (const { entity, alpha } of items) drawEntity(ctx, entity, alpha, null);
  session.hudState();
  const work = performance.now() - started;
  if (measuring) {
    frameMs.push(work);
    entitiesSeen += items.length;
    drawn++;
  } else if (frame === WARMUP_FRAMES - 1) {
    if (allocations) {
      allocations.connect();
      await allocations.post("HeapProfiler.startSampling", {
        samplingInterval: 1024,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    tickMs.length = 0;
  }
}
if (allocations) {
  const { profile } = await allocations.post("HeapProfiler.stopSampling");
  await mkdir(new URL("profiles/", import.meta.url), { recursive: true });
  await writeFile(new URL(`profiles/${label}.heapprofile`, import.meta.url), JSON.stringify(profile));
  allocations.disconnect();
}
await new Promise((resolve) => setTimeout(resolve, 50)); // flush GC entries
observer.disconnect();
session.dispose();

const result = {
  label,
  node: process.version,
  gameSeconds: SECONDS,
  bots: BOTS,
  avgEntitiesPerFrame: entitiesSeen / drawn,
  clientFrameMs: summarize(frameMs),
  serverTickMs: summarize(tickMs),
  gc,
  heapUsedMB: process.memoryUsage().heapUsed / 2 ** 20,
};
await mkdir(new URL("results/", import.meta.url), { recursive: true });
await writeFile(new URL(`results/${label}.json`, import.meta.url), `${JSON.stringify(result, null, 2)}\n`);
const f = (n: number) => n.toFixed(3);
console.log(`[${label}] ${SECONDS} s of play, ${BOTS} bots, ~${result.avgEntitiesPerFrame.toFixed(0)} entities/frame`);
console.log(`client frame ms  p50 ${f(result.clientFrameMs.p50)}  p95 ${f(result.clientFrameMs.p95)}  p99 ${f(result.clientFrameMs.p99)}  max ${f(result.clientFrameMs.max)}`);
console.log(`server tick ms   p50 ${f(result.serverTickMs.p50)}  p95 ${f(result.serverTickMs.p95)}  p99 ${f(result.serverTickMs.p99)}  max ${f(result.serverTickMs.max)}`);
console.log(`major GC at game second: [${gc.majorAtGameSecond.join(", ")}]`);
console.log(`GC: ${gc.minor} minor (${gc.minorMs.toFixed(1)} ms), ${gc.major} major (${gc.majorMs.toFixed(1)} ms), ${gc.incremental} incremental, longest ${gc.maxPauseMs.toFixed(2)} ms`);
