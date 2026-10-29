import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Arena, RoomInfo } from "@dogfight/shared/protocol.ts";

const ROOM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u;
const ROOM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_ARENA: Arena = { width: 960, height: 540, asteroids: 6 };

export interface RoomPlayer {
  readonly id: string;
  readonly name: string;
}

export interface ChatRecord {
  readonly id: string;
  readonly player: RoomPlayer;
  readonly text: string;
  readonly at: number;
}

// One line of the match log (NDJSON).
export interface LogEvent {
  readonly t: number;
  readonly type: string;
  readonly room: string;
  readonly [field: string]: unknown;
}

// Node's EventEmitter is generic: the map below types every on()/emit(), so
// `room.emit("join", 42)` or a listener expecting the wrong payload no longer compiles.
export type RoomEvents = {
  join: [player: RoomPlayer];
  leave: [player: RoomPlayer];
  chat: [chat: ChatRecord];
  empty: [room: Room];
  event: [event: LogEvent];
  error: [error: Error];
};

export class Room extends EventEmitter<RoomEvents> {
  readonly id: string;
  readonly name: string;
  readonly arena: Arena;
  readonly maxPlayers: number;
  readonly players = new Map<string, RoomPlayer>();
  readonly createdAt = Date.now();
  // The lobby's built-in rooms stay when empty; player-made rooms do not.
  readonly persistent: boolean;

  constructor({
    id = randomUUID().slice(0, 8),
    name = "Orbit",
    arena = DEFAULT_ARENA,
    maxPlayers = 16,
    persistent = false,
  }: { id?: string; name?: string; arena?: Arena; maxPlayers?: number; persistent?: boolean } = {}) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena;
    this.maxPlayers = maxPlayers;
    this.persistent = persistent;
  }

  join(player: RoomPlayer): void {
    if (this.players.has(player.id)) throw new Error("Player is already in this room");
    if (this.players.size >= this.maxPlayers) throw new RangeError("Room is full");
    this.players.set(player.id, player);
    const joined = { id: player.id, name: player.name };
    this.emit("join", joined);
    this.record("join", joined);
  }

  leave(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    this.players.delete(playerId);
    const departed = { id: player.id, name: player.name };
    this.emit("leave", departed);
    this.record("leave", departed);
    if (this.players.size === 0) {
      this.emit("empty", this);
      this.record("empty", { room: this.id });
    }
    return true;
  }

  chat(player: RoomPlayer, text: string): ChatRecord {
    const message: ChatRecord = {
      id: randomUUID(),
      player: { id: player.id, name: player.name },
      text,
      at: Date.now(),
    };
    this.emit("chat", message);
    this.record("chat", message);
    return message;
  }

  roster(): RoomPlayer[] {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  info(): RoomInfo {
    return { id: this.id, name: this.name, players: this.players.size, capacity: this.maxPlayers, arena: this.arena };
  }

  record(type: string, data: object): void {
    this.emit("event", { t: Date.now(), type, room: this.id, ...data });
  }
}

export type RoomManagerEvents = {
  roomCreated: [room: Room];
  roomRemoved: [room: Room];
  error: [error: Error];
};

export class RoomManager extends EventEmitter<RoomManagerEvents> {
  #rooms = new Map<string, Room>();
  #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly maxRooms: number;
  readonly maxPlayersPerRoom: number;
  readonly idleMs: number;
  readonly onRoom: ((room: Room) => void) | undefined;

  constructor({
    maxRooms = 100,
    maxPlayersPerRoom = 16,
    idleMs = 0,
    onRoom,
  }: { maxRooms?: number; maxPlayersPerRoom?: number; idleMs?: number; onRoom?: (room: Room) => void } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.idleMs = idleMs;
    this.onRoom = onRoom;
    this.create({ id: "orbit", name: "Orbit", arena: { width: 960, height: 540, asteroids: 6 }, persistent: true });
    this.create({
      id: "deep-field",
      name: "Deep Field",
      arena: { width: 1280, height: 720, asteroids: 10 },
      persistent: true,
    });
  }

  create({
    id = randomUUID().slice(0, 8),
    name,
    arena,
    persistent = false,
  }: {
    id?: string;
    name: string;
    arena?: Arena | undefined;
    persistent?: boolean;
  }): Room {
    if (!ROOM_NAME.test(name.trim())) throw new TypeError("Room name must be 1–40 letters, numbers, spaces, _ or -");
    if (!ROOM_ID.test(id) || this.#rooms.has(id)) throw new TypeError("Room id is invalid or already in use");
    if (this.#rooms.size >= this.maxRooms) throw new RangeError("Server room limit reached");

    const room = new Room({
      id,
      name: name.trim(),
      arena: arena ?? DEFAULT_ARENA,
      maxPlayers: this.maxPlayersPerRoom,
      persistent,
    });
    room.on("error", (error) => this.emit("error", error));
    if (!persistent) {
      // An empty room lingers for idleMs (a creator who reloads the page finds
      // it again), then goes; a room nobody ever joins goes the same way, so
      // creating rooms in a loop cannot fill up maxRooms for good.
      const onEmpty = () => this.#scheduleRemoval(room, remove);
      const onJoin = () => this.#cancelRemoval(room.id);
      const remove = () => {
        room.off("empty", onEmpty);
        room.off("join", onJoin);
        this.#rooms.delete(room.id);
        this.emit("roomRemoved", room);
      };
      room.on("empty", onEmpty);
      room.on("join", onJoin);
      if (this.idleMs > 0) this.#scheduleRemoval(room, remove);
    }
    this.#rooms.set(room.id, room);
    this.onRoom?.(room);
    this.emit("roomCreated", room);
    return room;
  }

  #scheduleRemoval(room: Room, remove: () => void): void {
    this.#cancelRemoval(room.id);
    if (this.idleMs === 0) return remove();
    const timer = setTimeout(() => {
      this.#idleTimers.delete(room.id);
      if (room.players.size === 0) remove();
    }, this.idleMs);
    timer.unref();
    this.#idleTimers.set(room.id, timer);
  }

  #cancelRemoval(id: string): void {
    clearTimeout(this.#idleTimers.get(id));
    this.#idleTimers.delete(id);
  }

  dispose(): void {
    for (const timer of this.#idleTimers.values()) clearTimeout(timer);
    this.#idleTimers.clear();
  }

  get(id: string): Room | undefined {
    return this.#rooms.get(id);
  }

  list(): RoomInfo[] {
    return [...this.#rooms.values()].map((room) => room.info());
  }
}
