// One load-generator process: `count` scripted pilots in one room. Started by
// load-test.ts so that several generators share the work (one Node process
// cannot read hundreds of MB/s of snapshots alone). Stops on IPC "stop".
import { WebSocket } from "ws";
import { seq } from "@dogfight/shared/brand.ts";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import { type Controls, type InputFrame, PROTOCOL_VERSION } from "@dogfight/shared/protocol.ts";

const [port, room, countArg, offsetArg] = process.argv.slice(2);
const count = Number(countArg);
const offset = Number(offsetArg ?? 0);
const sockets: WebSocket[] = [];
const timers: ReturnType<typeof setInterval>[] = [];

for (let i = 0; i < count; i++) {
  const index = offset + i;
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  socket.binaryType = "arraybuffer";
  socket.on("error", () => {});
  sockets.push(socket);
  const recent: InputFrame[] = [];
  let n = 0;
  socket.on("open", () => {
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "join", room, name: `load-${index}`, codec: "binary" }));
    timers.push(
      setInterval(() => {
        const step = n + index * 17;
        const controls: Controls = { left: step % 90 < 20, right: step % 140 > 115, thrust: step % 60 < 40, fire: step % 30 < 6 };
        recent.push({ seq: seq(++n), controls });
        if (recent.length > 4) recent.shift();
        if (socket.readyState === WebSocket.OPEN) socket.send(binaryCodec.encode({ type: "input", inputs: recent }));
      }, 1000 / 30),
    );
  });
}

process.on("message", (message: unknown) => {
  if (message !== "stop") return;
  for (const timer of timers) clearInterval(timer);
  for (const socket of sockets) socket.terminate();
  process.disconnect?.();
});
