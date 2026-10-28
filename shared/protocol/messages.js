// Message vocabulary shared by client and server. Both codecs (codec/json.js,
// codec/binary.js) encode exactly these logical shapes, so everything above
// the codec never knows which one is on the wire.
//
// client -> server   join, chat, netsim (always JSON text frames)
//                    input, ping        (JSON or binary, the client's choice)
// server -> client   joined, roster, chat, error (always JSON)
//                    state, pong        (in the codec the client joined with)

export const PROTOCOL_VERSION = 1;

export const TICK_RATE = 30; // server simulation and snapshot rate, Hz
export const TICK_SECONDS = 1 / TICK_RATE;

export const MESSAGE_TYPES = Object.freeze({
  JOIN: "join",
  CHAT: "chat",
  INPUT: "input",
  PING: "ping",
  NETSIM: "netsim",
  JOINED: "joined",
  ROSTER: "roster",
  STATE: "state",
  PONG: "pong",
  ERROR: "error",
});

export const CODECS = Object.freeze(["json", "binary"]);

// One input message repeats the newest few unacknowledged inputs, so a single
// dropped packet does not lose a key press (the server ignores duplicates).
export const MAX_INPUTS_PER_MESSAGE = 4;

export const CONTROL_KEYS = Object.freeze(["left", "right", "thrust", "fire"]);

export function packButtons(controls) {
  let bits = 0;
  CONTROL_KEYS.forEach((key, bit) => {
    if (controls[key]) bits |= 1 << bit;
  });
  return bits;
}

export function unpackButtons(bits) {
  const controls = {};
  CONTROL_KEYS.forEach((key, bit) => {
    controls[key] = (bits & (1 << bit)) !== 0;
  });
  return controls;
}

// Lookup tables: the binary codec sends the index, never the string.
export const ENTITY_KINDS = Object.freeze(["ship", "bullet", "asteroid", "pickup", "explosion"]);
export const EFFECT_NAMES = Object.freeze(["shield", "rapidfire", "homing"]);
export const EVENT_TYPES = Object.freeze(["fired", "hit", "exploded"]);

export class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Shape checks for a decoded input message (either codec): 1..4 inputs, seqs
// are consecutive uint32s, controls are exactly four booleans. Anything else
// is a broken or malicious client.
export function validateInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_INPUTS_PER_MESSAGE)
    throw new ProtocolError("invalid-input", `Input carries 1–${MAX_INPUTS_PER_MESSAGE} inputs`);
  inputs.forEach((input, index) => {
    const { seq, controls } = input ?? {};
    if (
      Object.keys(input ?? {}).some((key) => key !== "seq" && key !== "controls") ||
      !Number.isInteger(seq) ||
      seq < 1 ||
      seq > 0xffffffff ||
      (index > 0 && seq !== inputs[index - 1].seq + 1) ||
      !controls ||
      typeof controls !== "object" ||
      Object.keys(controls).length !== CONTROL_KEYS.length ||
      CONTROL_KEYS.some((key) => typeof controls[key] !== "boolean")
    )
      throw new ProtocolError(
        "invalid-input",
        "Inputs need consecutive integer seqs and left/right/thrust/fire booleans",
      );
  });
  return inputs;
}
