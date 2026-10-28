import { botControls } from "@dogfight/shared/sim/ai.js";
import { createGame } from "@dogfight/shared/sim/game.js";
import { Ship } from "@dogfight/shared/sim/ship.js";
import { Vector2 } from "@dogfight/shared/sim/vector.js";
import { snapshotEntities } from "@dogfight/shared/sim/snapshot.js";
import { TICK_SECONDS } from "@dogfight/shared/protocol/messages.js";

export const PLAYER_COLORS = ["#8df0a5", "#ffb86c", "#d6a5ff", "#6de0df", "#ff8fa3", "#f6e879", "#e8f0ff"];
const MAX_QUEUED_INPUTS = 12; // ~400 ms; older inputs are dropped (and acked)
const MAX_INPUT_CREDIT = 6; // how far a client may catch up after a stall, in ticks
const MAX_SEQ_JUMP = 1000; // a seq further ahead than this is not a real client

function seedFromRoomId(id) {
  let seed = 2166136261;
  for (const character of id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return seed >>> 0 || 1;
}

// One authoritative simulation per room. Clients only send inputs; the Match
// applies them one per tick, in seq order, and reports back the last seq it
// applied (ack) so each client can reconcile its prediction.
//
// Input timing is the subtle part. The client predicted input N on top of
// input N-1, so the server must do the same, whatever the network did:
//   * no input queued for a ship this tick -> the ship is FROZEN (not
//     updated), instead of repeating the last input the client never sent;
//   * several queued after a jitter burst -> the extras run as ship-only
//     sub-steps, so the queue drains instead of adding latency forever.
// Catch-up is paid for with credit earned at one input per tick, so a client
// that sends inputs faster than real time cannot move faster (speed hack).
export class Match {
  #players = new Map(); // room player id (uuid) -> record
  #events = [];

  constructor(room, { withBot = true } = {}) {
    this.room = room;
    const { world, bot } = createGame({
      width: room.arena.width,
      height: room.arena.height,
      seed: seedFromRoomId(room.id),
      asteroids: room.arena.asteroids,
      withBot,
      withPlayer: false,
      assignIds: true,
    });
    this.world = world;
    this.bot = bot;
    world.addEventListener("fired", ({ detail }) => this.#events.push({ type: "fired", id: detail.ship.id }));
    world.addEventListener("hit", ({ detail }) => this.#events.push({ type: "hit", id: detail.target.id }));
    world.addEventListener("exploded", ({ detail }) =>
      this.#events.push({ type: "exploded", id: detail.entity.id }),
    );
    this.stats = { inputsApplied: 0, inputsDropped: 0, frozenTicks: 0, catchUpSteps: 0 };
  }

  get playerCount() {
    return this.#players.size;
  }

  // Returns the small numeric id (1..255) used on the wire.
  join({ id, name }) {
    const playerId = this.#freePlayerId();
    const slot = this.#players.size;
    const angle = (slot * Math.PI * 2) / Math.max(2, this.room.maxPlayers);
    const distance = Math.min(this.room.arena.width, this.room.arena.height) / 4;
    const ship = this.world.spawn(
      new Ship({
        pos: new Vector2(
          this.room.arena.width / 2 + Math.cos(angle + Math.PI) * distance,
          this.room.arena.height / 2 + Math.sin(angle + Math.PI) * distance,
        ),
        color: PLAYER_COLORS[(playerId - 1) % PLAYER_COLORS.length],
        name,
      }),
    );
    ship.playerId = playerId;
    this.#players.set(id, {
      playerId,
      name,
      ship,
      queue: [],
      lastReceivedSeq: 0,
      lastProcessedSeq: 0,
      credit: 1,
    });
    return playerId;
  }

  leave(id) {
    const player = this.#players.get(id);
    if (!player) return;
    this.#players.delete(id);
    player.ship.alive = false;
    this.world.despawn(player.ship.id);
  }

  player(id) {
    return this.#players.get(id);
  }

  roster() {
    return [...this.#players.entries()].map(([id, { playerId, name, ship }]) => ({
      id,
      playerId,
      name,
      color: ship.color,
    }));
  }

  // inputs: validated [{ seq, controls }] (consecutive seqs, possibly
  // repeating ones already received: redundancy against packet loss).
  receiveInputs(id, inputs) {
    const player = this.#players.get(id);
    if (!player) return;
    for (const input of inputs) {
      if (input.seq <= player.lastReceivedSeq) continue; // duplicate
      if (player.lastReceivedSeq > 0 && input.seq > player.lastReceivedSeq + MAX_SEQ_JUMP) continue;
      player.lastReceivedSeq = input.seq;
      player.queue.push(input);
    }
    while (player.queue.length > MAX_QUEUED_INPUTS) {
      player.lastProcessedSeq = player.queue.shift().seq;
      this.stats.inputsDropped++;
    }
  }

  step() {
    const inputs = new Map();
    for (const player of this.#players.values()) {
      const { ship } = player;
      player.credit = Math.min(MAX_INPUT_CREDIT, player.credit + 1);
      ship.frozen = false;
      // Catch-up: everything but the newest input runs as a ship-only sub-step.
      while (player.queue.length > 1 && player.credit > 1) {
        this.#applyAlone(player, player.queue.shift());
        this.stats.catchUpSteps++;
      }
      const next = player.queue.shift();
      if (next) {
        player.credit--;
        player.lastProcessedSeq = next.seq;
        inputs.set(ship.id, { ...next.controls, seq: next.seq });
        this.stats.inputsApplied++;
      } else if (ship.alive) {
        ship.frozen = true;
        this.stats.frozenTicks++;
      }
    }
    if (this.bot) inputs.set(this.bot.id, botControls(this.world, this.bot));
    this.world.step(TICK_SECONDS, inputs);
  }

  #applyAlone(player, { seq, controls }) {
    player.credit--;
    player.lastProcessedSeq = seq;
    this.stats.inputsApplied++;
    const { ship } = player;
    if (!ship.alive || !ship.world) return;
    ship.controls = { ...controls, seq };
    ship.update(TICK_SECONDS);
  }

  // The shared part of every client's snapshot; `ack` is added per client.
  snapshot() {
    return {
      type: "state",
      tick: this.world.tick,
      ack: 0,
      events: this.#events.splice(0).filter((event) => typeof event.id === "number"),
      entities: snapshotEntities(this.world),
    };
  }

  #freePlayerId() {
    const used = new Set([...this.#players.values()].map((player) => player.playerId));
    for (let id = 1; id <= 255; id++) if (!used.has(id)) return id;
    throw new RangeError("Room has no free player ids");
  }
}
