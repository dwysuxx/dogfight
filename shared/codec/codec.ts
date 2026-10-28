// The JSON-vs-binary switch is this interface: two implementations of the
// same contract for the realtime messages (input, ping, pong, state). Control
// messages (join, chat, roster, ...) are always JSON text frames.
import type { CodecName, RealtimeMessage, Result } from "../protocol.ts";

export type Payload = string | Uint8Array<ArrayBuffer>;
export type IncomingPayload = string | ArrayBuffer | Uint8Array;

export interface Codec {
  readonly name: CodecName;
  encode(message: RealtimeMessage): Payload;
  // Never throws: malformed input becomes { ok: false, error }.
  decode(payload: IncomingPayload): Result<RealtimeMessage>;
}
