export const PROTOCOL_VERSION = 0;
export const MESSAGE_TYPES = Object.freeze({
  JOIN: "join",
  CHAT: "chat",
  ROSTER: "roster",
  ERROR: "error",
});

const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function validateClientMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, code: "invalid-message", reason: "Message must be a JSON object" };
  if (value.v !== PROTOCOL_VERSION)
    return { ok: false, code: "unsupported-version", reason: "Unsupported protocol version" };

  if (value.type === MESSAGE_TYPES.JOIN) {
    if (
      Object.keys(value).some((key) => !["v", "type", "room", "name"].includes(key)) ||
      typeof value.room !== "string" ||
      !ROOM_ID.test(value.room) ||
      typeof value.name !== "string" ||
      value.name.trim().length < 1 ||
      value.name.trim().length > 20
    )
      return { ok: false, code: "invalid-join", reason: "Join requires a room id and a 1–20 character name" };
    return { ok: true, message: { ...value, room: value.room, name: value.name.trim() } };
  }

  if (value.type === MESSAGE_TYPES.CHAT) {
    if (
      Object.keys(value).some((key) => !["v", "type", "text"].includes(key)) ||
      typeof value.text !== "string" ||
      value.text.trim().length < 1 ||
      value.text.trim().length > 500
    )
      return { ok: false, code: "invalid-chat", reason: "Chat text must contain 1–500 characters" };
    return { ok: true, message: { ...value, text: value.text.trim() } };
  }

  return { ok: false, code: "unknown-type", reason: "Unknown message type" };
}

export function serverMessage(type, fields = {}) {
  return { v: PROTOCOL_VERSION, type, ...fields };
}
