import type { RawData } from "ws";
import { binaryCodec } from "@dogfight/shared/codec/binary.ts";
import {
  type ClientMessage,
  type Result,
  fail,
  ok,
  parseClientMessage,
  parseJson,
} from "@dogfight/shared/protocol.ts";

const textDecoder = new TextDecoder();

function bytesOf(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

// One WebSocket frame in, one validated ClientMessage (or a coded issue) out.
// A text frame is versioned JSON (any message); a binary frame is the
// DataView codec, and clients may only send input and ping that way.
export function decodeClientFrame(data: RawData, isBinary: boolean): Result<ClientMessage> {
  const bytes = bytesOf(data);
  if (isBinary) {
    const decoded = binaryCodec.decode(bytes);
    if (!decoded.ok) return decoded;
    const message = decoded.value;
    if (message.type === "input" || message.type === "ping") return ok(message);
    return fail("unknown-type", "Clients may only send input and ping as binary");
  }
  const json = parseJson(textDecoder.decode(bytes));
  return json.ok ? parseClientMessage(json.value) : json;
}
