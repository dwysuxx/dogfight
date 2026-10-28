import * as binaryCodec from "@dogfight/shared/codec/binary.js";
import * as jsonCodec from "@dogfight/shared/codec/json.js";
import {
  CODECS,
  MESSAGE_TYPES,
  PROTOCOL_VERSION,
  ProtocolError,
  validateInputs,
} from "@dogfight/shared/protocol/messages.js";
import { validateNetSim } from "./netsim.js";

export { MESSAGE_TYPES, PROTOCOL_VERSION, ProtocolError };
export const CODEC_BY_NAME = { json: jsonCodec, binary: binaryCodec };

const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function onlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}

// A text frame is JSON (any message); a binary frame is the DataView codec
// (input and ping only). Either way the result is one validated logical
// message, or a ProtocolError with a code the client can see.
export function decodeClientMessage(data, isBinary) {
  if (isBinary) {
    const message = binaryCodec.decode(data);
    if (message.type !== MESSAGE_TYPES.INPUT && message.type !== MESSAGE_TYPES.PING)
      throw new ProtocolError("unknown-type", "Clients may only send input and ping as binary");
    return message;
  }
  const value = jsonCodec.decode(data.toString());
  const result = validateClientMessage({ v: PROTOCOL_VERSION, ...value });
  if (!result.ok) throw new ProtocolError(result.code, result.reason);
  return result.message;
}

export function validateClientMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, code: "invalid-message", reason: "Message must be a JSON object" };
  if (value.v !== PROTOCOL_VERSION)
    return { ok: false, code: "unsupported-version", reason: "Unsupported protocol version" };

  if (value.type === MESSAGE_TYPES.JOIN) {
    if (
      !onlyKeys(value, ["v", "type", "room", "name", "codec"]) ||
      typeof value.room !== "string" ||
      !ROOM_ID.test(value.room) ||
      typeof value.name !== "string" ||
      value.name.trim().length < 1 ||
      value.name.trim().length > 20 ||
      (value.codec !== undefined && !CODECS.includes(value.codec))
    )
      return {
        ok: false,
        code: "invalid-join",
        reason: "Join requires a room id, a 1–20 character name and an optional codec (json|binary)",
      };
    return {
      ok: true,
      message: { type: value.type, room: value.room, name: value.name.trim(), codec: value.codec ?? "json" },
    };
  }

  if (value.type === MESSAGE_TYPES.CHAT) {
    if (
      !onlyKeys(value, ["v", "type", "text"]) ||
      typeof value.text !== "string" ||
      value.text.trim().length < 1 ||
      value.text.trim().length > 500
    )
      return { ok: false, code: "invalid-chat", reason: "Chat text must contain 1–500 characters" };
    return { ok: true, message: { type: value.type, text: value.text.trim() } };
  }

  if (value.type === MESSAGE_TYPES.INPUT) {
    try {
      if (!onlyKeys(value, ["v", "type", "inputs"])) throw new ProtocolError("invalid-input", "Unexpected input fields");
      return { ok: true, message: { type: value.type, inputs: validateInputs(value.inputs) } };
    } catch (error) {
      return { ok: false, code: "invalid-input", reason: error.message };
    }
  }

  if (value.type === MESSAGE_TYPES.PING) {
    if (!onlyKeys(value, ["v", "type", "t"]) || typeof value.t !== "number" || !Number.isFinite(value.t))
      return { ok: false, code: "invalid-ping", reason: "Ping requires a finite number t" };
    return { ok: true, message: { type: value.type, t: value.t } };
  }

  if (value.type === MESSAGE_TYPES.NETSIM) {
    try {
      if (!onlyKeys(value, ["v", "type", "lag", "jitter", "drop"])) throw new RangeError("Unexpected netsim fields");
      return { ok: true, message: { type: value.type, ...validateNetSim(value) } };
    } catch (error) {
      return { ok: false, code: "invalid-netsim", reason: error.message };
    }
  }

  return { ok: false, code: "unknown-type", reason: "Unknown message type" };
}

export function serverMessage(type, fields = {}) {
  return { v: PROTOCOL_VERSION, type, ...fields };
}
