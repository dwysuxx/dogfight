import { test } from "vitest";
import assert from "node:assert/strict";

import { type PlayerId, type Seq, entityId, playerId, seq, tick } from "../brand.ts";
import * as binary from "../codec/binary.ts";
import type { Codec } from "../codec/codec.ts";
import { jsonCodec } from "../codec/json.ts";
import {
  type EntitySnapshot,
  PROTOCOL_VERSION,
  type RealtimeMessage,
  type Result,
  type StateMessage,
} from "../protocol.ts";
import { botControls } from "../sim/ai.ts";
import type { StepControls } from "../sim/entity.ts";
import { createGame } from "../sim/game.ts";
import { wrapAngle } from "../sim/math.ts";
import { scriptedControls } from "../sim/scenario.ts";
import { snapshotEntities } from "../sim/snapshot.ts";

const DT = 1 / 30;
const P3: PlayerId = playerId(3);

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

function decodeState(payload: Uint8Array | string, codec: Codec = binary.binaryCodec): StateMessage {
  const message = unwrap(codec.decode(payload));
  assert.equal(message.type, "state");
  if (message.type !== "state") throw new Error("not a state");
  return message;
}

// Real snapshots: a seeded game run with scripted inputs, so every kind
// (ships with effects, homing bullets, explosions, pickups) shows up.
function* gameSnapshots({ seed, steps = 600, every = 7 }: { seed: number; steps?: number; every?: number }): Generator<StateMessage> {
  const { world, player, bot } = createGame({ seed, assignIds: true, asteroids: 8 });
  if (!player || !bot) throw new Error("need player and bot");
  player.playerId = P3;
  player.effects.set("homing", 30);
  for (let step = 0; step < steps; step++) {
    world.step(
      DT,
      new Map<typeof player.id, StepControls>([
        [player.id, { ...scriptedControls(step), fire: step % 4 === 0, seq: seq(step + 1) }],
        [bot.id, botControls(world, bot)],
      ]),
    );
    if (step % every === 0)
      yield {
        type: "state",
        tick: world.tick,
        ack: seq(step + 1),
        events: [
          { type: "fired", id: player.id },
          { type: "exploded", id: entityId(9) },
        ],
        entities: snapshotEntities(world),
      };
  }
}

const f32 = (v: number) => Math.max(1e-3, Math.abs(v) * 1e-6);
// Quantization the spec allows, per numeric field.
const TOLERANCE: Readonly<Record<string, (v: number) => number>> = {
  x: f32,
  y: f32,
  vx: f32,
  vy: f32,
  fireCooldown: () => 0.5e-4,
  ttl: () => 0.5e-4,
  radius: () => 0.005,
  age: () => 0.0005,
  speed: () => 0.5,
  count: () => 0.5,
};

function assertClose(decoded: EntitySnapshot, original: EntitySnapshot, where: string): void {
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
      assert.deepEqual(Object.keys(decoded.effects).sort(), Object.keys(original.effects).sort(), at);
      for (const [name, left] of Object.entries(original.effects)) {
        const decodedLeft = new Map(Object.entries(decoded.effects)).get(name) ?? 0;
        assert.ok(decodedLeft - (left ?? 0) < 0.001 + 1e-9, `${at}.${name}`);
      }
    } else if (tolerance && typeof value === "number" && typeof actual === "number") {
      assert.ok(Math.abs(actual - value) <= tolerance(value), `${at}: ${actual} vs ${value}`);
    } else {
      assert.deepEqual(actual, value, at);
    }
  }
}

test("binary STATE round-trips real snapshots within the spec's quantization", () => {
  const kinds = new Set<string>();
  let count = 0;
  for (const seed of [1, 2, 3]) {
    for (const state of gameSnapshots({ seed })) {
      const bytes = binary.encode(state);
      assert.equal(bytes.byteLength, binary.stateSize(state));
      const decoded = decodeState(bytes);
      assert.equal(decoded.tick, state.tick);
      assert.equal(decoded.ack, state.ack);
      assert.deepEqual(decoded.events, state.events);
      assert.equal(decoded.entities.length, state.entities.length);
      state.entities.forEach((entity, i) => {
        kinds.add(entity.kind);
        const other = decoded.entities[i];
        assert.ok(other, "same entity count");
        assertClose(other, entity, `tick ${state.tick} ${entity.kind}#${entity.id}`);
      });
      count++;
    }
  }
  assert.ok(count > 200);
  for (const kind of ["ship", "bullet", "asteroid", "explosion"]) assert.ok(kinds.has(kind), kind);
});

test("JSON round-trips exactly and is validated by the zod schemas", () => {
  for (const state of gameSnapshots({ seed: 4, steps: 120 })) {
    assert.deepEqual(decodeState(jsonCodec.encode(state), jsonCodec), state);
  }
  const bad = jsonCodec.decode(JSON.stringify({ v: PROTOCOL_VERSION + 1, type: "state" }));
  assert.equal(bad.ok ? "ok" : bad.error.code, "unsupported-version");
  const garbage = jsonCodec.decode("{nope");
  assert.equal(garbage.ok ? "ok" : garbage.error.code, "invalid-json");
  const wrongShape = jsonCodec.decode(JSON.stringify({ v: PROTOCOL_VERSION, type: "pong", t: "soon", tick: 1 }));
  assert.equal(wrongShape.ok, false);
});

test("binary INPUT, PING and PONG round-trip; layout is little-endian", () => {
  const s = (n: number): Seq => seq(n);
  const message: RealtimeMessage = {
    type: "input",
    inputs: [
      { seq: s(0x01020304), controls: { left: true, right: false, thrust: true, fire: false } },
      { seq: s(0x01020305), controls: { left: false, right: true, thrust: false, fire: true } },
    ],
  };
  const bytes = binary.encode(message);
  assert.equal(bytes.byteLength, 3 + 2 * 5);
  assert.deepEqual([...bytes.subarray(0, 8)], [1, PROTOCOL_VERSION, 2, 0x04, 0x03, 0x02, 0x01, 0b0101]);
  assert.deepEqual(unwrap(binary.decode(bytes)), message);

  assert.deepEqual(unwrap(binary.decode(binary.encode({ type: "ping", t: 1234.5678 }))), { type: "ping", t: 1234.5678 });
  const pong: RealtimeMessage = { type: "pong", t: 99.25, tick: tick(70000) };
  assert.deepEqual(unwrap(binary.decode(binary.encode(pong))), pong);
});

test("the server patches only the ack bytes per client", () => {
  const [state] = gameSnapshots({ seed: 5, steps: 30 });
  assert.ok(state);
  const shared = binary.encode({ ...state, ack: seq(0) });
  const forClient = binary.withAck(shared, seq(4242));
  assert.equal(decodeState(forClient).ack, 4242);
  assert.equal(decodeState(shared).ack, 0, "the shared buffer is untouched");
  assert.deepEqual([...forClient.subarray(10)], [...shared.subarray(10)]);
});

test("malformed binary frames are rejected with a code, never half-parsed", () => {
  const input = binary.encode({ type: "input", inputs: [{ seq: seq(1), controls: { left: true, right: false, thrust: false, fire: false } }] });
  const reject = (bytes: Uint8Array, code: string) => {
    const result = binary.decode(bytes);
    assert.equal(result.ok ? "ok" : result.error.code, code);
  };
  reject(input.slice(0, 5), "invalid-message"); // truncated
  reject(Uint8Array.of(...input, 0), "invalid-message"); // trailing garbage
  reject(Uint8Array.of(1, PROTOCOL_VERSION, 1, 1, 0, 0, 0, 0x10), "invalid-input"); // reserved bit
  reject(Uint8Array.of(1, PROTOCOL_VERSION, 0), "invalid-input"); // zero inputs
  reject(Uint8Array.of(1, PROTOCOL_VERSION + 1, 1, 1, 0, 0, 0, 0), "unsupported-version");
  reject(Uint8Array.of(200, PROTOCOL_VERSION), "unknown-type");
  reject(Uint8Array.of(1, PROTOCOL_VERSION, 2, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0), "invalid-input"); // seq gap
  const [state] = gameSnapshots({ seed: 6, steps: 10 });
  assert.ok(state);
  reject(binary.encode(state).slice(0, 40), "invalid-message");
});

test("more than 255 events in one tick are capped, not thrown (a throw would freeze the server tick)", () => {
  const events = Array.from({ length: 300 }, (_, i) => ({ type: "fired" as const, id: entityId(i) }));
  const bytes = binary.encode({ type: "state", tick: tick(1), ack: seq(0), events, entities: [] });
  const decoded = decodeState(bytes);
  assert.equal(decoded.events.length, 255);
  assert.equal(bytes.byteLength, 13 + 255 * 3);
});

test("binary is several times smaller than JSON for the same snapshot", () => {
  const [state] = gameSnapshots({ seed: 7, steps: 200, every: 199 });
  assert.ok(state);
  const jsonBytes = new TextEncoder().encode(jsonCodec.encode(state)).byteLength;
  const binaryBytes = binary.encode(state).byteLength;
  assert.ok(jsonBytes / binaryBytes > 4, `${jsonBytes} vs ${binaryBytes}`);
});
