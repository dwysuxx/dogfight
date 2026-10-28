import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runDeterminismScenario } from "../sim/scenario.js";

const SHARED = fileURLToPath(new URL("..", import.meta.url));
const PURE_DIRECTORIES = ["sim", "protocol", "codec", "net"];

// The hash a correct build produces for the default scenario (seed 7, 1000
// steps). Chrome must print the same value for dogfightDeterminism().hash.
// If you change the simulation on purpose, update it here.
const GOLDEN_HASH = "313ef01b";

test("determinism: same seed + same inputs => same hash, every run", () => {
  const first = runDeterminismScenario();
  const second = runDeterminismScenario();
  assert.equal(first.hash, second.hash);
  assert.equal(first.hash, GOLDEN_HASH, "compare with dogfightDeterminism() in the browser");
  assert.notEqual(runDeterminismScenario({ seed: 8 }).hash, first.hash);
});

test("the shared package imports in Node without any DOM", async () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(typeof globalThis.document, "undefined");
  for (const directory of PURE_DIRECTORIES) {
    for (const file of await readdir(join(SHARED, directory))) {
      if (!file.endsWith(".js")) continue;
      const module = await import(new URL(`../${directory}/${file}`, import.meta.url));
      assert.ok(Object.keys(module).length > 0, `${directory}/${file} exports something`);
    }
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
  for (const directory of PURE_DIRECTORIES) {
    for (const file of await readdir(join(SHARED, directory))) {
      if (!file.endsWith(".js")) continue;
      const source = (await readFile(join(SHARED, directory, file), "utf8"))
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");
      for (const pattern of forbidden)
        assert.doesNotMatch(source, pattern, `${directory}/${file} must stay pure (${pattern})`);
    }
  }
});
