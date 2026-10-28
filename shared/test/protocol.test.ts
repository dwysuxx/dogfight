import { test } from "vitest";
import assert from "node:assert/strict";

import { Bus } from "../bus.ts";
import { entityId, isEntityId, seq } from "../brand.ts";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  CreateRoomRequestSchema,
  check,
  parseClientMessage,
  parseServerMessage,
} from "../protocol.ts";

const v = PROTOCOL_VERSION;
const code = (value: unknown) => {
  const result = parseClientMessage(value);
  return result.ok ? "ok" : result.error.code;
};
const thrust = { left: false, right: false, thrust: true, fire: false };

test("parseClientMessage turns unknown JSON into a typed message or a coded issue", () => {
  const join = parseClientMessage({ v, type: "join", room: "orbit", name: "  Ada  " });
  assert.ok(join.ok);
  if (join.ok && join.value.type === "join") {
    assert.equal(join.value.name, "Ada", "trimmed by the schema");
    assert.equal(join.value.codec, "json", "default filled in");
  }
  assert.equal(code({ v, type: "join", room: "orbit", name: "Ada", codec: "binary" }), "ok");
  assert.equal(code({ v, type: "join", room: "orbit", name: "Ada", codec: "xml" }), "invalid-join");
  assert.equal(code({ v, type: "join", room: "../secrets", name: "Ada" }), "invalid-join");
  assert.equal(code({ v, type: "join", room: "orbit", name: "Ada", admin: true }), "invalid-join");
  assert.equal(code({ v: 99, type: "join", room: "orbit", name: "Ada" }), "unsupported-version");
  assert.equal(code({ v, type: "chat", text: "x".repeat(501) }), "invalid-chat");
  assert.equal(code({ v, type: "wat" }), "unknown-type");
  assert.equal(code("nope"), "invalid-message");
  assert.equal(code([1, 2]), "invalid-message");
});

test("input validation: consecutive u32 seqs, exactly four booleans, 1–4 frames", () => {
  const input = (inputs: unknown) => code({ v, type: "input", inputs });
  assert.equal(input([{ seq: 7, controls: thrust }, { seq: 8, controls: thrust }]), "ok");
  assert.equal(input([{ seq: 7, controls: thrust }, { seq: 9, controls: thrust }]), "invalid-input", "gap");
  assert.equal(input([{ seq: 1, controls: { thrust: true } }]), "invalid-input");
  assert.equal(input([{ seq: 1, controls: { ...thrust, turn: 1000 } }]), "invalid-input", "cheat field");
  assert.equal(input([{ seq: 1.5, controls: thrust }]), "invalid-input");
  assert.equal(input([{ seq: -1, controls: thrust }]), "invalid-input");
  assert.equal(input([]), "invalid-input");
  assert.equal(input(Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, controls: thrust }))), "invalid-input");
  assert.equal(code({ v, type: "ping", t: 12.5 }), "ok");
  assert.equal(code({ v, type: "ping", t: "now" }), "invalid-ping");
  assert.equal(code({ v, type: "netsim", lag: 100, jitter: 20, drop: 0.02 }), "ok");
  assert.equal(code({ v, type: "netsim", lag: 100, jitter: 20, drop: 0.9 }), "invalid-netsim");
});

test("an exhaustive switch over the parsed message (the never default compiles)", () => {
  const describe = (message: ClientMessage): string => {
    switch (message.type) {
      case "join":
        return `join ${message.room}`;
      case "chat":
        return `chat ${message.text}`;
      case "input":
        return `input x${message.inputs.length}`;
      case "ping":
        return `ping ${message.t}`;
      case "netsim":
        return `netsim ${message.lag}`;
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  };
  const parsed = parseClientMessage({ v, type: "input", inputs: [{ seq: 1, controls: thrust }] });
  assert.ok(parsed.ok);
  if (parsed.ok) assert.equal(describe(parsed.value), "input x1");
});

test("server messages are validated on the client too", () => {
  const roster = parseServerMessage({ v, type: "roster", room: "orbit", players: [{ id: "a", playerId: 1, name: "Ada", color: "#fff" }] });
  assert.ok(roster.ok);
  const badId = parseServerMessage({ v, type: "pong", t: 1, tick: -5 });
  assert.equal(badId.ok, false);
});

test("HTTP bodies go through the same schemas", () => {
  assert.ok(check(CreateRoomRequestSchema, { name: "Practice", arena: { width: 800, height: 600, asteroids: 4 } }).ok);
  assert.equal(check(CreateRoomRequestSchema, { name: "Bad", arena: { width: -1, height: 1, asteroids: -3 } }).ok, false);
  assert.equal(check(CreateRoomRequestSchema, { name: "", extra: 1 }).ok, false);
});

test("branded ids are range-checked numbers", () => {
  assert.equal(isEntityId(65535), true);
  assert.equal(isEntityId(65536), false);
  assert.equal(isEntityId(1.5), false);
  assert.throws(() => entityId(-1), RangeError);
  assert.equal(seq(0xffffffff), 0xffffffff);
});

test("Bus delivers typed payloads and unsubscribes", () => {
  const bus = new Bus<{ hit: { damage: number }; ready: undefined }>();
  const seen: number[] = [];
  const off = bus.on("hit", ({ damage }) => seen.push(damage));
  bus.once("ready", () => seen.push(-1));
  bus.emit("hit", { damage: 10 });
  bus.emit("ready", undefined);
  bus.emit("ready", undefined);
  off();
  bus.emit("hit", { damage: 20 });
  assert.deepEqual(seen, [10, -1]);
});
