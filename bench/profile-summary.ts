// Summarize V8 profiles written by --cpu-prof / --heap-prof:
//   node bench/profile-summary.ts bench/profiles/<file>.cpuprofile
//   node bench/profile-summary.ts bench/profiles/<file>.heapprofile
// Prints the top functions by self time / by bytes allocated.
import { readFile } from "node:fs/promises";
import { z } from "zod";

const CallFrame = z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() });
const CpuProfile = z.object({
  nodes: z.array(z.object({ id: z.number(), callFrame: CallFrame, hitCount: z.number().optional() })),
  samples: z.array(z.number()),
  timeDeltas: z.array(z.number()),
});
interface HeapNode {
  callFrame: z.infer<typeof CallFrame>;
  selfSize: number;
  children: HeapNode[];
}
const HeapNodeSchema: z.ZodType<HeapNode> = z.lazy(() =>
  z.object({ callFrame: CallFrame, selfSize: z.number(), children: z.array(HeapNodeSchema) }),
);
const HeapProfile = z.object({ head: HeapNodeSchema });

const where = (frame: z.infer<typeof CallFrame>) => {
  const file = frame.url.replace(/^.*\/dogfight\//, "").replace(/^file:\/\/\//, "");
  return `${frame.functionName || "(anonymous)"}  ${file}:${frame.lineNumber + 1}`;
};

function top(entries: Map<string, number>, count: number, unit: (n: number) => string, total: number): void {
  const sorted = [...entries].sort((a, b) => b[1] - a[1]).slice(0, count);
  for (const [name, value] of sorted) console.log(`${unit(value).padStart(10)}  ${((value / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
}

const [path, countArg] = process.argv.slice(2);
if (!path) throw new Error("usage: profile-summary.ts <file> [count]");
const count = Number(countArg ?? 12);
const raw: unknown = JSON.parse(await readFile(path, "utf8"));

if (path.endsWith(".cpuprofile")) {
  const profile = CpuProfile.parse(raw);
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<string, number>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const dt = (profile.timeDeltas[i] ?? 0) / 1000;
    total += dt;
    if (!node) return;
    const key = where(node.callFrame);
    self.set(key, (self.get(key) ?? 0) + dt);
  });
  console.log(`CPU self time, total ${total.toFixed(0)} ms`);
  top(self, count, (ms) => `${ms.toFixed(1)} ms`, total);
} else {
  const profile = HeapProfile.parse(raw);
  const bytes = new Map<string, number>();
  let total = 0;
  const walk = (node: HeapNode) => {
    if (node.selfSize > 0) {
      const key = where(node.callFrame);
      bytes.set(key, (bytes.get(key) ?? 0) + node.selfSize);
      total += node.selfSize;
    }
    node.children.forEach(walk);
  };
  walk(profile.head);
  console.log(`Sampled allocations, total ${(total / 2 ** 20).toFixed(1)} MiB`);
  top(bytes, count, (n) => `${(n / 1024).toFixed(0)} KiB`, total);
}
