import type { Bus } from "@dogfight/shared/bus.ts";
import type { EventType } from "@dogfight/shared/protocol.ts";
import type { GameEvents } from "./net/session.ts";

export interface GameAudio {
  readonly context: AudioContext;
  readonly muted: boolean;
  setBuffers(buffers: Readonly<Record<string, AudioBuffer>>): void;
  setMuted(muted: boolean): void;
  unlock(): Promise<void>;
  connect(events: Bus<GameEvents>): () => void;
  dispose(): Promise<void>;
}

// Every sound goes through one master gain node, so muting is a single
// gain change (no sound is skipped mid-play or queued for later).
export function createAudio({ muted = false }: { muted?: boolean } = {}): GameAudio | null {
  if (typeof AudioContext === "undefined") return null;
  const context = new AudioContext();
  const master = context.createGain();
  master.connect(context.destination);
  master.gain.value = muted ? 0 : 1;
  let buffers: Readonly<Record<string, AudioBuffer>> = {};
  let isMuted = muted;

  function play(name: EventType): void {
    const buffer = buffers[name];
    if (!buffer || isMuted || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    source.start();
  }

  return {
    context,
    get muted() {
      return isMuted;
    },
    setBuffers(next) {
      buffers = next;
    },
    setMuted(next) {
      isMuted = next;
      master.gain.setTargetAtTime(next ? 0 : 1, context.currentTime, 0.015);
    },
    async unlock() {
      if (context.state !== "running") await context.resume();
    },
    connect(events) {
      const offs = (["fired", "hit", "exploded"] as const).map((name) => events.on(name, () => play(name)));
      return () => offs.forEach((off) => off());
    },
    async dispose() {
      if (context.state !== "closed") await context.close();
    },
  };
}
