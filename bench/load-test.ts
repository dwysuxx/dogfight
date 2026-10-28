// Load test: the real server in its own process, N headless WebSocket clients
// (binary codec) flying scripted paths in ONE room. For each N: server tick
// p99, event-loop utilization, RSS and bytes/s, measured over a 10 s window
// after a warm-up. Capacity = the first N whose tick p99 exceeds the 33 ms
// budget of a 30 Hz tick.
//
//   node bench/load-test.ts                 -> bench/results/load.json (then: node bench/chart.ts)
//   node bench/load-test.ts --cpu-prof 128  -> also profiles the server at N=128 (60 s)
//   node bench/load-test.ts --rooms         -> whole-server capacity: +1 full room (255) per step,
//                                              each driven by its own generator process
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { z } from "zod";
import { seq } from "@dogfight/shared/brand.ts";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import { type Controls, type InputFrame, PROTOCOL_VERSION, check } from "@dogfight/shared/protocol.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;
const RAMP = [8, 32, 64, 128, 192, 255];
const WARMUP_MS = 5000;
const WINDOW_MS = 10_000;
const profileAt = process.argv.includes("--cpu-prof") ? Number(process.argv.at(-1)) : null;

const StatsSchema = z.object({
  memory: z.object({ rss: z.number() }),
  eventLoopUtilization: z.number(),
  matches: z.array(
    z.object({
      room: z.string(),
      players: z.number(),
      entities: z.number(),
      ticker: z.object({
        overruns: z.number(),
        lastSecond: z.object({ maxJitterMs: z.number() }),
        recent: z.object({ p50: z.number(), p95: z.number(), p99: z.number(), max: z.number() }),
      }),
    }),
  ),
  clients: z.array(z.object({ lastSecond: z.object({ bytesOutPerSecond: z.number(), bytesInPerSecond: z.number() }).nullable() })),
});

async function stats() {
  const parsed = check(StatsSchema, await (await fetch(`${BASE}/api/stats`)).json());
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

async function startServer(logDir: string, cpuProfDir: string | null): Promise<ChildProcess> {
  const args = [...(cpuProfDir ? ["--cpu-prof", `--cpu-prof-dir=${cpuProfDir}`] : []), "server/src/index.ts"];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), LOG_DIR: logDir, MAX_PLAYERS_PER_ROOM: "255", MAX_MESSAGES_PER_SECOND: "120" },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return child;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server did not start");
}

async function stopServer(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.send("shutdown"); // graceful: lets --cpu-prof write its profile
  await exited;
}

// One scripted pilot: a different weave per client, firing in bursts.
function pilot(index: number): { close(): void } {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  socket.binaryType = "arraybuffer";
  const recent: InputFrame[] = [];
  let n = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  socket.on("open", () => {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room: "orbit", name: `load-${index}`, codec: "binary" }));
    timer = setInterval(() => {
      const step = n + index * 17;
      const controls: Controls = {
        left: step % 90 < 20,
        right: step % 140 > 115,
        thrust: step % 60 < 40,
        fire: step % 30 < 6,
      };
      recent.push({ seq: seq(++n), controls });
      if (recent.length > 4) recent.shift();
      if (socket.readyState === WebSocket.OPEN) socket.send(binaryCodec.encode({ type: "input", inputs: recent }));
    }, 1000 / 30);
  });
  socket.on("error", () => {});
  return {
    close() {
      if (timer) clearInterval(timer);
      socket.terminate();
    },
  };
}

interface Row {
  clients: number;
  entities: number;
  tickP50: number;
  tickP99: number;
  tickMax: number;
  overruns: number;
  elu: number;
  rssMB: number;
  outKBps: number;
  inKBps: number;
}

// --- whole-server capacity: rooms of 255, one generator process each --------
if (process.argv.includes("--rooms")) {
  const logDir = await mkdtemp(join(tmpdir(), "dogfight-load-"));
  const server = await startServer(logDir, null);
  const generators: ChildProcess[] = [];
  const rows: (Row & { rooms: number; worstLatenessMs: number })[] = [];
  try {
    for (let rooms = 1; rooms <= 6; rooms++) {
      let roomId = rooms === 1 ? "orbit" : null;
      if (!roomId) {
        const created = check(
          z.object({ id: z.string() }),
          await (await fetch(`${BASE}/api/rooms`, { method: "POST", body: JSON.stringify({ name: `Load ${rooms}` }) })).json(),
        );
        if (!created.ok) throw new Error(created.error.message);
        roomId = created.value.id;
      }
      generators.push(
        spawn(process.execPath, ["bench/load-pilots.ts", String(PORT), roomId, "255", String((rooms - 1) * 255)], {
          cwd: ROOT,
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, WARMUP_MS + 3000));
      await stats();
      await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
      const s = await stats();
      const out = s.clients.reduce((sum, c) => sum + (c.lastSecond?.bytesOutPerSecond ?? 0), 0);
      const row = {
        rooms,
        clients: s.matches.reduce((sum, m) => sum + m.players, 0),
        entities: s.matches.reduce((sum, m) => sum + m.entities, 0),
        tickP50: Math.max(...s.matches.map((m) => m.ticker.recent.p50)),
        tickP99: Math.max(...s.matches.map((m) => m.ticker.recent.p99)),
        tickMax: Math.max(...s.matches.map((m) => m.ticker.recent.max)),
        overruns: s.matches.reduce((sum, m) => sum + m.ticker.overruns, 0),
        worstLatenessMs: Math.max(...s.matches.map((m) => m.ticker.lastSecond.maxJitterMs)),
        elu: s.eventLoopUtilization,
        rssMB: s.memory.rss / 2 ** 20,
        outKBps: out / 1024,
        inKBps: 0,
      };
      rows.push(row);
      console.log(
        `rooms ${rooms}  N=${String(row.clients).padStart(4)}  worst-room tick p99 ${row.tickP99.toFixed(1)} ms  max ${row.tickMax.toFixed(1)}  ` +
          `tick start late by up to ${row.worstLatenessMs.toFixed(1)} ms  ELU ${(row.elu * 100).toFixed(0)}%  RSS ${row.rssMB.toFixed(0)} MB  ` +
          `out ${(row.outKBps / 1024).toFixed(0)} MB/s  overruns ${row.overruns}`,
      );
      if (row.tickP99 > 1000 / 30 || row.worstLatenessMs > 1000 / 30 || row.elu > 0.9) {
        console.log(`Over budget at N=${row.clients} (${rooms} rooms)`);
        break;
      }
    }
  } finally {
    for (const generator of generators) if (generator.connected) generator.send("stop");
    await stopServer(server);
    await rm(logDir, { recursive: true, force: true });
  }
  await mkdir(join(ROOT, "bench", "results"), { recursive: true });
  await writeFile(join(ROOT, "bench", "results", "load-rooms.json"), `${JSON.stringify(rows, null, 2)}
`);
  process.exit(0);
}

const logDir = await mkdtemp(join(tmpdir(), "dogfight-load-"));
const profileDir = join(ROOT, "bench", "profiles");
const rows: Row[] = [];
const pilots: { close(): void }[] = [];
const server = await startServer(logDir, profileAt === null ? null : profileDir);
try {
  for (const target of RAMP) {
    if (profileAt !== null && target > profileAt) break;
    while (pilots.length < target) pilots.push(pilot(pilots.length));
    await new Promise((resolve) => setTimeout(resolve, WARMUP_MS));
    await stats(); // resets the ELU window
    await new Promise((resolve) => setTimeout(resolve, profileAt === target ? 60_000 : WINDOW_MS));
    const s = await stats();
    const match = s.matches.find((m) => m.room === "orbit");
    if (!match) throw new Error("orbit is not running");
    const out = s.clients.reduce((sum, c) => sum + (c.lastSecond?.bytesOutPerSecond ?? 0), 0);
    const inbound = s.clients.reduce((sum, c) => sum + (c.lastSecond?.bytesInPerSecond ?? 0), 0);
    const row: Row = {
      clients: match.players,
      entities: match.entities,
      tickP50: match.ticker.recent.p50,
      tickP99: match.ticker.recent.p99,
      tickMax: match.ticker.recent.max,
      overruns: match.ticker.overruns,
      elu: s.eventLoopUtilization,
      rssMB: s.memory.rss / 2 ** 20,
      outKBps: out / 1024,
      inKBps: inbound / 1024,
    };
    rows.push(row);
    console.log(
      `N=${String(row.clients).padStart(3)}  entities ${String(row.entities).padStart(4)}  tick p50 ${row.tickP50.toFixed(2)} ms  p99 ${row.tickP99.toFixed(2)} ms  max ${row.tickMax.toFixed(1)}  ` +
        `ELU ${(row.elu * 100).toFixed(0)}%  RSS ${row.rssMB.toFixed(0)} MB  out ${(row.outKBps / 1024).toFixed(1)} MB/s  overruns ${row.overruns}`,
    );
  }
} finally {
  for (const p of pilots) p.close();
  await stopServer(server);
  await rm(logDir, { recursive: true, force: true });
}

const capacity = rows.find((row) => row.tickP99 > 1000 / 30);
console.log(capacity ? `Capacity: tick p99 exceeds 33 ms at N=${capacity.clients}` : `Tick p99 stayed under 33 ms up to N=${rows.at(-1)?.clients}`);
await mkdir(join(ROOT, "bench", "results"), { recursive: true });
const label = profileAt === null ? "load" : `load-profile-${profileAt}`;
await writeFile(join(ROOT, "bench", "results", `${label}.json`), `${JSON.stringify(rows, null, 2)}\n`);

// The chart is drawn by bench/chart.ts from the result files.
