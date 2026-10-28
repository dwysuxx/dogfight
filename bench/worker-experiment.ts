// Go/no-go for moving snapshot decoding off the main thread.
// Main-thread cost per snapshot:
//   inline:  binaryCodec.decode(bytes)
//   worker:  postMessage(buffer, [buffer])  +  receiving the decoded object
//            (receiveMessageOnPort: the structured-clone deserialization the
//            main thread pays for when the result comes back)
// plus the latency the worker round trip adds before the snapshot is usable.
import { once } from "node:events";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import { Bot } from "../server/src/bots.ts";
import { Match } from "../server/src/match.ts";

// Realistic snapshots: a match with 8 bots and the house bot.
const match = new Match({ id: "worker", arena: { width: 1280, height: 720, asteroids: 10 }, maxPlayers: 16 });
const bots = Array.from({ length: 8 }, (_, i) => new Bot(`b${i}`, `Bot ${i}`, i + 1));
for (const bot of bots) match.join(bot);
const snapshots: Uint8Array<ArrayBuffer>[] = [];
for (let t = 0; t < 900; t++) {
  for (const bot of bots) match.receiveInputs(bot.id, [bot.next(match.world, match.player(bot.id)?.ship)]);
  match.step();
  const snapshot = match.snapshot(); // every tick, as the server does
  if (t >= 300) snapshots.push(binaryCodec.encode(snapshot));
}
const avgBytes = snapshots.reduce((n, s) => n + s.byteLength, 0) / snapshots.length;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const p99 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.99)] ?? 0;

// Inline decode (warm the JIT first).
for (let r = 0; r < 3; r++) for (const s of snapshots) binaryCodec.decode(s);
const inline: number[] = [];
for (const s of snapshots) {
  const t0 = performance.now();
  binaryCodec.decode(s);
  inline.push((performance.now() - t0) * 1000);
}

// Worker decode.
const { port1, port2 } = new MessageChannel();
const worker = new Worker(new URL("./decode-worker.ts", import.meta.url), { workerData: { port: port2 }, transferList: [port2] });
const post: number[] = [];
const receive: number[] = [];
const roundTrip: number[] = [];
for (let r = 0; r < 2; r++) {
  for (const s of snapshots) {
    const buffer = s.slice().buffer; // a fresh buffer: transferring detaches it
    const t0 = performance.now();
    worker.postMessage(buffer, [buffer]);
    const t1 = performance.now();
    await once(worker, "message");
    const t2 = performance.now();
    const result = receiveMessageOnPort(port1);
    const t3 = performance.now();
    if (!result) throw new Error("no result");
    if (r === 1) {
      post.push((t1 - t0) * 1000);
      receive.push((t3 - t2) * 1000);
      roundTrip.push((t3 - t0) * 1000);
    }
    if (buffer.byteLength !== 0) throw new Error("transfer should detach the sender's buffer");
  }
}
await worker.terminate();

const workerMain = post.map((p, i) => p + (receive[i] ?? 0));
console.log(`snapshot ~${avgBytes.toFixed(0)} bytes, ${snapshots.length} samples`);
console.log(`inline decode, main thread:          median ${median(inline).toFixed(1)} µs  p99 ${p99(inline).toFixed(1)} µs`);
console.log(`worker: postMessage (transfer):      median ${median(post).toFixed(1)} µs  p99 ${p99(post).toFixed(1)} µs`);
console.log(`worker: receive decoded (clone in):  median ${median(receive).toFixed(1)} µs  p99 ${p99(receive).toFixed(1)} µs`);
console.log(`worker: main-thread total:           median ${median(workerMain).toFixed(1)} µs  p99 ${p99(workerMain).toFixed(1)} µs`);
console.log(`worker: added latency (round trip):  median ${median(roundTrip).toFixed(1)} µs  p99 ${p99(roundTrip).toFixed(1)} µs`);
console.log(median(workerMain) < median(inline) ? "GO: the worker saves main-thread time" : "NO-GO: the worker costs the main thread more than decoding inline");
