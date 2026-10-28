// Property-based tests (fast-check): instead of examples, invariants that
// must hold for EVERY generated input. On failure fast-check shrinks the
// input to a minimal counterexample.
import assert from "node:assert/strict";
import fc from "fast-check";
import { test } from "vitest";
import { type EntityId, seq } from "../brand.ts";
import { binaryCodec, encode, stateSize } from "../codec/binary.ts";
import { jsonCodec } from "../codec/json.ts";
import { PROTOCOL_VERSION, encodeJson, parseClientMessage } from "../protocol.ts";
import { createGame } from "../sim/game.ts";
import type { StepControls } from "../sim/entity.ts";
import { hashWorld } from "../sim/snapshot.ts";
import { arbClientMessage, arbControls, arbInput, arbState, assertQuantizedEqual, plain } from "./arbitraries.ts";

const KIND_BYTES = { ship: 23, bullet: 16, asteroid: 16, pickup: 1, explosion: 8 } as const;

test("property: binary STATE round-trips any snapshot within the spec's quantization", () => {
  fc.assert(
    fc.property(arbState, (state) => {
      const decoded = binaryCodec.decode(encode(state));
      assert.ok(decoded.ok && decoded.value.type === "state");
      const back = decoded.value;
      assert.equal(back.tick, state.tick);
      assert.equal(back.ack, state.ack);
      assert.deepEqual(back.events, plain(state.events));
      assert.equal(back.entities.length, state.entities.length);
      state.entities.forEach((entity, i) => {
        const other = back.entities[i];
        assert.ok(other);
        assertQuantizedEqual(other, entity, `#${i}`);
      });
    }),
    { numRuns: 300 },
  );
});

test("property: the encoded length is exactly what the written spec says", () => {
  fc.assert(
    fc.property(arbState, (state) => {
      const spec = 13 + 3 * state.events.length + state.entities.reduce((n, e) => n + 13 + KIND_BYTES[e.kind], 0);
      assert.equal(encode(state).byteLength, spec);
      assert.equal(stateSize(state), spec);
    }),
  );
  fc.assert(fc.property(arbInput, (input) => encode(input).byteLength === 3 + 5 * input.inputs.length));
});

test("property: INPUT round-trips exactly (no quantization on booleans and seqs)", () => {
  fc.assert(fc.property(arbInput, (input) => assert.deepEqual(binaryCodec.decode(encode(input)), { ok: true, value: plain(input) })));
});

test("property: arbitrary garbage never crashes a decoder, it yields a typed error", () => {
  const garbage = fc.oneof(
    fc.uint8Array({ maxLength: 512 }),
    // Plausible headers make the fuzzing reach deep into the STATE parser.
    fc.tuple(fc.constantFrom(1, 2, 16, 17), fc.uint8Array({ maxLength: 512 })).map(([type, rest]) => Uint8Array.of(type, PROTOCOL_VERSION, ...rest)),
  );
  fc.assert(
    fc.property(garbage, (bytes) => {
      const result = binaryCodec.decode(bytes);
      if (!result.ok) assert.equal(typeof result.error.code, "string");
    }),
    { numRuns: 2000 },
  );
  fc.assert(
    fc.property(fc.string(), (text) => {
      const result = jsonCodec.decode(text);
      if (!result.ok) assert.equal(typeof result.error.code, "string");
    }),
  );
});

test("property: a valid STATE with one byte flipped either decodes or is rejected — never throws", () => {
  fc.assert(
    fc.property(arbState, fc.nat(), fc.integer({ min: 1, max: 255 }), (state, at, flip) => {
      const bytes = encode(state);
      const index = at % bytes.length;
      bytes[index] = (bytes[index] ?? 0) ^ flip;
      assert.equal(typeof binaryCodec.decode(bytes).ok, "boolean");
    }),
    { numRuns: 500 },
  );
});

test("property: parseClientMessage accepts every valid message and rejects every mutation of it", () => {
  fc.assert(
    fc.property(arbClientMessage, (message) => {
      const wire: unknown = JSON.parse(encodeJson(message));
      const parsed = parseClientMessage(wire);
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.error.message);
      assert.equal(parsed.value.type, message.type);
    }),
    { numRuns: 500 },
  );

  // Mutations: an unknown extra field, a removed field, a field of the wrong
  // type, or the wrong version. Each must be refused.
  const mutation = fc.constantFrom("extra", "remove", "retype", "version");
  fc.assert(
    fc.property(arbClientMessage, mutation, (message, kind) => {
      const wire: Record<string, unknown> = { v: PROTOCOL_VERSION, ...message };
      const fields = Object.keys(message).filter((key) => key !== "type" && !(message.type === "join" && key === "codec"));
      const field = fields[0];
      if (kind === "extra") wire["admin"] = true;
      else if (kind === "version") wire["v"] = PROTOCOL_VERSION + 1;
      else if (!field) return; // nothing to remove or retype on this message
      else if (kind === "remove") delete wire[field];
      else wire[field] = { not: "the right type" };
      assert.equal(parseClientMessage(wire).ok, false, `${kind} on ${message.type}`);
    }),
    { numRuns: 500 },
  );
});

test("property: ships stay inside the arena (plus the wrap margin) over 1000 random input steps", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1e6 }), fc.array(arbControls, { minLength: 1000, maxLength: 1000 }), (seed, inputs) => {
      const { world, player } = createGame({ seed, asteroids: 3, withBot: false, assignIds: true });
      assert.ok(player);
      const { width, height } = world.bounds;
      inputs.forEach((controls, i) => {
        world.step(1 / 30, new Map<typeof player.id, StepControls>([[player.id, { ...controls, seq: seq(i + 1) }]]));
        for (const ship of world.ofKind("ship")) {
          const m = ship.radius;
          assert.ok(ship.pos.x >= -m && ship.pos.x <= width + m && ship.pos.y >= -m && ship.pos.y <= height + m, `step ${i}`);
        }
      });
    }),
    { numRuns: 20 },
  );
});

test("property: determinism — two worlds from the same seed and inputs never diverge", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1e6 }), fc.array(arbControls, { minLength: 200, maxLength: 200 }), (seed, inputs) => {
      const a = createGame({ seed, assignIds: true });
      const b = createGame({ seed, assignIds: true });
      const [pa, pb] = [a.player, b.player];
      assert.ok(pa && pb);
      inputs.forEach((controls, i) => {
        const input: StepControls = { ...controls, seq: seq(i + 1) };
        a.world.step(1 / 30, new Map<EntityId, StepControls>([[pa.id, input]]));
        b.world.step(1 / 30, new Map<EntityId, StepControls>([[pb.id, input]]));
      });
      assert.equal(hashWorld(a.world), hashWorld(b.world));
    }),
    { numRuns: 25 },
  );
});
