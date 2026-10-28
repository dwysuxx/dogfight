// Worker side of the experiment: decode a transferred snapshot buffer and
// send the decoded message back (structured clone).
import { type MessagePort, parentPort, workerData } from "node:worker_threads";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";

function isPort(value: unknown): value is MessagePort {
  return typeof value === "object" && value !== null && "postMessage" in value;
}
const data: unknown = workerData; // typed any by Node: narrow it
const port: unknown = typeof data === "object" && data !== null && "port" in data ? data.port : null;
if (!isPort(port) || !parentPort) throw new Error("decode-worker needs a port");
const parent = parentPort;

parent.on("message", (buffer: unknown) => {
  if (!(buffer instanceof ArrayBuffer)) return;
  const decoded = binaryCodec.decode(buffer);
  port.postMessage(decoded.ok ? decoded.value : null);
  parent.postMessage("done");
});
