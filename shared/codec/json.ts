// The baseline codec: the logical message as versioned JSON text, validated
// on the way in by the same zod schemas as everything else. Kept behind
// ?codec=json for the JSON-vs-binary comparison.
import { z } from "zod";
import {
  InputMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  PROTOCOL_VERSION,
  type RealtimeMessage,
  type Result,
  StateMessageSchema,
  check,
  encodeJson,
  fail,
  parseJson,
} from "../protocol.ts";
import type { Codec, IncomingPayload } from "./codec.ts";

const RealtimeMessageSchema = z.discriminatedUnion("type", [
  InputMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
  StateMessageSchema,
]);

export const jsonCodec = {
  name: "json",
  encode: (message: RealtimeMessage): string => encodeJson(message),
  decode(payload: IncomingPayload): Result<RealtimeMessage> {
    if (typeof payload !== "string") return fail("invalid-message", "The JSON codec expects a text frame");
    const parsed = parseJson(payload);
    if (!parsed.ok) return parsed;
    const value = parsed.value;
    if (typeof value !== "object" || value === null || !("v" in value) || value.v !== PROTOCOL_VERSION)
      return fail("unsupported-version", "Unsupported protocol version");
    const { v: _version, ...message } = value;
    return check(RealtimeMessageSchema, message);
  },
} satisfies Codec;
