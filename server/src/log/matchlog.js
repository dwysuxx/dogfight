import { mkdir, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const LOG_ID = /^[a-z0-9-]+-\d+-[a-f0-9]{8}\.ndjson$/;
const MAX_PENDING_EVENTS = 4096;

export class MatchLogTransform extends Transform {
  constructor(options = {}) {
    super({ ...options, writableObjectMode: true });
  }

  _transform(event, _encoding, callback) {
    try {
      callback(null, `${JSON.stringify(event)}\n`);
    } catch (error) {
      callback(error);
    }
  }
}

export class MatchLogStore {
  #active = new Set();
  #errors = new Map();

  constructor(directory) {
    this.directory = resolve(directory);
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
  }

  start(room) {
    const file = `${room.id}-${Date.now()}-${randomUUID().slice(0, 8)}.ndjson`;
    const source = new PassThrough({ objectMode: true, highWaterMark: 16 });
    const pending = [];
    let blocked = false;
    let ending = false;
    let failed = false;
    const output = createWriteStream(resolve(this.directory, file), {
      flags: "wx",
      highWaterMark: 64 * 1024,
    });
    const flush = () => {
      blocked = false;
      while (!blocked && pending.length > 0) blocked = !source.write(pending.shift());
      if (!blocked && pending.length === 0 && ending) source.end();
    };
    const onEvent = (event) => {
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
    task.catch((error) => {
      room.off("event", onEvent);
      this.#errors.set(file, error);
    });
    const entry = {
      file,
      source,
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

  async list() {
    const files = await readdir(this.directory, { withFileTypes: true });
    return files.filter((entry) => entry.isFile() && LOG_ID.test(entry.name)).map((entry) => entry.name);
  }

  resolveId(id) {
    if (!LOG_ID.test(id)) return null;
    const file = resolve(this.directory, id);
    return file.startsWith(`${this.directory}\\`) || file.startsWith(`${this.directory}/`)
      ? file
      : null;
  }

  errorFor(file) {
    return this.#errors.get(file);
  }

  async close() {
    for (const entry of this.#active) {
      entry.room.off("event", entry.onEvent);
      entry.end();
    }
    const settled = await Promise.allSettled([...this.#active].map(({ task }) => task));
    const failure = settled.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
