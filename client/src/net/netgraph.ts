// The netgraph: the instrument for the whole lab. Text readouts plus a plot
// of the last ~4 s: reconciliation correction per snapshot (bars) and the
// round-trip time (line).
import type { LoopStats } from "../loop.ts";
import type { GameSession, NetgraphSample } from "./session.ts";

const HISTORY = 120;

type Percentiles = { p50: number; p95: number; p99: number };
export interface FrameReport {
  interval: Percentiles;
  work: Percentiles;
}
const PRESETS: readonly { label: string; lag: number; jitter: number; drop: number }[] = [
  { label: "off", lag: 0, jitter: 0, drop: 0 },
  { label: "~100 ms RTT ±30, 2% drop", lag: 50, jitter: 30, drop: 0.02 },
  { label: "~200 ms RTT ±60, 2% drop", lag: 100, jitter: 60, drop: 0.02 },
  { label: "~300 ms RTT ±100, 5% drop", lag: 150, jitter: 100, drop: 0.05 },
];

const fmt = (value: number | null | undefined, digits = 0, unit = "") =>
  value === null || value === undefined || Number.isNaN(value) ? "–" : `${value.toFixed(digits)}${unit}`;

export interface Netgraph {
  update(loopStats: LoopStats, frames?: FrameReport): void;
  handleKey(code: string): boolean;
  dispose(): void;
}

export function createNetgraph({
  text,
  canvas,
  session,
}: {
  text: HTMLElement;
  canvas: HTMLCanvasElement;
  session: GameSession;
}): Netgraph {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D is not available");
  const corrections: number[] = [];
  const rtts: number[] = [];
  let visible = true;
  let presetIndex = 0;
  let lastRttSample: number | null = null;

  const off = session.events.on("correction", ({ px }) => {
    corrections.push(px);
    if (corrections.length > HISTORY) corrections.shift();
  });

  function plot(stats: NetgraphSample): void {
    if (!ctx) return;
    if (stats.rtt !== lastRttSample && stats.rtt !== null) {
      lastRttSample = stats.rtt;
      rtts.push(stats.rtt);
      if (rtts.length > HISTORY / 4) rtts.shift();
    }
    const { width, height } = canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fillRect(0, 0, width, height);

    // correction bars, 0..20 px full scale (clipped)
    const barWidth = width / HISTORY;
    corrections.forEach((value, i) => {
      const h = Math.min(1, value / 20) * (height - 4);
      ctx.fillStyle = value > 5 ? "#ff6b6b" : value > 0.5 ? "#ffd84a" : "#7cfc7c";
      ctx.fillRect(i * barWidth, height - h, Math.max(1, barWidth - 0.5), Math.max(1, h));
    });

    // RTT line, 0..400 ms full scale
    ctx.strokeStyle = "#6de0df";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    rtts.forEach((value, i) => {
      const x = (i / Math.max(1, HISTORY / 4 - 1)) * width;
      const y = height - Math.min(1, value / 400) * (height - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  return {
    update(loopStats: LoopStats, frames?: FrameReport) {
      text.hidden = canvas.hidden = !visible;
      if (!visible) return;
      const s = session.sampleStats(performance.now());
      const netsim = s.netsim ? `${s.netsim.lag}±${s.netsim.jitter} ms/dir, drop ${(s.netsim.drop * 100).toFixed(0)}%` : "–";
      text.textContent = [
        `fps ${loopStats.framesPerSecond}  steps/s ${loopStats.stepsPerSecond}  frame ${fmt(loopStats.lastFrameDuration, 1)} ms`,
        frames
          ? `frame ms p50/p95/p99 ${fmt(frames.interval.p50, 1)}/${fmt(frames.interval.p95, 1)}/${fmt(frames.interval.p99, 1)}  js ${fmt(frames.work.p50, 2)}/${fmt(frames.work.p95, 2)}/${fmt(frames.work.p99, 2)}`
          : "",
        `rtt ${fmt(s.rtt, 0, " ms")}  (avg ${fmt(s.rttAvg, 0)})   codec ${s.codec}`,
        `snapshots ${s.snapshotsPerSecond}/s  age ${fmt(s.snapshotAge, 0, " ms")}  tick ${s.serverTick}`,
        `down ${fmt(s.bytesInPerSecond / 1024, 2)} KB/s  up ${fmt(s.bytesOutPerSecond / 1024, 2)} KB/s`,
        `pending inputs ${s.pendingInputs}`,
        `correction ${fmt(s.correction, 2, " px")}  max/1s ${fmt(s.correctionMax, 2)}  avg ${fmt(s.correctionAvg, 2)}`,
        `interp delay ${fmt(s.interpolationDelayMs, 0, " ms")} [ ]   ${fmt(s.renderTicksBehind, 1)} ticks behind`,
        `prediction ${s.prediction ? "on" : "OFF"} (P)  interpolation ${s.interpolation ? "on" : "OFF"} (I)`,
        `netsim ${netsim} (L)   hide: N`,
      ].join("\n");
      plot(s);
    },
    // Returns true when the key was a netgraph key.
    handleKey(code: string) {
      if (code === "KeyN") visible = !visible;
      else if (code === "BracketLeft")
        session.buffer.interpolationDelayMs = Math.max(0, session.buffer.interpolationDelayMs - 16);
      else if (code === "BracketRight")
        session.buffer.interpolationDelayMs = Math.min(400, session.buffer.interpolationDelayMs + 16);
      else if (code === "KeyP") session.prediction = !session.prediction;
      else if (code === "KeyI") session.interpolation = !session.interpolation;
      else if (code === "KeyL") {
        presetIndex = (presetIndex + 1) % PRESETS.length;
        const preset = PRESETS[presetIndex];
        if (preset) session.setNetSim({ lag: preset.lag, jitter: preset.jitter, drop: preset.drop });
      } else return false;
      return true;
    },
    dispose: off,
  };
}
