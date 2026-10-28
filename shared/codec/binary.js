// Binary codec on DataView. THE SPEC (version = PROTOCOL_VERSION = 1):
//
//   * Every multi-byte field is LITTLE-ENDIAN. A typed array view would use
//     the CPU's byte order; a protocol must not, so everything goes through
//     DataView with `true` as the littleEndian argument.
//   * Byte 0 = message type, byte 1 = protocol version. A frame with an
//     unknown type, wrong version, wrong length or non-zero reserved bits is
//     rejected (ProtocolError), never "best-effort" parsed.
//
//   type  1 INPUT  c->s  [u8 type][u8 v][u8 n = 1..4]
//                        n x { u32 seq, u8 buttons }      oldest first, seqs consecutive
//                        buttons: bit0 left, bit1 right, bit2 thrust, bit3 fire, bits4-7 = 0
//   type  2 PING   c->s  [u8 type][u8 v][f64 t]           t = client clock (ms), echoed back
//   type 16 STATE  s->c  [u8 type][u8 v][u32 tick][u32 ack][u16 entities][u8 events]   = 13 bytes
//                        events x { u8 event (0 fired, 1 hit, 2 exploded), u16 entity id }
//                        entities x { common, kind-specific }
//   type 17 PONG   s->c  [u8 type][u8 v][f64 t][u32 tick]
//
//   common (13)   u16 id, u8 kind (0 ship, 1 bullet, 2 asteroid, 3 pickup, 4 explosion),
//                 f32 x, f32 y, i16 angle in 1/1000 rad (wrapped to (-pi, pi]: 0.0005 rad max error)
//   ship (+23)    f32 vx, f32 vy, u8 hp, u32 score, u8 owner, u8 flags (bit0 bot, bit1 thrusting),
//                 u16 fireCooldown (0.1 ms), u16 shield/rapidfire/homing left (ms, 0 = none)
//   bullet (+16)  f32 vx, f32 vy, u8 owner, u32 seq, u16 ttl (0.1 ms), u8 flags (bit0 homing)
//   asteroid (+16) u16 radius (0.01 px), u8 hp, u8 maxHp, u8 flags (bit0 homing),
//                 11 x u8 outline (0.75 + b/255 * 0.4)
//   pickup (+1)   u8 effect (0 shield, 1 rapidfire, 2 homing)
//   explosion (+8) u8 r, u8 g, u8 b, u8 particle count, u16 speed (px/s), u16 age (ms)
//
// `ack` (lastProcessedSeq) is the only per-client field, so the server
// encodes a snapshot once and patches bytes 6..9 per client (withAck).
import { wrapAngle } from "../sim/math.js";
import {
  EFFECT_NAMES,
  ENTITY_KINDS,
  EVENT_TYPES,
  MAX_INPUTS_PER_MESSAGE,
  PROTOCOL_VERSION,
  ProtocolError,
  packButtons,
  unpackButtons,
  validateInputs,
} from "../protocol/messages.js";

export const name = "binary";

export const TYPE = Object.freeze({ INPUT: 1, PING: 2, STATE: 16, PONG: 17 });
const STATE_HEADER = 13;
const ACK_OFFSET = 6;
const COMMON = 13;
const KIND_SIZE = { ship: 23, bullet: 16, asteroid: 16, pickup: 1, explosion: 8 };
const SHAPE_POINTS = 11;
const LE = true;

// --- primitives -------------------------------------------------------------

const toU8 = (value) => Math.max(0, Math.min(0xff, Math.round(value)));
const toU16 = (value) => Math.max(0, Math.min(0xffff, Math.round(value)));
const toU32 = (value) => Math.max(0, Math.min(0xffffffff, Math.round(value)));
const toAngle = (angle) => Math.round(wrapAngle(angle) * 1000); // |value| <= 3142 fits i16

function hexToRgb(color) {
  const match = /^#([0-9a-f]{6})$/i.exec(color ?? "");
  const n = match ? parseInt(match[1], 16) : 0xffffff;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const rgbToHex = (r, g, b) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;

function header(view, type) {
  view.setUint8(0, type);
  view.setUint8(1, PROTOCOL_VERSION);
}

function bytesOf(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new ProtocolError("invalid-message", "Binary message must be an ArrayBuffer or a byte view");
}

// --- encode -------------------------------------------------------------------

export function encode(message) {
  switch (message.type) {
    case "input":
      return encodeInput(message);
    case "ping":
      return encodePing(message);
    case "pong":
      return encodePong(message);
    case "state":
      return encodeState(message);
    default:
      throw new ProtocolError("unknown-type", `No binary encoding for ${message.type}`);
  }
}

function encodeInput({ inputs }) {
  validateInputs(inputs);
  const bytes = new Uint8Array(3 + inputs.length * 5);
  const view = new DataView(bytes.buffer);
  header(view, TYPE.INPUT);
  view.setUint8(2, inputs.length);
  inputs.forEach(({ seq, controls }, i) => {
    view.setUint32(3 + i * 5, seq, LE);
    view.setUint8(7 + i * 5, packButtons(controls));
  });
  return bytes;
}

function encodePing({ t }) {
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  header(view, TYPE.PING);
  view.setFloat64(2, t, LE);
  return bytes;
}

function encodePong({ t, tick }) {
  const bytes = new Uint8Array(14);
  const view = new DataView(bytes.buffer);
  header(view, TYPE.PONG);
  view.setFloat64(2, t, LE);
  view.setUint32(10, tick, LE);
  return bytes;
}

export function stateSize(state) {
  let size = STATE_HEADER + state.events.length * 3;
  for (const entity of state.entities) size += COMMON + KIND_SIZE[entity.kind];
  return size;
}

function encodeState(state) {
  if (state.entities.length > 0xffff || state.events.length > 0xff)
    throw new RangeError("Snapshot is too large for the binary format");
  const bytes = new Uint8Array(stateSize(state));
  const view = new DataView(bytes.buffer);
  header(view, TYPE.STATE);
  view.setUint32(2, state.tick, LE);
  view.setUint32(ACK_OFFSET, state.ack ?? 0, LE);
  view.setUint16(10, state.entities.length, LE);
  view.setUint8(12, state.events.length);

  let o = STATE_HEADER;
  for (const event of state.events) {
    view.setUint8(o, EVENT_TYPES.indexOf(event.type));
    view.setUint16(o + 1, event.id, LE);
    o += 3;
  }

  for (const e of state.entities) {
    const kind = ENTITY_KINDS.indexOf(e.kind);
    if (kind < 0) throw new RangeError(`Unknown entity kind ${e.kind}`);
    if (!Number.isInteger(e.id) || e.id < 0 || e.id > 0xffff)
      throw new RangeError(`Entity id ${e.id} does not fit a u16`);
    view.setUint16(o, e.id, LE);
    view.setUint8(o + 2, kind);
    view.setFloat32(o + 3, e.x, LE);
    view.setFloat32(o + 7, e.y, LE);
    view.setInt16(o + 11, toAngle(e.angle), LE);
    o += COMMON;

    switch (e.kind) {
      case "ship":
        view.setFloat32(o, e.vx, LE);
        view.setFloat32(o + 4, e.vy, LE);
        view.setUint8(o + 8, toU8(e.hp));
        view.setUint32(o + 9, toU32(e.score), LE);
        view.setUint8(o + 13, e.owner);
        view.setUint8(o + 14, (e.bot ? 1 : 0) | (e.thrusting ? 2 : 0));
        view.setUint16(o + 15, toU16(e.fireCooldown * 10_000), LE);
        EFFECT_NAMES.forEach((effect, i) => {
          const left = e.effects[effect];
          // ceil: a still-running effect never rounds down to "none"
          view.setUint16(o + 17 + i * 2, left > 0 ? Math.min(0xffff, Math.ceil(left * 1000)) : 0, LE);
        });
        break;
      case "bullet":
        view.setFloat32(o, e.vx, LE);
        view.setFloat32(o + 4, e.vy, LE);
        view.setUint8(o + 8, e.owner);
        view.setUint32(o + 9, toU32(e.seq), LE);
        view.setUint16(o + 13, toU16(e.ttl * 10_000), LE);
        view.setUint8(o + 15, e.homing ? 1 : 0);
        break;
      case "asteroid":
        view.setUint16(o, toU16(e.radius * 100), LE);
        view.setUint8(o + 2, toU8(e.hp));
        view.setUint8(o + 3, toU8(e.maxHp));
        view.setUint8(o + 4, e.homing ? 1 : 0);
        for (let i = 0; i < SHAPE_POINTS; i++)
          view.setUint8(o + 5 + i, toU8(((e.shape[i] - 0.75) / 0.4) * 255));
        break;
      case "pickup":
        view.setUint8(o, EFFECT_NAMES.indexOf(e.effect));
        break;
      case "explosion": {
        const [r, g, b] = hexToRgb(e.color);
        view.setUint8(o, r);
        view.setUint8(o + 1, g);
        view.setUint8(o + 2, b);
        view.setUint8(o + 3, toU8(e.count));
        view.setUint16(o + 4, toU16(e.speed), LE);
        view.setUint16(o + 6, toU16(e.age * 1000), LE);
        break;
      }
    }
    o += KIND_SIZE[e.kind];
  }
  return bytes;
}

// A copy of an encoded snapshot with this client's lastProcessedSeq.
export function withAck(bytes, ack) {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(ACK_OFFSET, ack, LE);
  return copy;
}

// --- decode -------------------------------------------------------------------

export function decode(data) {
  const bytes = bytesOf(data);
  if (bytes.byteLength < 2) throw new ProtocolError("invalid-message", "Binary message is too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(1) !== PROTOCOL_VERSION)
    throw new ProtocolError("unsupported-version", "Unsupported protocol version");
  const type = view.getUint8(0);
  try {
    switch (type) {
      case TYPE.INPUT:
        return decodeInput(view);
      case TYPE.PING:
        expectLength(view, 10);
        return { type: "ping", t: view.getFloat64(2, LE) };
      case TYPE.PONG:
        expectLength(view, 14);
        return { type: "pong", t: view.getFloat64(2, LE), tick: view.getUint32(10, LE) };
      case TYPE.STATE:
        return decodeState(view);
    }
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    // A DataView read past the end throws RangeError: a truncated frame.
    throw new ProtocolError("invalid-message", `Malformed binary message: ${error.message}`);
  }
  throw new ProtocolError("unknown-type", `Unknown binary message type ${type}`);
}

function expectLength(view, length) {
  if (view.byteLength !== length)
    throw new ProtocolError("invalid-message", `Expected ${length} bytes, got ${view.byteLength}`);
}

function decodeInput(view) {
  const n = view.getUint8(2);
  if (n < 1 || n > MAX_INPUTS_PER_MESSAGE)
    throw new ProtocolError("invalid-input", `Input carries 1–${MAX_INPUTS_PER_MESSAGE} inputs`);
  expectLength(view, 3 + n * 5);
  const inputs = [];
  for (let i = 0; i < n; i++) {
    const buttons = view.getUint8(7 + i * 5);
    if (buttons & 0xf0) throw new ProtocolError("invalid-input", "Reserved input bits must be zero");
    inputs.push({ seq: view.getUint32(3 + i * 5, LE), controls: unpackButtons(buttons) });
  }
  return { type: "input", inputs: validateInputs(inputs) };
}

function decodeState(view) {
  const state = {
    type: "state",
    tick: view.getUint32(2, LE),
    ack: view.getUint32(ACK_OFFSET, LE),
    events: [],
    entities: [],
  };
  const entityCount = view.getUint16(10, LE);
  const eventCount = view.getUint8(12);

  let o = STATE_HEADER;
  for (let i = 0; i < eventCount; i++) {
    const type = EVENT_TYPES[view.getUint8(o)];
    if (!type) throw new ProtocolError("invalid-message", "Unknown event type");
    state.events.push({ type, id: view.getUint16(o + 1, LE) });
    o += 3;
  }

  for (let i = 0; i < entityCount; i++) {
    const kind = ENTITY_KINDS[view.getUint8(o + 2)];
    if (!kind) throw new ProtocolError("invalid-message", "Unknown entity kind");
    const e = {
      id: view.getUint16(o, LE),
      kind,
      x: view.getFloat32(o + 3, LE),
      y: view.getFloat32(o + 7, LE),
      angle: view.getInt16(o + 11, LE) / 1000,
    };
    o += COMMON;
    switch (kind) {
      case "ship": {
        const flags = view.getUint8(o + 14);
        e.vx = view.getFloat32(o, LE);
        e.vy = view.getFloat32(o + 4, LE);
        e.hp = view.getUint8(o + 8);
        e.score = view.getUint32(o + 9, LE);
        e.owner = view.getUint8(o + 13);
        e.bot = (flags & 1) !== 0;
        e.thrusting = (flags & 2) !== 0;
        e.fireCooldown = view.getUint16(o + 15, LE) / 10_000;
        e.effects = {};
        EFFECT_NAMES.forEach((effect, j) => {
          const ms = view.getUint16(o + 17 + j * 2, LE);
          if (ms > 0) e.effects[effect] = ms / 1000;
        });
        break;
      }
      case "bullet":
        e.vx = view.getFloat32(o, LE);
        e.vy = view.getFloat32(o + 4, LE);
        e.owner = view.getUint8(o + 8);
        e.seq = view.getUint32(o + 9, LE);
        e.ttl = view.getUint16(o + 13, LE) / 10_000;
        e.homing = (view.getUint8(o + 15) & 1) !== 0;
        break;
      case "asteroid":
        e.radius = view.getUint16(o, LE) / 100;
        e.hp = view.getUint8(o + 2);
        e.maxHp = view.getUint8(o + 3);
        e.homing = (view.getUint8(o + 4) & 1) !== 0;
        e.shape = [];
        for (let j = 0; j < SHAPE_POINTS; j++) e.shape.push(0.75 + (view.getUint8(o + 5 + j) / 255) * 0.4);
        break;
      case "pickup":
        e.effect = EFFECT_NAMES[view.getUint8(o)];
        if (!e.effect) throw new ProtocolError("invalid-message", "Unknown pickup effect");
        break;
      case "explosion":
        e.color = rgbToHex(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2));
        e.count = view.getUint8(o + 3);
        e.speed = view.getUint16(o + 4, LE);
        e.age = view.getUint16(o + 6, LE) / 1000;
        break;
    }
    o += KIND_SIZE[kind];
    state.entities.push(e);
  }
  expectLength(view, o);
  return state;
}
