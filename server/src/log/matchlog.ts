import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { PassThrough, Transform, type TransformCallback, type TransformOptions } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LogEvent, Room } from "../rooms.ts";

const LOG_ID = /^[a-z0-9-]+-\d+-[a-f0-9]{8}\.ndjson$/;
const MAX_PENDING_EVENTS = 4096;

export class MatchLogTransform extends Transform {
  constructor(options: TransformOptions = {}) {
    super({ ...options, writableObjectMode: true });
  }

  override _transform(event: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      callback(null, `${JSON.stringify(event)}\n`);
    } catch (error: unknown) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

interface ActiveLog {
  readonly file: string;
  readonly room: Room;
  readonly onEvent: (event: LogEvent) => void;
  readonly task: Promise<void>;
  end(): void;
}

export class MatchLogStore {
  readonly directory: string;
  #active = new Set<ActiveLog>();
  #errors = new Map<string, unknown>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  start(room: Room): string {
    const file = `${room.id}-${Date.now()}-${randomUUID().slice(0, 8)}.ndjson`;
    const source = new PassThrough({ objectMode: true, highWaterMark: 16 });
    const pending: LogEvent[] = [];
    let blocked = false;
    let ending = false;
    let failed = false;
    const output = createWriteStream(resolve(this.directory, file), { flags: "wx", highWaterMark: 64 * 1024 });
    const flush = () => {
      blocked = false;
      while (!blocked) {
        const next = pending.shift();
        if (next === undefined) break;
        blocked = !source.write(next);
      }
      if (!blocked && pending.length === 0 && ending) source.end();
    };
    const onEvent = (event: LogEvent) => {
      if (ending || failed) return;
      if (blocked) {
        pending.push(event);
        if (pending.length > MAX_PENDING_EVENTS) {
          failed = true;
          pending.length = 0;
          room.off("event", onEvent);
          const error = new Error(`Match log queue exceeded ${MAX_PENDING_EVENTS} events for room ${room.id}`);
          source.destroy(error);
          room.emit("error", error);
          return;
        }
      } else {
        blocked = !source.write(event);
      }
      if (event.type === "empty") {
        ending = true;
        room.off("event", onEvent);
        if (!blocked && pending.length === 0) source.end();
      }
    };
    source.on("drain", flush);
    source.on("error", (error) => room.emit("error", error));
    room.on("event", onEvent);
    const task = pipeline(source, new MatchLogTransform(), output);
    task.catch((error: unknown) => {
      room.off("event", onEvent);
      this.#errors.set(file, error);
    });
    const entry: ActiveLog = {
      file,
      room,
      onEvent,
      task,
      end() {
        ending = true;
        if (!blocked && pending.length === 0) source.end();
      },
    };
    this.#active.add(entry);
    task.finally(() => this.#active.delete(entry)).catch(() => {});
    return file;
  }

  async list(): Promise<string[]> {
    const files = await readdir(this.directory, { withFileTypes: true });
    return files.filter((entry) => entry.isFile() && LOG_ID.test(entry.name)).map((entry) => entry.name);
  }

  resolveId(id: string): string | null {
    if (!LOG_ID.test(id)) return null;
    const file = resolve(this.directory, id);
    return file.startsWith(`${this.directory}\\`) || file.startsWith(`${this.directory}/`) ? file : null;
  }

  errorFor(file: string): unknown {
    return this.#errors.get(file);
  }

  async close(): Promise<void> {
    for (const entry of this.#active) {
      entry.room.off("event", entry.onEvent);
      entry.end();
    }
    const settled = await Promise.allSettled([...this.#active].map(({ task }) => task));
    for (const result of settled) if (result.status === "rejected") throw result.reason;
  }
}
