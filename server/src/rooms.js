import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const ROOM_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u;

export class Room extends EventEmitter {
  constructor({ id = randomUUID().slice(0, 8), name = "Orbit", arena, maxPlayers = 16 } = {}) {
    super();
    this.id = id;
    this.name = name;
    this.arena = arena ?? { width: 960, height: 540, asteroids: 6 };
    this.maxPlayers = maxPlayers;
    this.players = new Map();
    this.createdAt = Date.now();
  }

  join(player) {
    if (this.players.has(player.id)) throw new Error("Player is already in this room");
    if (this.players.size >= this.maxPlayers) throw new RangeError("Room is full");
    this.players.set(player.id, player);
    const joined = { id: player.id, name: player.name };
    this.emit("join", joined);
    this.record("join", joined);
  }

  leave(playerId) {
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

  chat(player, text) {
    const message = {
      id: randomUUID(),
      player: { id: player.id, name: player.name },
      text,
      at: Date.now(),
    };
    this.emit("chat", message);
    this.record("chat", message);
    return message;
  }

  roster() {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  record(type, data) {
    this.emit("event", { t: Date.now(), type, room: this.id, ...data });
  }
}

export class RoomManager extends EventEmitter {
  #rooms = new Map();

  constructor({ maxRooms = 100, maxPlayersPerRoom = 16, onRoom } = {}) {
    super();
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
    this.onRoom = onRoom;
    this.create({ id: "orbit", name: "Orbit", arena: { width: 960, height: 540, asteroids: 6 } });
    this.create({ id: "deep-field", name: "Deep Field", arena: { width: 1280, height: 720, asteroids: 10 } });
  }

  create({ id = randomUUID().slice(0, 8), name, arena } = {}) {
    if (typeof name !== "string" || !ROOM_NAME.test(name.trim()))
      throw new TypeError("Room name must be 1–40 letters, numbers, spaces, _ or -");
    const roomId = id === undefined ? randomUUID().slice(0, 8) : id;
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(roomId) || this.#rooms.has(roomId))
      throw new TypeError("Room id is invalid or already in use");
    if (this.#rooms.size >= this.maxRooms) throw new RangeError("Server room limit reached");

    const room = new Room({
      id: roomId,
      name: name.trim(),
      arena,
      maxPlayers: this.maxPlayersPerRoom,
    });
    room.on("error", (error) => this.emit("error", error));
    room.once("empty", () => {
      this.#rooms.delete(room.id);
      this.emit("roomRemoved", room);
    });
    this.#rooms.set(room.id, room);
    this.onRoom?.(room);
    this.emit("roomCreated", room);
    return room;
  }

  get(id) {
    return this.#rooms.get(id);
  }

  list() {
    return [...this.#rooms.values()].map((room) => ({
      id: room.id,
      name: room.name,
      players: room.players.size,
      capacity: room.maxPlayers,
      arena: room.arena,
    }));
  }
}
