import { type EntityId, NO_SEQ, type PlayerId, type Seq, playerId } from "@dogfight/shared/brand.ts";
import {
  type Arena,
  type GameEvent,
  type InputFrame,
  type RosterEntry,
  type StateMessage,
  TICK_SECONDS,
} from "@dogfight/shared/protocol.ts";
import { botControls } from "@dogfight/shared/sim/ai.ts";
import type { StepControls } from "@dogfight/shared/sim/entity.ts";
import { createGame } from "@dogfight/shared/sim/game.ts";
import { Ship } from "@dogfight/shared/sim/ship.ts";
import { snapshotEntities } from "@dogfight/shared/sim/snapshot.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import type { World } from "@dogfight/shared/sim/world.ts";

export const PLAYER_COLORS = ["#8df0a5", "#ffb86c", "#d6a5ff", "#6de0df", "#ff8fa3", "#f6e879", "#e8f0ff"] as const;
const MAX_QUEUED_INPUTS = 12; // ~400 ms; older inputs are dropped (and acked)
const MAX_INPUT_CREDIT = 6; // how far a client may catch up after a stall, in ticks
const MAX_SEQ_JUMP = 1000; // a seq further ahead than this is not a real client

export interface MatchRoom {
  readonly id: string;
  readonly arena: Arena;
  readonly maxPlayers: number;
}

export interface MatchPlayer {
  readonly playerId: PlayerId;
  readonly name: string;
  readonly ship: Ship;
  readonly queue: InputFrame[];
  lastReceivedSeq: Seq;
  lastProcessedSeq: Seq;
  credit: number;
}

export interface MatchStats {
  inputsApplied: number;
  inputsDropped: number;
  frozenTicks: number;
  catchUpSteps: number;
}

function seedFromRoomId(id: string): number {
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
  readonly room: MatchRoom;
  readonly world: World;
  readonly bot: Ship | null;
  readonly stats: MatchStats = { inputsApplied: 0, inputsDropped: 0, frozenTicks: 0, catchUpSteps: 0 };
  #players = new Map<string, MatchPlayer>(); // room player id (uuid) -> record
  #events: GameEvent[] = [];

  constructor(room: MatchRoom, { withBot = true }: { withBot?: boolean } = {}) {
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
    world.events.on("fired", ({ ship }) => this.#events.push({ type: "fired", id: ship.id }));
    world.events.on("hit", ({ target }) => this.#events.push({ type: "hit", id: target.id }));
    world.events.on("exploded", ({ entity }) => this.#events.push({ type: "exploded", id: entity.id }));
  }

  get playerCount(): number {
    return this.#players.size;
  }

  // Returns the small numeric id (1..255) used on the wire.
  join({ id, name }: { id: string; name: string }): PlayerId {
    const assigned = this.#freePlayerId();
    const slot = this.#players.size;
    const angle = (slot * Math.PI * 2) / Math.max(2, this.room.maxPlayers);
    const distance = Math.min(this.room.arena.width, this.room.arena.height) / 4;
    const ship = this.world.spawn(
      new Ship({
        pos: new Vector2(
          this.room.arena.width / 2 + Math.cos(angle + Math.PI) * distance,
          this.room.arena.height / 2 + Math.sin(angle + Math.PI) * distance,
        ),
        color: PLAYER_COLORS[(assigned - 1) % PLAYER_COLORS.length] ?? "#e8f0ff",
        name,
      }),
    );
    ship.playerId = assigned;
    this.#players.set(id, {
      playerId: assigned,
      name,
      ship,
      queue: [],
      lastReceivedSeq: NO_SEQ,
      lastProcessedSeq: NO_SEQ,
      credit: 1,
    });
    return assigned;
  }

  leave(id: string): void {
    const player = this.#players.get(id);
    if (!player) return;
    this.#players.delete(id);
    player.ship.alive = false;
    this.world.despawn(player.ship.id);
  }

  player(id: string): MatchPlayer | undefined {
    return this.#players.get(id);
  }

  roster(): RosterEntry[] {
    return [...this.#players.entries()].map(([id, { playerId, name, ship }]) => ({ id, playerId, name, color: ship.color }));
  }

  // Validated inputs (consecutive seqs, possibly repeating ones already
  // received: redundancy against packet loss).
  receiveInputs(id: string, inputs: readonly InputFrame[]): void {
    const player = this.#players.get(id);
    if (!player) return;
    for (const input of inputs) {
      if (input.seq <= player.lastReceivedSeq) continue; // duplicate
      if (player.lastReceivedSeq > 0 && input.seq > player.lastReceivedSeq + MAX_SEQ_JUMP) continue;
      player.lastReceivedSeq = input.seq;
      player.queue.push(input);
    }
    while (player.queue.length > MAX_QUEUED_INPUTS) {
      const dropped = player.queue.shift();
      if (dropped) player.lastProcessedSeq = dropped.seq;
      this.stats.inputsDropped++;
    }
  }

  step(): void {
    const inputs = new Map<EntityId, StepControls>();
    for (const player of this.#players.values()) {
      const { ship } = player;
      player.credit = Math.min(MAX_INPUT_CREDIT, player.credit + 1);
      ship.frozen = false;
      // Catch-up: everything but the newest input runs as a ship-only sub-step.
      while (player.queue.length > 1 && player.credit > 1) {
        const input = player.queue.shift();
        if (input) this.#applyAlone(player, input);
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

  #applyAlone(player: MatchPlayer, { seq, controls }: InputFrame): void {
    player.credit--;
    player.lastProcessedSeq = seq;
    this.stats.inputsApplied++;
    const { ship } = player;
    if (!ship.alive || !ship.world) return;
    ship.controls = { ...controls, seq };
    ship.update(TICK_SECONDS);
  }

  // The shared part of every client's snapshot; `ack` is set per client.
  snapshot(): StateMessage {
    return {
      type: "state",
      tick: this.world.tick,
      ack: NO_SEQ,
      events: this.#events.splice(0),
      entities: snapshotEntities(this.world),
    };
  }

  #freePlayerId(): PlayerId {
    const used = new Set<number>([...this.#players.values()].map((player) => player.playerId));
    for (let id = 1; id <= 255; id++) if (!used.has(id)) return playerId(id);
    throw new RangeError("Room has no free player ids");
  }
}
