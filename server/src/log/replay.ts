import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// Yields each NDJSON line as `unknown`: a replay file is a boundary too, and
// the caller decides what shape it expects.
export async function* readReplay(file: string): AsyncGenerator<unknown> {
  const input = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new SyntaxError(`Invalid match-log JSON line: ${reason}`, { cause: error });
      }
      yield value;
    }
  } finally {
    input.close();
  }
}
