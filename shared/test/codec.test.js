import { test } from "node:test";
import assert from "node:assert/strict";

import * as binary from "../codec/binary.js";
import * as json from "../codec/json.js";
import { PROTOCOL_VERSION, ProtocolError } from "../protocol/messages.js";
import { botControls } from "../sim/ai.js";
import { createGame } from "../sim/game.js";
import { wrapAngle } from "../sim/math.js";
import { snapshotEntities } from "../sim/snapshot.js";
import { scriptedControls } from "../sim/scenario.js";

const DT = 1 / 30;

// Real snapshots: a seeded game run with scripted inputs, so every kind
// (ships with effects, homing bullets, explosions, pickups) shows up.
function* gameSnapshots({ seed, steps = 600, every = 7 }) {
  const { world, player, bot } = createGame({ seed, assignIds: true, asteroids: 8 });
  player.playerId = 3;
  player.effects.set("homing", 30);
  for (let step = 0; step < steps; step++) {
    world.step(
      DT,
      new Map([
        [player.id, { ...scriptedControls(step), fire: step % 4 === 0, seq: step + 1 }],
        [bot.id, botControls(world, bot)],
      ]),
    );
    if (step % every === 0)
      yield {
        type: "state",
        tick: world.tick,
        ack: step + 1,
        events: [{ type: "fired", id: player.id }, { type: "exploded", id: 9 }],
        entities: snapshotEntities(world),
      };
  }
}

// Tolerances = the quantization the spec allows, per field.
const TOLERANCE = {
  x: (v) => Math.max(1e-3, Math.abs(v) * 1e-6), // f32
  y: (v) => Math.max(1e-3, Math.abs(v) * 1e-6),
  vx: (v) => Math.max(1e-3, Math.abs(v) * 1e-6),
  vy: (v) => Math.max(1e-3, Math.abs(v) * 1e-6),
  fireCooldown: () => 0.5e-4,
  ttl: () => 0.5e-4,
  radius: () => 0.005,
  age: () => 0.0005,
  speed: () => 0.5,
  count: () => 0.5,
};

function assertClose(decoded, original, where) {
  for (const [key, value] of Object.entries(original)) {
    const got = decoded[key];
    const at = `${where}.${key}`;
    if (key === "angle") {
      assert.ok(Math.abs(wrapAngle(got - value)) <= 0.0005 + 1e-9, `${at}: ${got} vs ${value}`);
    } else if (key === "shape") {
      value.forEach((point, i) => assert.ok(Math.abs(got[i] - point) <= 0.4 / 255 / 2 + 1e-9, `${at}[${i}]`));
    } else if (key === "effects") {
      assert.deepEqual(Object.keys(got).sort(), Object.keys(value).sort(), at);
      for (const name of Object.keys(value)) assert.ok(got[name] - value[name] < 0.001 + 1e-9, `${at}.${name}`);
    } else if (TOLERANCE[key]) {
      assert.ok(Math.abs(got - value) <= TOLERANCE[key](value), `${at}: ${got} vs ${value}`);
    } else {
      assert.deepEqual(got, value, at);
    }
  }
}

test("binary STATE round-trips real snapshots within the spec's quantization", () => {
  const kinds = new Set();
  let count = 0;
  for (const seed of [1, 2, 3]) {
    for (const state of gameSnapshots({ seed })) {
      const bytes = binary.encode(state);
      assert.equal(bytes.byteLength, binary.stateSize(state));
      const decoded = binary.decode(bytes);
      assert.equal(decoded.tick, state.tick);
      assert.equal(decoded.ack, state.ack);
      assert.deepEqual(decoded.events, state.events);
      assert.equal(decoded.entities.length, state.entities.length);
      state.entities.forEach((entity, i) => {
        kinds.add(entity.kind);
        assertClose(decoded.entities[i], entity, `tick ${state.tick} ${entity.kind}#${entity.id}`);
      });
      count++;
    }
  }
  assert.ok(count > 200);
  assert.ok(kinds.has("bullet") && kinds.has("explosion") && kinds.has("asteroid"));
});

test("JSON round-trips exactly; the version is checked", () => {
  for (const state of gameSnapshots({ seed: 4, steps: 120 })) {
    assert.deepEqual(json.decode(json.encode(state)), state);
  }
  assert.throws(() => json.decode(JSON.stringify({ v: PROTOCOL_VERSION + 1, type: "state" })), ProtocolError);
  assert.throws(() => json.decode("{nope"), ProtocolError);
});

test("binary INPUT, PING and PONG round-trip; layout is little-endian", () => {
  const inputs = [
    { seq: 0x01020304, controls: { left: true, right: false, thrust: true, fire: false } },
    { seq: 0x01020305, controls: { left: false, right: true, thrust: false, fire: true } },
  ];
  const bytes = binary.encode({ type: "input", inputs });
  assert.equal(bytes.byteLength, 3 + 2 * 5);
  assert.deepEqual([...bytes.subarray(0, 8)], [1, PROTOCOL_VERSION, 2, 0x04, 0x03, 0x02, 0x01, 0b0101]);
  assert.deepEqual(binary.decode(bytes), { type: "input", inputs });

  const ping = binary.encode({ type: "ping", t: 1234.5678 });
  assert.deepEqual(binary.decode(ping), { type: "ping", t: 1234.5678 });
  const pong = binary.encode({ type: "pong", t: 99.25, tick: 70000 });
  assert.deepEqual(binary.decode(pong), { type: "pong", t: 99.25, tick: 70000 });
});

test("the server patches only the ack bytes per client", () => {
  const [state] = gameSnapshots({ seed: 5, steps: 30 });
  const shared = binary.encode({ ...state, ack: 0 });
  const forClient = binary.withAck(shared, 4242);
  assert.equal(binary.decode(forClient).ack, 4242);
  assert.equal(binary.decode(shared).ack, 0, "the shared buffer is untouched");
  assert.deepEqual([...forClient.subarray(10)], [...shared.subarray(10)]);
});

test("malformed binary frames are rejected, never half-parsed", () => {
  const input = binary.encode({ type: "input", inputs: [{ seq: 1, controls: { left: true, right: false, thrust: false, fire: false } }] });
  const reject = (bytes, code) => assert.throws(() => binary.decode(bytes), (error) => error instanceof ProtocolError && error.code === code);
  reject(input.slice(0, 5), "invalid-message"); // truncated
  reject(Uint8Array.of(...input, 0), "invalid-message"); // trailing garbage
  reject(Uint8Array.of(1, PROTOCOL_VERSION, 1, 1, 0, 0, 0, 0x10), "invalid-input"); // reserved bit
  reject(Uint8Array.of(1, PROTOCOL_VERSION, 0), "invalid-input"); // zero inputs
  reject(Uint8Array.of(1, PROTOCOL_VERSION + 1, 1, 1, 0, 0, 0, 0), "unsupported-version");
  reject(Uint8Array.of(200, PROTOCOL_VERSION), "unknown-type");
  // two inputs with non-consecutive seqs
  reject(Uint8Array.of(1, PROTOCOL_VERSION, 2, 1, 0, 0, 0, 0, 3, 0, 0, 0, 0), "invalid-input");
  const [state] = gameSnapshots({ seed: 6, steps: 10 });
  reject(binary.encode(state).slice(0, 40), "invalid-message");
});

test("binary is several times smaller than JSON for the same snapshot", () => {
  const [state] = gameSnapshots({ seed: 7, steps: 200, every: 199 });
  const jsonBytes = new TextEncoder().encode(json.encode(state)).byteLength;
  const binaryBytes = binary.encode(state).byteLength;
  assert.ok(jsonBytes / binaryBytes > 4, `${jsonBytes} vs ${binaryBytes}`);
});
