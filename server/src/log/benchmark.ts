import { createWriteStream } from "node:fs";
import type { IncomingMessage } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { loadConfig } from "../config.ts";
import { createApp } from "../http.ts";
import { MatchLogTransform } from "./matchlog.ts";

const TARGET_BYTES = 200 * 1024 * 1024;
const PAYLOAD_BYTES = 8 * 1024;
const SAMPLE_MS = 100;
const THROTTLE_MS = 3;
const chartPath = fileURLToPath(new URL("../../docs/backpressure-rss.svg", import.meta.url));

async function* syntheticEvents(targetBytes: number) {
  const payload = "x".repeat(PAYLOAD_BYTES);
  const count = Math.ceil(targetBytes / (PAYLOAD_BYTES + 120));
  for (let i = 0; i < count; i++)
    yield { t: i, type: "synthetic", sequence: i, payload };
}

const id = `benchmark-${Date.now()}-${randomUUID().slice(0, 8)}.ndjson`;
const benchmarkLogDir = join(tmpdir(), `dogfight-lab04-benchmark-${process.pid}`);
const config = loadConfig({ ...process.env, LOG_DIR: benchmarkLogDir });
await mkdir(config.logDir, { recursive: true });
const logPath = join(config.logDir, id);
await pipeline(
  Readable.from(syntheticEvents(TARGET_BYTES)),
  new MatchLogTransform(),
  createWriteStream(logPath, { flags: "wx" }),
);

const app = await createApp(config);
app.server.listen(0, "127.0.0.1");
await new Promise<void>((resolveListen, rejectListen) => {
  app.server.once("listening", () => resolveListen());
  app.server.once("error", rejectListen);
});
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Server has no TCP address");
const samples: { ms: number; rss: number }[] = [];
const startedAt = performance.now();
const sampler = setInterval(() => {
  samples.push({ ms: performance.now() - startedAt, rss: process.memoryUsage.rss() / 1024 / 1024 });
}, SAMPLE_MS);

try {
  const response = await new Promise<IncomingMessage>((resolveResponse, rejectResponse) => {
    const request = get(`http://127.0.0.1:${address.port}/api/replays/${id}`, resolveResponse);
    request.on("error", rejectResponse);
  });
  if (response.statusCode !== 200) throw new Error(`Replay request failed with ${response.statusCode}`);
  let bytes = 0;
  await pipeline(
    response,
    new Writable({
      highWaterMark: 64 * 1024,
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        setTimeout(callback, THROTTLE_MS);
      },
    }),
  );
  samples.push({ ms: performance.now() - startedAt, rss: process.memoryUsage.rss() / 1024 / 1024 });
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  const minRss = Math.min(...samples.map(({ rss }) => rss));
  const maxRss = Math.max(...samples.map(({ rss }) => rss));
  const width = 900;
  const height = 320;
  const padding = 48;
  const rssMax = Math.ceil(maxRss / 20) * 20;
  const points = samples
    .map(({ ms, rss }) => {
      const x = padding + (ms / (elapsedSeconds * 1000)) * (width - padding * 2);
      const y = height - padding - (rss / rssMax) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const yTicks = [0, Math.round(rssMax / 2), rssMax]
    .map((rss) => {
      const y = height - padding - (rss / rssMax) * (height - padding * 2);
      return `  <line x1="${padding}" y1="${y}" x2="${width - padding}" y2="${y}" stroke="#344157"/>\n` +
        `  <text x="${padding - 8}" y="${y + 4}" text-anchor="end" fill="#9eabc0" font-family="sans-serif" font-size="12">${rss}</text>`;
    })
    .join("\n");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#10151f"/>
  <text x="${padding}" y="24" fill="#e8f0ff" font-family="sans-serif" font-size="16">RSS during ${Math.round(bytes / 1024 / 1024)} MiB throttled replay (${elapsedSeconds.toFixed(1)} s)</text>
  <text x="${padding}" y="42" fill="#9eabc0" font-family="sans-serif" font-size="12">RSS range: ${minRss.toFixed(1)}–${maxRss.toFixed(1)} MiB · receiver: 64 KiB highWaterMark, ${THROTTLE_MS} ms/chunk</text>
${yTicks}
  <line x1="${padding}" y1="${padding}" x2="${padding}" y2="${height - padding}" stroke="#53617a"/>
  <line x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}" stroke="#53617a"/>
  <polyline points="${points}" fill="none" stroke="#ffd84a" stroke-width="2"/>
  <text x="${padding}" y="${height - 12}" fill="#9eabc0" font-family="sans-serif" font-size="12">0 s</text>
  <text x="${width - padding}" y="${height - 12}" text-anchor="end" fill="#9eabc0" font-family="sans-serif" font-size="12">${elapsedSeconds.toFixed(1)} s</text>
  <text x="12" y="${height / 2}" transform="rotate(-90 12 ${height / 2})" fill="#9eabc0" font-family="sans-serif" font-size="12">RSS MiB</text>
</svg>
`;
  await mkdir(fileURLToPath(new URL("../../docs/", import.meta.url)), { recursive: true });
  await writeFile(chartPath, svg);
  console.info(
    `Streamed ${(bytes / 1024 / 1024).toFixed(1)} MiB in ${elapsedSeconds.toFixed(1)} s; ` +
      `RSS ${minRss.toFixed(1)}–${maxRss.toFixed(1)} MiB across ${samples.length} samples.`,
  );
  console.info(`RSS graph: ${chartPath}`);
} finally {
  clearInterval(sampler);
  await app.close();
  await rm(benchmarkLogDir, { recursive: true, force: true });
}
