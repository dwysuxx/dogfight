// Binary codec on DataView. THE SPEC (version = PROTOCOL_VERSION = 1):
//
//   * Every multi-byte field is LITTLE-ENDIAN. A typed array view would use
//     the CPU's byte order; a protocol must not, so everything goes through
//     DataView with `true` as the littleEndian argument.
//   * Byte 0 = message type, byte 1 = protocol version. A frame with an
//     unknown type, wrong version, wrong length or non-zero reserved bits is
//     rejected (an error Result), never "best-effort" parsed. The decoder IS
//     the validator for binary frames.
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
import { type Seq, entityId, playerId, seq, tick } from "../brand.ts";
import {
  CONTROL_KEYS,
  type Controls,
  EFFECT_NAMES,
  ENTITY_KINDS,
  EVENT_TYPES,
  type EffectName,
  type EntityKind,
  type EntitySnapshot,
  type GameEvent,
  type InputFrame,
  type InputMessage,
  MAX_INPUTS_PER_MESSAGE,
  PROTOCOL_VERSION,
  type PingMessage,
  type PongMessage,
  type RealtimeMessage,
  type Result,
  type StateMessage,
  assertNever,
  fail,
  ok,
} from "../protocol.ts";
import { wrapAngle } from "../sim/math.ts";
import type { Codec, IncomingPayload } from "./codec.ts";

export const TYPE = { INPUT: 1, PING: 2, STATE: 16, PONG: 17 } as const;
const STATE_HEADER = 13;
const ACK_OFFSET = 6;
const COMMON = 13;
const KIND_SIZE = { ship: 23, bullet: 16, asteroid: 16, pickup: 1, explosion: 8 } as const satisfies Record<EntityKind, number>;
const SHAPE_POINTS = 11;
const LE = true;

// A malformed frame inside the decoder; caught at the top and turned into a Result.
class FrameError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// --- primitives -------------------------------------------------------------

const toU8 = (value: number) => Math.max(0, Math.min(0xff, Math.round(value)));
const toU16 = (value: number) => Math.max(0, Math.min(0xffff, Math.round(value)));
const toU32 = (value: number) => Math.max(0, Math.min(0xffffffff, Math.round(value)));
const toAngle = (angle: number) => Math.round(wrapAngle(angle) * 1000); // |value| <= 3142 fits i16

function hexToRgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  const n = hex ? parseInt(hex, 16) : 0xffffff;
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

const rgbToHex = (r: number, g: number, b: number) => `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;

function packButtons(controls: Controls): number {
  let bits = 0;
  CONTROL_KEYS.forEach((key, bit) => {
    if (controls[key]) bits |= 1 << bit;
  });
  return bits;
}

function unpackButtons(bits: number): Controls {
  const on = (bit: number) => (bits & (1 << bit)) !== 0;
  return { left: on(0), right: on(1), thrust: on(2), fire: on(3) };
}

// Index -> name in a lookup table, or a FrameError for an index off the end.
function lookup<T>(table: readonly T[], index: number, what: string): T {
  const value = table[index];
  if (value === undefined) throw new FrameError("invalid-message", `Unknown ${what} ${index}`);
  return value;
}

function newFrame(size: number, type: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, type);
  view.setUint8(1, PROTOCOL_VERSION);
  return { bytes, view };
}

// --- encode -------------------------------------------------------------------

function encodeInput({ inputs }: InputMessage): Uint8Array<ArrayBuffer> {
  const { bytes, view } = newFrame(3 + inputs.length * 5, TYPE.INPUT);
  view.setUint8(2, inputs.length);
  inputs.forEach(({ seq, controls }, i) => {
    view.setUint32(3 + i * 5, seq, LE);
    view.setUint8(7 + i * 5, packButtons(controls));
  });
  return bytes;
}

function encodePing({ t }: PingMessage): Uint8Array<ArrayBuffer> {
  const { bytes, view } = newFrame(10, TYPE.PING);
  view.setFloat64(2, t, LE);
  return bytes;
}

function encodePong({ t, tick }: PongMessage): Uint8Array<ArrayBuffer> {
  const { bytes, view } = newFrame(14, TYPE.PONG);
  view.setFloat64(2, t, LE);
  view.setUint32(10, tick, LE);
  return bytes;
}

// The events count is a u8. Events are cosmetic (sounds), so a tick with more
// than 255 of them sends the first 255 instead of failing: a throw here would
// escape the server's tick and freeze the match (found by the Lab 7 worker
// experiment; covered by a test).
const MAX_EVENTS = 0xff;
const sentEvents = (state: StateMessage) => Math.min(state.events.length, MAX_EVENTS);

export function stateSize(state: StateMessage): number {
  let size = STATE_HEADER + sentEvents(state) * 3;
  for (const entity of state.entities) size += COMMON + KIND_SIZE[entity.kind];
  return size;
}

function encodeEntity(view: DataView, o: number, e: EntitySnapshot): void {
  view.setUint16(o, e.id, LE);
  view.setUint8(o + 2, ENTITY_KINDS.indexOf(e.kind));
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
        const left = e.effects[effect] ?? 0;
        // ceil: a still-running effect never rounds down to "none"
        view.setUint16(o + 17 + i * 2, left > 0 ? Math.min(0xffff, Math.ceil(left * 1000)) : 0, LE);
      });
      return;
    case "bullet":
      view.setFloat32(o, e.vx, LE);
      view.setFloat32(o + 4, e.vy, LE);
      view.setUint8(o + 8, e.owner);
      view.setUint32(o + 9, e.seq, LE);
      view.setUint16(o + 13, toU16(e.ttl * 10_000), LE);
      view.setUint8(o + 15, e.homing ? 1 : 0);
      return;
    case "asteroid":
      view.setUint16(o, toU16(e.radius * 100), LE);
      view.setUint8(o + 2, toU8(e.hp));
      view.setUint8(o + 3, toU8(e.maxHp));
      view.setUint8(o + 4, e.homing ? 1 : 0);
      e.shape.forEach((point, i) => {
        if (i < SHAPE_POINTS) view.setUint8(o + 5 + i, toU8(((point - 0.75) / 0.4) * 255));
      });
      return;
    case "pickup":
      view.setUint8(o, EFFECT_NAMES.indexOf(e.effect));
      return;
    case "explosion": {
      const [r, g, b] = hexToRgb(e.color);
      view.setUint8(o, r);
      view.setUint8(o + 1, g);
      view.setUint8(o + 2, b);
      view.setUint8(o + 3, toU8(e.count));
      view.setUint16(o + 4, toU16(e.speed), LE);
      view.setUint16(o + 6, toU16(e.age * 1000), LE);
      return;
    }
    default:
      return assertNever(e, "entity kind");
  }
}

function encodeState(state: StateMessage): Uint8Array<ArrayBuffer> {
  if (state.entities.length > 0xffff) throw new RangeError("Snapshot has more entities than u16 ids allow");
  const eventCount = sentEvents(state);
  const { bytes, view } = newFrame(stateSize(state), TYPE.STATE);
  view.setUint32(2, state.tick, LE);
  view.setUint32(ACK_OFFSET, state.ack, LE);
  view.setUint16(10, state.entities.length, LE);
  view.setUint8(12, eventCount);

  let o = STATE_HEADER;
  const { events, entities } = state;
  for (let i = 0; i < eventCount; i++) {
    const event = events[i];
    if (!event) continue;
    view.setUint8(o, EVENT_TYPES.indexOf(event.type));
    view.setUint16(o + 1, event.id, LE);
    o += 3;
  }
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (!entity) continue;
    encodeEntity(view, o, entity);
    o += COMMON + KIND_SIZE[entity.kind];
  }
  return bytes;
}

export function encode(message: RealtimeMessage): Uint8Array<ArrayBuffer> {
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
      return assertNever(message, "message type");
  }
}

// A copy of an encoded snapshot with this client's lastProcessedSeq.
export function withAck(bytes: Uint8Array<ArrayBuffer>, ack: Seq): Uint8Array<ArrayBuffer> {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(ACK_OFFSET, ack, LE);
  return copy;
}

// --- decode -------------------------------------------------------------------

function expectLength(view: DataView, length: number): void {
  if (view.byteLength !== length)
    throw new FrameError("invalid-message", `Expected ${length} bytes, got ${view.byteLength}`);
}

function decodeInput(view: DataView): InputMessage {
  const n = view.getUint8(2);
  if (n < 1 || n > MAX_INPUTS_PER_MESSAGE)
    throw new FrameError("invalid-input", `Input carries 1–${MAX_INPUTS_PER_MESSAGE} inputs`);
  expectLength(view, 3 + n * 5);
  const inputs: InputFrame[] = [];
  for (let i = 0; i < n; i++) {
    const buttons = view.getUint8(7 + i * 5);
    if (buttons & 0xf0) throw new FrameError("invalid-input", "Reserved input bits must be zero");
    const frame = { seq: seq(view.getUint32(3 + i * 5, LE)), controls: unpackButtons(buttons) };
    const previous = inputs.at(-1);
    if (previous && frame.seq !== previous.seq + 1) throw new FrameError("invalid-input", "Input seqs must be consecutive");
    inputs.push(frame);
  }
  return { type: "input", inputs };
}

function decodeEntity(view: DataView, o: number): EntitySnapshot {
  const id = entityId(view.getUint16(o, LE));
  const kind = lookup(ENTITY_KINDS, view.getUint8(o + 2), "entity kind");
  const x = view.getFloat32(o + 3, LE);
  const y = view.getFloat32(o + 7, LE);
  const angle = view.getInt16(o + 11, LE) / 1000;
  o += COMMON;
  switch (kind) {
    case "ship": {
      const flags = view.getUint8(o + 14);
      const effects: Partial<Record<EffectName, number>> = {};
      EFFECT_NAMES.forEach((effect, j) => {
        const ms = view.getUint16(o + 17 + j * 2, LE);
        if (ms > 0) effects[effect] = ms / 1000;
      });
      return {
        id,
        kind,
        x,
        y,
        angle,
        vx: view.getFloat32(o, LE),
        vy: view.getFloat32(o + 4, LE),
        hp: view.getUint8(o + 8),
        score: view.getUint32(o + 9, LE),
        owner: playerId(view.getUint8(o + 13)),
        bot: (flags & 1) !== 0,
        thrusting: (flags & 2) !== 0,
        fireCooldown: view.getUint16(o + 15, LE) / 10_000,
        effects,
      };
    }
    case "bullet":
      return {
        id,
        kind,
        x,
        y,
        angle,
        vx: view.getFloat32(o, LE),
        vy: view.getFloat32(o + 4, LE),
        owner: playerId(view.getUint8(o + 8)),
        seq: seq(view.getUint32(o + 9, LE)),
        ttl: view.getUint16(o + 13, LE) / 10_000,
        homing: (view.getUint8(o + 15) & 1) !== 0,
      };
    case "asteroid":
      return {
        id,
        kind,
        x,
        y,
        angle,
        radius: view.getUint16(o, LE) / 100,
        hp: view.getUint8(o + 2),
        maxHp: view.getUint8(o + 3),
        homing: (view.getUint8(o + 4) & 1) !== 0,
        shape: Array.from({ length: SHAPE_POINTS }, (_, j) => 0.75 + (view.getUint8(o + 5 + j) / 255) * 0.4),
      };
    case "pickup":
      return { id, kind, x, y, angle, effect: lookup(EFFECT_NAMES, view.getUint8(o), "pickup effect") };
    case "explosion":
      return {
        id,
        kind,
        x,
        y,
        angle,
        color: rgbToHex(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2)),
        count: view.getUint8(o + 3),
        speed: view.getUint16(o + 4, LE),
        age: view.getUint16(o + 6, LE) / 1000,
      };
    default:
      return assertNever(kind, "entity kind");
  }
}

function decodeState(view: DataView): StateMessage {
  const entityCount = view.getUint16(10, LE);
  const eventCount = view.getUint8(12);
  const events: GameEvent[] = [];
  const entities: EntitySnapshot[] = [];

  let o = STATE_HEADER;
  for (let i = 0; i < eventCount; i++) {
    events.push({ type: lookup(EVENT_TYPES, view.getUint8(o), "event type"), id: entityId(view.getUint16(o + 1, LE)) });
    o += 3;
  }
  for (let i = 0; i < entityCount; i++) {
    const entity = decodeEntity(view, o);
    entities.push(entity);
    o += COMMON + KIND_SIZE[entity.kind];
  }
  expectLength(view, o);
  return {
    type: "state",
    tick: tick(view.getUint32(2, LE)),
    ack: seq(view.getUint32(ACK_OFFSET, LE)),
    events,
    entities,
  };
}

function viewOf(payload: ArrayBuffer | Uint8Array): DataView {
  return payload instanceof Uint8Array
    ? new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    : new DataView(payload);
}

export function decode(payload: IncomingPayload): Result<RealtimeMessage> {
  if (typeof payload === "string") return fail("invalid-message", "The binary codec expects a binary frame");
  const view = viewOf(payload);
  if (view.byteLength < 2) return fail("invalid-message", "Binary message is too short");
  if (view.getUint8(1) !== PROTOCOL_VERSION) return fail("unsupported-version", "Unsupported protocol version");
  const type = view.getUint8(0);
  try {
    switch (type) {
      case TYPE.INPUT:
        return ok(decodeInput(view));
      case TYPE.PING:
        expectLength(view, 10);
        return ok({ type: "ping", t: view.getFloat64(2, LE) });
      case TYPE.PONG:
        expectLength(view, 14);
        return ok({ type: "pong", t: view.getFloat64(2, LE), tick: tick(view.getUint32(10, LE)) });
      case TYPE.STATE:
        return ok(decodeState(view));
      default:
        return fail("unknown-type", `Unknown binary message type ${type}`);
    }
  } catch (error: unknown) {
    if (error instanceof FrameError) return fail(error.code, error.message);
    // A DataView read past the end throws RangeError: a truncated frame.
    if (error instanceof RangeError) return fail("invalid-message", `Malformed binary message: ${error.message}`);
    throw error;
  }
}

export const binaryCodec = { name: "binary", encode, decode } satisfies Codec;
