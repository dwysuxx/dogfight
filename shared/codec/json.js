// The baseline codec: the logical message as JSON text, plus the version.
// Kept behind ?codec=json for the JSON-vs-binary comparison.
import { PROTOCOL_VERSION, ProtocolError } from "../protocol/messages.js";

export const name = "json";

export function encode(message) {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}

export function decode(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid-json", "Message must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProtocolError("invalid-message", "Message must be a JSON object");
  if (value.v !== PROTOCOL_VERSION)
    throw new ProtocolError("unsupported-version", "Unsupported protocol version");
  const message = { ...value };
  delete message.v;
  return message;
}
