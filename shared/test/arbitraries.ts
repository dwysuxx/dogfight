// fast-check generators for the protocol, plus the "equal within the spec's
// quantization" comparison shared by the codec tests.
import fc from "fast-check";
import assert from "node:assert/strict";
import { entityId, playerId, seq, tick } from "../brand.ts";
import {
  EFFECT_NAMES,
  EVENT_TYPES,
  type ClientMessage,
  type Controls,
  type EffectName,
  type EntitySnapshot,
  type InputMessage,
  MAX_INPUTS_PER_MESSAGE,
  type StateMessage,
} from "../protocol.ts";
import { wrapAngle } from "../sim/math.ts";

const coord = fc.double({ min: -10_000, max: 10_000, noNaN: true, noDefaultInfinity: true });
const velocity = fc.double({ min: -2_000, max: 2_000, noNaN: true, noDefaultInfinity: true });
const angle = fc.double({ min: -100, max: 100, noNaN: true, noDefaultInfinity: true });
const u8 = fc.integer({ min: 0, max: 0xff });
const u32 = fc.integer({ min: 0, max: 0xffffffff });
const seconds = (max: number) => fc.double({ min: 0, max, noNaN: true, noDefaultInfinity: true });

export const arbId = fc.integer({ min: 0, max: 0xffff }).map(entityId);
export const arbControls: fc.Arbitrary<Controls> = fc.record({
  left: fc.boolean(),
  right: fc.boolean(),
  thrust: fc.boolean(),
  fire: fc.boolean(),
});

const effects = fc
  .subarray([...EFFECT_NAMES])
  .chain((names) => fc.tuple(...names.map(() => seconds(60))).map((values) => ({ names, values })))
  .map(({ names, values }) => {
    const result: Partial<Record<EffectName, number>> = {};
    names.forEach((name, i) => {
      const value = values[i];
      if (value !== undefined && value > 0) result[name] = value;
    });
    return result;
  });

const common = { id: arbId, x: coord, y: coord, angle };

export const arbEntity: fc.Arbitrary<EntitySnapshot> = fc.oneof(
  fc.record({
    ...common,
    kind: fc.constant("ship" as const),
    vx: velocity,
    vy: velocity,
    hp: u8,
    score: u32,
    owner: u8.map(playerId),
    bot: fc.boolean(),
    thrusting: fc.boolean(),
    fireCooldown: seconds(6.5),
    effects,
  }),
  fc.record({
    ...common,
    kind: fc.constant("bullet" as const),
    vx: velocity,
    vy: velocity,
    owner: u8.map(playerId),
    seq: u32.map(seq),
    ttl: seconds(6.5),
    homing: fc.boolean(),
  }),
  fc.record({
    ...common,
    kind: fc.constant("asteroid" as const),
    radius: fc.double({ min: 0.01, max: 655, noNaN: true }),
    hp: u8,
    maxHp: u8,
    homing: fc.boolean(),
    shape: fc.array(fc.double({ min: 0.75, max: 1.15, noNaN: true }), { minLength: 11, maxLength: 11 }),
  }),
  fc.record({ ...common, kind: fc.constant("pickup" as const), effect: fc.constantFrom(...EFFECT_NAMES) }),
  fc.record({
    ...common,
    kind: fc.constant("explosion" as const),
    color: fc.integer({ min: 0, max: 0xffffff }).map((n) => `#${n.toString(16).padStart(6, "0")}`),
    count: u8,
    speed: fc.integer({ min: 0, max: 0xffff }),
    age: seconds(60),
  }),
);

export const arbState: fc.Arbitrary<StateMessage> = fc.record({
  type: fc.constant("state" as const),
  tick: u32.map(tick),
  ack: u32.map(seq),
  events: fc.array(fc.record({ type: fc.constantFrom(...EVENT_TYPES), id: arbId }), { maxLength: 20 }),
  entities: fc.array(arbEntity, { maxLength: 40 }),
});

export const arbInput: fc.Arbitrary<InputMessage> = fc
  .tuple(fc.integer({ min: 1, max: 0xffffffff - MAX_INPUTS_PER_MESSAGE }), fc.array(arbControls, { minLength: 1, maxLength: MAX_INPUTS_PER_MESSAGE }))
  .map(([first, controls]) => ({
    type: "input" as const,
    inputs: controls.map((c, i) => ({ seq: seq(first + i), controls: c })),
  }));

const text = (min: number, max: number) =>
  fc.string({ minLength: min, maxLength: max }).filter((s) => s.trim().length >= min && s.trim().length <= max);

// Every valid client message, as the JSON a client would send (with `v`).
export const arbClientMessage: fc.Arbitrary<ClientMessage> = fc.oneof(
  fc.record({
    type: fc.constant("join" as const),
    room: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,39}$/),
    name: text(1, 20),
    codec: fc.constantFrom("json" as const, "binary" as const),
  }),
  fc.record({ type: fc.constant("chat" as const), text: text(1, 500) }),
  arbInput,
  fc.record({ type: fc.constant("ping" as const), t: fc.double({ noNaN: true, noDefaultInfinity: true }) }),
  fc.record({
    type: fc.constant("netsim" as const),
    lag: fc.double({ min: 0, max: 1000, noNaN: true }),
    jitter: fc.double({ min: 0, max: 500, noNaN: true }),
    drop: fc.double({ min: 0, max: 0.5, noNaN: true }),
  }),
);

// fast-check builds records with a null prototype; structuredClone gives
// ordinary objects, so deepStrictEqual compares only the data.
export const plain = <T>(value: T): T => structuredClone(value);

// --- quantization-aware comparison -------------------------------------------

const f32 = (v: number) => Math.max(2e-3, Math.abs(v) * 1.2e-7);
const TOLERANCE: Readonly<Record<string, (v: number) => number>> = {
  x: f32,
  y: f32,
  vx: f32,
  vy: f32,
  fireCooldown: () => 0.5e-4 + 1e-9,
  ttl: () => 0.5e-4 + 1e-9,
  radius: () => 0.005 + 1e-9,
  age: () => 0.0005 + 1e-9,
  speed: () => 0.5,
  count: () => 0.5,
};

export function assertQuantizedEqual(decoded: EntitySnapshot, original: EntitySnapshot, where: string): void {
  const got = new Map(Object.entries(decoded));
  for (const [key, value] of Object.entries(original)) {
    const actual: unknown = got.get(key);
    const at = `${where}.${key}`;
    const tolerance = TOLERANCE[key];
    if (key === "angle" && typeof value === "number" && typeof actual === "number") {
      assert.ok(Math.abs(wrapAngle(actual - value)) <= 0.0005 + 1e-9, `${at}: ${actual} vs ${value}`);
    } else if (key === "shape" && Array.isArray(value) && Array.isArray(actual)) {
      value.forEach((point: unknown, i) => {
        const other: unknown = actual[i];
        assert.ok(typeof point === "number" && typeof other === "number" && Math.abs(other - point) <= 0.4 / 255 / 2 + 1e-9, `${at}[${i}]`);
      });
    } else if (key === "effects" && decoded.kind === "ship" && original.kind === "ship") {
      const decodedEffects = new Map(Object.entries(decoded.effects));
      for (const [name, left] of Object.entries(original.effects)) {
        const back = decodedEffects.get(name) ?? 0;
        // ceil to ms: never shorter, at most 1 ms longer; sub-ms effects may vanish
        if ((left ?? 0) >= 0.001) assert.ok(back >= (left ?? 0) - 1e-9 && back - (left ?? 0) < 0.001 + 1e-9, `${at}.${name}`);
      }
    } else if (tolerance && typeof value === "number" && typeof actual === "number") {
      assert.ok(Math.abs(actual - value) <= tolerance(value), `${at}: ${actual} vs ${value}`);
    } else {
      assert.deepEqual(actual, value, at);
    }
  }
}
