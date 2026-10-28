import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDeterminismScenario } from "../sim/scenario.ts";

const SHARED = fileURLToPath(new URL("..", import.meta.url));
// Everything in the shared package except its tests must stay runtime-neutral.
const PURE = ["brand.ts", "bus.ts", "protocol.ts", "sim", "codec", "net"];

// The hash a correct build produces for the default scenario (seed 7, 1000
// steps). Chrome must print the same value for dogfightDeterminism().hash.
// Unchanged by the TypeScript migration: the runtime is the same JavaScript.
const GOLDEN_HASH = "313ef01b";

async function pureFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const entry of PURE) {
    if (entry.endsWith(".ts")) files.push(entry);
    else for (const file of await readdir(join(SHARED, entry))) if (file.endsWith(".ts")) files.push(`${entry}/${file}`);
  }
  return files;
}

test("determinism: same seed + same inputs => same hash, every run", () => {
  const first = runDeterminismScenario();
  const second = runDeterminismScenario();
  assert.equal(first.hash, second.hash);
  assert.equal(first.hash, GOLDEN_HASH, "compare with dogfightDeterminism() in the browser");
  assert.notEqual(runDeterminismScenario({ seed: 8 }).hash, first.hash);
});

test("the shared package imports in Node without any DOM", async () => {
  assert.equal(Reflect.has(globalThis, "window"), false);
  assert.equal(Reflect.has(globalThis, "document"), false);
  for (const file of await pureFiles()) {
    const module: unknown = await import(new URL(`../${file}`, import.meta.url).href);
    assert.equal(typeof module, "object", `${file} imports`); // type-only modules export nothing at runtime
  }
});

test("shared modules use no DOM, no Node built-ins and no non-deterministic calls", async () => {
  const forbidden = [
    /\bwindow\./,
    /\bdocument\./,
    /\bfrom "node:/,
    /\brequire\(/,
    /\bprocess\./,
    /\bBuffer\b/,
    /\bMath\.random\(/,
    /\bDate\.now\(/,
    /\bperformance\.now\(/,
  ];
  for (const file of await pureFiles()) {
    const source = (await readFile(join(SHARED, file), "utf8"))
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const pattern of forbidden) assert.doesNotMatch(source, pattern, `${file} must stay pure (${pattern})`);
  }
});
