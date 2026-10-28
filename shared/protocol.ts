// THE protocol: one zod schema per message, the TypeScript types inferred
// from the schemas, and parse functions that turn `unknown` wire data into a
// typed message or a structured error (never an exception). Client, server,
// both codecs and the simulation's snapshot types all come from this file.
import { z } from "zod";
import {
  type EntityId,
  type PlayerId,
  type Seq,
  type Tick,
  isEntityId,
  isPlayerId,
  isSeq,
  isTick,
} from "./brand.ts";

export const PROTOCOL_VERSION = 1;
export const TICK_RATE = 30; // server simulation and snapshot rate, Hz
export const TICK_SECONDS = 1 / TICK_RATE;
// One input message repeats the newest few unacknowledged inputs, so a single
// dropped packet does not lose a key press (the server ignores duplicates).
export const MAX_INPUTS_PER_MESSAGE = 4;

// Lookup tables: the binary codec sends the index, never the string.
export const ENTITY_KINDS = ["ship", "bullet", "asteroid", "pickup", "explosion"] as const;
export const EFFECT_NAMES = ["shield", "rapidfire", "homing"] as const;
export const EVENT_TYPES = ["fired", "hit", "exploded"] as const;
export const CODEC_NAMES = ["json", "binary"] as const;
export const CONTROL_KEYS = ["left", "right", "thrust", "fire"] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];
export type EffectName = (typeof EFFECT_NAMES)[number];
export type EventType = (typeof EVENT_TYPES)[number];
export type CodecName = (typeof CODEC_NAMES)[number];

// --- results ------------------------------------------------------------------

export type Result<T, E = ProtocolIssue> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };
export interface ProtocolIssue {
  readonly code: string;
  readonly message: string;
}
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = (code: string, message: string): Result<never> => ({ ok: false, error: { code, message } });

// --- primitives -----------------------------------------------------------------

const isNumber = (value: unknown): value is number => typeof value === "number";
const EntityIdSchema = z.custom<EntityId>((v) => isNumber(v) && isEntityId(v), "Expected a u16 entity id");
const PlayerIdSchema = z.custom<PlayerId>((v) => isNumber(v) && isPlayerId(v), "Expected a u8 player id");
const TickSchema = z.custom<Tick>((v) => isNumber(v) && isTick(v), "Expected a u32 tick");
const SeqSchema = z.custom<Seq>((v) => isNumber(v) && isSeq(v), "Expected a u32 seq");
const finite = z.number().finite();

export const RoomIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "Room id: lowercase letters, digits and -");
export const ArenaSchema = z
  .strictObject({
    width: z.number().int().min(320).max(4096),
    height: z.number().int().min(240).max(4096),
    asteroids: z.number().int().min(0).max(100),
  })
  .readonly();
export type Arena = z.infer<typeof ArenaSchema>;

export const ControlsSchema = z
  .strictObject({ left: z.boolean(), right: z.boolean(), thrust: z.boolean(), fire: z.boolean() })
  .readonly();
export type Controls = z.infer<typeof ControlsSchema>;
export const NO_CONTROLS: Controls = Object.freeze({ left: false, right: false, thrust: false, fire: false });

export const NetSimSchema = z
  .strictObject({
    lag: z.number().min(0).max(1000),
    jitter: z.number().min(0).max(500),
    drop: z.number().min(0).max(0.5),
  })
  .readonly();
export type NetSim = z.infer<typeof NetSimSchema>;

// --- entity snapshots (the wire form of every entity kind) ------------------------

const common = { id: EntityIdSchema, x: finite, y: finite, angle: finite };

export const ShipSnapshotSchema = z
  .strictObject({
    ...common,
    kind: z.literal("ship"),
    vx: finite,
    vy: finite,
    hp: z.number().int().min(0).max(255),
    score: z.number().int().min(0),
    owner: PlayerIdSchema,
    bot: z.boolean(),
    thrusting: z.boolean(),
    fireCooldown: z.number().min(0),
    effects: z.partialRecord(z.enum(EFFECT_NAMES), z.number().min(0)).readonly(),
  })
  .readonly();
export const BulletSnapshotSchema = z
  .strictObject({
    ...common,
    kind: z.literal("bullet"),
    vx: finite,
    vy: finite,
    owner: PlayerIdSchema,
    seq: SeqSchema,
    ttl: finite,
    homing: z.boolean(),
  })
  .readonly();
export const AsteroidSnapshotSchema = z
  .strictObject({
    ...common,
    kind: z.literal("asteroid"),
    radius: z.number().positive(),
    hp: z.number().int().min(0).max(255),
    maxHp: z.number().int().min(0).max(255),
    homing: z.boolean(),
    shape: z.array(finite).length(11).readonly(),
  })
  .readonly();
export const PickupSnapshotSchema = z
  .strictObject({ ...common, kind: z.literal("pickup"), effect: z.enum(EFFECT_NAMES) })
  .readonly();
export const ExplosionSnapshotSchema = z
  .strictObject({
    ...common,
    kind: z.literal("explosion"),
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    count: z.number().min(0).max(255),
    speed: z.number().min(0),
    age: z.number().min(0),
  })
  .readonly();

export const EntitySnapshotSchema = z.discriminatedUnion("kind", [
  ShipSnapshotSchema,
  BulletSnapshotSchema,
  AsteroidSnapshotSchema,
  PickupSnapshotSchema,
  ExplosionSnapshotSchema,
]);
export type ShipSnapshot = z.infer<typeof ShipSnapshotSchema>;
export type BulletSnapshot = z.infer<typeof BulletSnapshotSchema>;
export type AsteroidSnapshot = z.infer<typeof AsteroidSnapshotSchema>;
export type PickupSnapshot = z.infer<typeof PickupSnapshotSchema>;
export type ExplosionSnapshot = z.infer<typeof ExplosionSnapshotSchema>;
export type EntitySnapshot = z.infer<typeof EntitySnapshotSchema>;

// --- realtime messages (JSON or binary) ---------------------------------------------

const InputFrameSchema = z.strictObject({ seq: SeqSchema, controls: ControlsSchema }).readonly();
export type InputFrame = z.infer<typeof InputFrameSchema>;

export const InputMessageSchema = z
  .strictObject({
    type: z.literal("input"),
    inputs: z
      .array(InputFrameSchema)
      .min(1)
      .max(MAX_INPUTS_PER_MESSAGE)
      .readonly()
      .refine(
        (inputs) => inputs.every((input, i) => i === 0 || input.seq === (inputs[i - 1]?.seq ?? -1) + 1),
        "Input seqs must be consecutive",
      ),
  })
  .readonly();
export const PingMessageSchema = z.strictObject({ type: z.literal("ping"), t: finite }).readonly();
export const PongMessageSchema = z.strictObject({ type: z.literal("pong"), t: finite, tick: TickSchema }).readonly();
export const GameEventSchema = z.strictObject({ type: z.enum(EVENT_TYPES), id: EntityIdSchema }).readonly();
export const StateMessageSchema = z
  .strictObject({
    type: z.literal("state"),
    tick: TickSchema,
    ack: SeqSchema,
    events: z.array(GameEventSchema).readonly(),
    entities: z.array(EntitySnapshotSchema).readonly(),
  })
  .readonly();

export type InputMessage = z.infer<typeof InputMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type GameEvent = z.infer<typeof GameEventSchema>;
export type StateMessage = z.infer<typeof StateMessageSchema>;
export type RealtimeMessage = InputMessage | PingMessage | PongMessage | StateMessage;

// --- client -> server (JSON) ------------------------------------------------------------

export const JoinMessageSchema = z
  .strictObject({
    type: z.literal("join"),
    room: RoomIdSchema,
    name: z.string().trim().min(1).max(20),
    codec: z.enum(CODEC_NAMES).default("json"),
  })
  .readonly();
export const ChatMessageSchema = z
  .strictObject({ type: z.literal("chat"), text: z.string().trim().min(1).max(500) })
  .readonly();
export const NetSimMessageSchema = z
  .strictObject({ type: z.literal("netsim"), ...NetSimSchema.unwrap().shape })
  .readonly();

export const ClientMessageSchema = z.discriminatedUnion("type", [
  JoinMessageSchema,
  ChatMessageSchema,
  InputMessageSchema,
  PingMessageSchema,
  NetSimMessageSchema,
]);
export type JoinMessage = z.infer<typeof JoinMessageSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type NetSimMessage = z.infer<typeof NetSimMessageSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// --- server -> client (JSON) ------------------------------------------------------------

const PlayerRefSchema = z.strictObject({ id: z.string(), name: z.string() }).readonly();
export const RosterEntrySchema = z
  .strictObject({ id: z.string(), playerId: PlayerIdSchema, name: z.string(), color: z.string() })
  .readonly();
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const JoinedMessageSchema = z
  .strictObject({
    type: z.literal("joined"),
    room: RoomIdSchema,
    player: z.strictObject({ id: z.string(), playerId: PlayerIdSchema, name: z.string() }).readonly(),
    arena: ArenaSchema,
    tickRate: z.number().int().positive(),
    codec: z.enum(CODEC_NAMES),
    netsim: NetSimSchema,
  })
  .readonly();
export const RosterMessageSchema = z
  .strictObject({ type: z.literal("roster"), room: RoomIdSchema, players: z.array(RosterEntrySchema).readonly() })
  .readonly();
export const ChatBroadcastSchema = z
  .strictObject({
    type: z.literal("chat"),
    room: RoomIdSchema,
    id: z.string(),
    player: PlayerRefSchema,
    text: z.string(),
    at: z.number(),
  })
  .readonly();
export const ErrorMessageSchema = z.strictObject({ type: z.literal("error"), code: z.string(), message: z.string() }).readonly();
export const NetSimAckSchema = NetSimMessageSchema;

export const ServerMessageSchema = z.discriminatedUnion("type", [
  JoinedMessageSchema,
  RosterMessageSchema,
  ChatBroadcastSchema,
  ErrorMessageSchema,
  NetSimAckSchema,
  StateMessageSchema,
  PongMessageSchema,
]);
export type JoinedMessage = z.infer<typeof JoinedMessageSchema>;
export type RosterMessage = z.infer<typeof RosterMessageSchema>;
export type ChatBroadcast = z.infer<typeof ChatBroadcastSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// --- HTTP API -------------------------------------------------------------------------------

export const RoomInfoSchema = z
  .strictObject({
    id: RoomIdSchema,
    name: z.string(),
    players: z.number().int().min(0),
    capacity: z.number().int().positive(),
    arena: ArenaSchema,
  })
  .readonly();
export const RoomsResponseSchema = z.strictObject({ rooms: z.array(RoomInfoSchema).readonly() }).readonly();
export const CreateRoomRequestSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u, "Room name must be 1–40 letters, numbers, spaces, _ or -"),
    arena: ArenaSchema.optional(),
  })
  .readonly();
export type RoomInfo = z.infer<typeof RoomInfoSchema>;
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

// --- parsing --------------------------------------------------------------------------------

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

// Validate any value against a schema without throwing.
export function check<S extends z.ZodType>(schema: S, value: unknown, code = "invalid-message"): Result<z.infer<S>> {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : fail(code, describe(parsed.error));
}

export function parseJson(text: string): Result<unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return ok(value);
  } catch {
    return fail("invalid-json", "Message must be valid JSON");
  }
}

const KNOWN_CLIENT_TYPES = new Set<string>(ClientMessageSchema.options.map((option) => option.unwrap().shape.type.value));

// The versioned JSON envelope: { v: PROTOCOL_VERSION, type, ...fields }.
function openEnvelope(value: unknown): Result<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return fail("invalid-message", "Message must be a JSON object");
  const { v, ...message } = Object.fromEntries(Object.entries(value));
  if (v !== PROTOCOL_VERSION) return fail("unsupported-version", "Unsupported protocol version");
  return ok(message);
}

// Client -> server: unknown in, a typed ClientMessage or an issue out.
// The error code names the message type, e.g. "invalid-join".
export function parseClientMessage(value: unknown): Result<ClientMessage> {
  const envelope = openEnvelope(value);
  if (!envelope.ok) return envelope;
  const type = envelope.value["type"];
  if (typeof type !== "string" || !KNOWN_CLIENT_TYPES.has(type)) return fail("unknown-type", "Unknown message type");
  return check(ClientMessageSchema, envelope.value, `invalid-${type}`);
}

export function parseServerMessage(value: unknown): Result<ServerMessage> {
  const envelope = openEnvelope(value);
  return envelope.ok ? check(ServerMessageSchema, envelope.value) : envelope;
}

export function encodeJson(message: ClientMessage | ServerMessage | RealtimeMessage): string {
  return JSON.stringify({ v: PROTOCOL_VERSION, ...message });
}

// Exhaustiveness helper: a `default` that only compiles when every case of a
// union has been handled.
export function assertNever(value: never, what = "value"): never {
  throw new TypeError(`Unhandled ${what}: ${JSON.stringify(value)}`);
}
