import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function* readReplay(file) {
  const input = createInterface({
    input: createReadStream(file),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of input) {
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch (error) {
        throw new SyntaxError(`Invalid match-log JSON line: ${error.message}`, { cause: error });
      }
    }
  } finally {
    input.close();
  }
}
