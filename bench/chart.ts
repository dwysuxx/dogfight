// Draws server/docs/load-test.svg from bench/results/load.json (one room,
// N = 8..255) and bench/results/load-rooms.json (whole server, +255 per room).
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const Rows = z.array(z.object({ clients: z.number(), tickP99: z.number(), elu: z.number(), worstLatenessMs: z.number().optional() }));
const load = async (name: string) => Rows.parse(JSON.parse(await readFile(`${ROOT}bench/results/${name}`, "utf8")));
const single = await load("load.json");
const rooms = await load("load-rooms.json");

const width = 760;
const height = 380;
const pad = 60;
const maxN = Math.max(...single.map((r) => r.clients), ...rooms.map((r) => r.clients));
const maxMs = 80;
const x = (n: number) => pad + (n / maxN) * (width - pad * 2);
const y = (ms: number) => height - pad - (Math.min(ms, maxMs) / maxMs) * (height - pad * 2);
const yPct = (fraction: number) => height - pad - fraction * (height - pad * 2);
const line = (points: [number, number][]) => points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ");
const dots = (points: [number, number, string][], color: string) =>
  points
    .map(([px, py, label]) => `  <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="${color}"/>\n  <text x="${px.toFixed(1)}" y="${(py - 9).toFixed(1)}" fill="${color}" text-anchor="middle">${label}</text>`)
    .join("\n");

const late = rooms.map((r): [number, number, string] => [x(r.clients), y(r.worstLatenessMs ?? 0), `${(r.worstLatenessMs ?? 0).toFixed(0)}`]);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="12">
  <rect width="100%" height="100%" fill="#10151f"/>
  <text x="${pad}" y="26" fill="#e8f0ff" font-size="15">Server capacity at 30 Hz (i7-9700KF, Node 24, generators on the same machine)</text>
  <line x1="${pad}" y1="${y(1000 / 30)}" x2="${width - pad}" y2="${y(1000 / 30)}" stroke="#ff7a7a" stroke-dasharray="6 4"/>
  <text x="${width - pad}" y="${y(1000 / 30) - 6}" fill="#ff7a7a" text-anchor="end">33 ms budget</text>
  <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#53617a"/>
  <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${height - pad}" stroke="#53617a"/>
  <polyline points="${line(single.map((r) => [x(r.clients), y(r.tickP99)]))}" fill="none" stroke="#ffd84a" stroke-width="2.5"/>
${dots(single.map((r) => [x(r.clients), y(r.tickP99), r.tickP99.toFixed(1)]), "#ffd84a")}
  <polyline points="${line(rooms.map((r) => [x(r.clients), y(r.tickP99)]))}" fill="none" stroke="#d6a5ff" stroke-width="2"/>
  <polyline points="${line(late.map(([px, py]) => [px, py]))}" fill="none" stroke="#ff8fa3" stroke-width="2"/>
${dots(late, "#ff8fa3")}
  <polyline points="${line([...single, ...rooms.slice(1)].map((r) => [x(r.clients), yPct(r.elu)]))}" fill="none" stroke="#6de0df" stroke-width="1.5" stroke-dasharray="4 3"/>
${[...new Set([...single, ...rooms].map((r) => r.clients))]
  .map((n) => `  <text x="${x(n).toFixed(1)}" y="${height - pad + 16}" fill="#9eabc0" text-anchor="middle">${n}</text>`)
  .join("\n")}
  <text x="${pad - 8}" y="${pad + 4}" fill="#9eabc0" text-anchor="end">${maxMs} ms</text>
  <text x="${pad - 8}" y="${height - pad}" fill="#9eabc0" text-anchor="end">0</text>
  <text x="${width / 2}" y="${height - 14}" fill="#9eabc0" text-anchor="middle">connected clients (N)</text>
  <text x="${pad + 10}" y="${pad + 6}" fill="#ffd84a">— tick p99, one room (N ≤ 255: the u8 player-id limit)</text>
  <text x="${pad + 10}" y="${pad + 22}" fill="#d6a5ff">— tick p99, worst room, rooms of 255</text>
  <text x="${pad + 10}" y="${pad + 38}" fill="#ff8fa3">— how late a tick started (ms): over 33 = ticks lost</text>
  <text x="${pad + 10}" y="${pad + 54}" fill="#6de0df">- - event-loop utilization (0..100% on the same height)</text>
</svg>
`;
await writeFile(`${ROOT}server/docs/load-test.svg`, svg);
console.log("server/docs/load-test.svg");
