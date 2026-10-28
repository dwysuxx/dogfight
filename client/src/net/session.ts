// The client half of the netcode: sends inputs, predicts the own ship,
// reconciles on every snapshot, interpolates everyone else, and measures it
// all for the netgraph. Knows nothing about the DOM or the canvas.
import { type EntityId, type PlayerId, type Seq, seq } from "@dogfight/shared/brand.ts";
import { Bus } from "@dogfight/shared/bus.ts";
import { Predictor } from "@dogfight/shared/net/prediction.ts";
import {
  type Arena,
  type Controls,
  type EntitySnapshot,
  type InputFrame,
  MAX_INPUTS_PER_MESSAGE,
  type NetSim,
  type StateMessage,
  TICK_SECONDS,
} from "@dogfight/shared/protocol.ts";
import type { Ship } from "@dogfight/shared/sim/ship.ts";
import { entityFromSnapshot } from "@dogfight/shared/sim/snapshot.ts";
import type { Vector2 } from "@dogfight/shared/sim/vector.ts";
import type { GameEntity } from "@dogfight/shared/sim/world.ts";
import type { GameConnection } from "../connection.ts";
import { SnapshotBuffer, interpolateEntity } from "../snapshot-buffer.ts";

const PING_INTERVAL_MS = 500;

// What the rest of the client can listen to (sounds, netgraph).
export type GameEvents = {
  fired: { own: boolean };
  hit: { id: EntityId };
  exploded: { id: EntityId };
  correction: { px: number };
};

export interface Renderable {
  readonly entity: GameEntity;
  readonly alpha: number;
  readonly offset: Vector2 | null;
}

export interface NetStats {
  rtt: number | null;
  rttAvg: number | null;
  bytesInPerSecond: number;
  bytesOutPerSecond: number;
  correction: number;
  correctionMax: number;
  correctionAvg: number;
  snapshotsPerSecond: number;
  serverTick: number;
  netsim: NetSim | null;
}

export interface NetgraphSample extends NetStats {
  codec: string;
  snapshotAge: number | null;
  pendingInputs: number;
  interpolationDelayMs: number;
  renderTicksBehind: number;
  prediction: boolean;
  interpolation: boolean;
}

export class GameSession {
  readonly events = new Bus<GameEvents>();
  readonly buffer = new SnapshotBuffer<StateMessage>();
  readonly players = new Map<PlayerId, { name: string; color: string }>();
  readonly connection: GameConnection;
  readonly perturb: ((ship: Ship) => void) | null;
  arena: Arena;
  playerId: PlayerId | null = null;
  predictor: Predictor | null = null;
  latestState: StateMessage | null = null;
  prediction = true; // P toggles: off = the own ship moves only on snapshots
  interpolation = true; // I toggles: off = remote entities jump to each snapshot
  readonly stats: NetStats = {
    rtt: null,
    rttAvg: null,
    bytesInPerSecond: 0,
    bytesOutPerSecond: 0,
    correction: 0,
    correctionMax: 0,
    correctionAvg: 0,
    snapshotsPerSecond: 0,
    serverTick: 0,
    netsim: null,
  };
  #recentInputs: InputFrame[] = [];
  #pingTimer: ReturnType<typeof setInterval>;
  #unsubscribe: (() => void)[] = [];
  #seq = 0;
  #corrections: { at: number; value: number }[] = [];
  #snapshotTimes: number[] = [];
  #lastSecond = { at: 0, bytesIn: 0, bytesOut: 0 };

  constructor({ connection, arena, perturb = null }: { connection: GameConnection; arena: Arena; perturb?: ((ship: Ship) => void) | null }) {
    this.connection = connection;
    this.arena = arena;
    this.perturb = perturb;
    const { events } = connection;
    this.#unsubscribe.push(
      events.on("joined", ({ player, netsim, arena: joinedArena }) => this.#onJoined(player.playerId, netsim, joinedArena)),
      events.on("roster", ({ players }) => {
        this.players.clear();
        for (const { playerId, name, color } of players) this.players.set(playerId, { name, color });
      }),
      events.on("state", (state) => this.#onState(state)),
      events.on("pong", ({ t }) => {
        const rtt = performance.now() - t;
        this.stats.rtt = rtt;
        this.stats.rttAvg = this.stats.rttAvg === null ? rtt : this.stats.rttAvg * 0.8 + rtt * 0.2;
      }),
      events.on("netsim", (conditions) => (this.stats.netsim = conditions)),
    );
    this.#pingTimer = setInterval(() => connection.sendPing(performance.now()), PING_INTERVAL_MS);
  }

  #onJoined(playerId: PlayerId, netsim: NetSim, arena: Arena): void {
    // Also runs after a reconnect: the server made a new ship, so start over.
    this.playerId = playerId;
    this.arena = arena;
    this.stats.netsim = netsim;
    this.#recentInputs = [];
    this.buffer.clear();
    this.predictor = new Predictor({
      bounds: arena,
      playerId,
      players: this.players,
      dt: TICK_SECONDS,
      perturb: this.perturb,
      onFire: () => this.events.emit("fired", { own: true }),
    });
  }

  #onState(state: StateMessage): void {
    const now = performance.now();
    this.latestState = state;
    this.stats.serverTick = state.tick;
    this.buffer.push(state, now);
    this.#snapshotTimes.push(now);

    const correction = this.predictor?.reconcile(state);
    if (correction !== null && correction !== undefined) {
      this.stats.correction = correction;
      this.#corrections.push({ at: now, value: correction });
      this.events.emit("correction", { px: correction });
    }

    const ownShipId = this.#ownShip(state)?.id;
    for (const { type, id } of state.events) {
      if (type === "fired") {
        // Own shots already made their sound when they were predicted.
        if (id === ownShipId && this.prediction) continue;
        this.events.emit("fired", { own: id === ownShipId });
      } else {
        this.events.emit(type, { id });
      }
    }
  }

  #isOwn(data: EntitySnapshot): boolean {
    return (data.kind === "ship" && !data.bot && data.owner === this.playerId) || (data.kind === "bullet" && data.owner === this.playerId);
  }

  #ownShip(state: StateMessage | null): EntitySnapshot | undefined {
    return state?.entities.find((e) => e.kind === "ship" && this.#isOwn(e));
  }

  // One client simulation step = one input, same dt as a server tick.
  step(controls: Controls): void {
    if (!this.predictor) return;
    const next: Seq = seq(++this.#seq);
    this.#recentInputs.push({ seq: next, controls });
    if (this.#recentInputs.length > MAX_INPUTS_PER_MESSAGE) this.#recentInputs.shift();
    this.connection.sendInputs(this.#recentInputs);
    this.predictor.applyInput(next, controls);
  }

  setNetSim(conditions: NetSim): void {
    this.connection.sendNetSim(conditions);
  }

  // What to draw this frame.
  renderables(now: number, frameSeconds: number, stepAlpha: number): Renderable[] {
    const items: Renderable[] = [];
    const context = { players: this.players };
    const predicted = this.prediction && this.predictor !== null;
    const remote = (data: EntitySnapshot) => !(predicted && this.#isOwn(data));

    if (this.interpolation) {
      const sample = this.buffer.sample(now);
      if (sample) {
        const before = new Map(sample.before.entities.map((e) => [e.id, e]));
        const after = new Set<EntityId>();
        for (const data of sample.after.entities) {
          after.add(data.id);
          if (!remote(data)) continue;
          const previous = before.get(data.id);
          const lerped = interpolateEntity(previous?.kind === data.kind ? previous : undefined, data, sample.alpha, this.arena);
          items.push({ entity: entityFromSnapshot(lerped, context), alpha: 1, offset: null });
        }
        // Gone in the newer snapshot: keep drawing it until we get there.
        if (sample.alpha < 1)
          for (const data of sample.before.entities)
            if (!after.has(data.id) && remote(data)) items.push({ entity: entityFromSnapshot(data, context), alpha: 1, offset: null });
      }
    } else if (this.latestState) {
      for (const data of this.latestState.entities)
        if (remote(data)) items.push({ entity: entityFromSnapshot(data, context), alpha: 1, offset: null });
    }

    // Prediction off: the own ship took the remote path above, so it moves
    // only when snapshots say so, a full round trip after the key press.
    if (predicted && this.predictor) {
      this.predictor.smooth(frameSeconds);
      const ship = this.predictor.ship;
      for (const entity of this.predictor.entities()) {
        items.push({ entity, alpha: stepAlpha, offset: entity === ship ? this.predictor.offset : null });
      }
    }
    return items;
  }

  // HUD data: own ship (predicted when possible) and the bot.
  hudState(): { player: Ship | null; bot: Ship | null } {
    const context = { players: this.players };
    const asShip = (data: EntitySnapshot | undefined): Ship | null => {
      if (data?.kind !== "ship") return null;
      const entity = entityFromSnapshot(data, context);
      return entity.kind === "ship" ? entity : null;
    };
    const predicted = this.prediction ? (this.predictor?.ship ?? null) : null;
    return {
      player: predicted ?? asShip(this.#ownShip(this.latestState)),
      bot: asShip(this.latestState?.entities.find((e) => e.kind === "ship" && e.bot)),
    };
  }

  // Netgraph numbers, refreshed once per second for the rates.
  sampleStats(now: number): NetgraphSample {
    const windowStart = now - 1000;
    this.#corrections = this.#corrections.filter((c) => c.at >= windowStart);
    this.#snapshotTimes = this.#snapshotTimes.filter((t) => t >= windowStart);
    const values = this.#corrections.map((c) => c.value);
    this.stats.correctionMax = values.length ? Math.max(...values) : 0;
    this.stats.correctionAvg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    this.stats.snapshotsPerSecond = this.#snapshotTimes.length;
    if (now - this.#lastSecond.at >= 1000) {
      const elapsed = (now - this.#lastSecond.at) / 1000;
      if (this.#lastSecond.at > 0) {
        this.stats.bytesInPerSecond = (this.connection.bytesIn - this.#lastSecond.bytesIn) / elapsed;
        this.stats.bytesOutPerSecond = (this.connection.bytesOut - this.#lastSecond.bytesOut) / elapsed;
      }
      this.#lastSecond = { at: now, bytesIn: this.connection.bytesIn, bytesOut: this.connection.bytesOut };
    }
    const latest = this.buffer.latest;
    return {
      ...this.stats,
      codec: this.connection.codec.name,
      snapshotAge: latest ? now - latest.receivedAt : null,
      pendingInputs: this.predictor?.pendingCount ?? 0,
      interpolationDelayMs: this.buffer.interpolationDelayMs,
      renderTicksBehind: latest ? latest.state.tick - this.buffer.renderTick : 0,
      prediction: this.prediction,
      interpolation: this.interpolation,
    };
  }

  dispose(): void {
    clearInterval(this.#pingTimer);
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
    this.events.clear();
  }
}


