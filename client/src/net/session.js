// The client half of the netcode: sends inputs, predicts the own ship,
// reconciles on every snapshot, interpolates everyone else, and measures it
// all for the netgraph. Knows nothing about the DOM or the canvas.
import { MAX_INPUTS_PER_MESSAGE, TICK_SECONDS } from "@dogfight/shared/protocol/messages.js";
import { Predictor } from "@dogfight/shared/net/prediction.js";
import { entityFromSnapshot } from "@dogfight/shared/sim/snapshot.js";
import { interpolateEntity, SnapshotBuffer } from "../snapshot-buffer.js";

const PING_INTERVAL_MS = 500;

export class GameSession extends EventTarget {
  #recentInputs = [];
  #pingTimer = null;
  #unsubscribe = [];
  #seq = 0;
  #corrections = [];
  #snapshotTimes = [];
  #lastSecond = { at: 0, bytesIn: 0, bytesOut: 0 };

  constructor({ connection, arena, perturb = null }) {
    super();
    this.connection = connection;
    this.arena = arena;
    this.perturb = perturb;
    this.buffer = new SnapshotBuffer();
    this.players = new Map(); // playerId -> { name, color }
    this.playerId = null;
    this.predictor = null;
    this.latestState = null;
    this.prediction = true; // P toggles: off = the own ship moves only on snapshots
    this.interpolation = true; // I toggles: off = remote entities jump to each snapshot
    this.stats = {
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
    this.#listen();
  }

  #listen() {
    const on = (type, listener) => this.#unsubscribe.push(this.connection.on(type, listener));
    on("joined", (message) => this.#onJoined(message));
    on("roster", ({ players }) => {
      this.players.clear();
      for (const { playerId, name, color } of players) this.players.set(playerId, { name, color });
    });
    on("state", (state) => this.#onState(state));
    on("pong", ({ t }) => {
      const rtt = performance.now() - t;
      this.stats.rtt = rtt;
      this.stats.rttAvg = this.stats.rttAvg === null ? rtt : this.stats.rttAvg * 0.8 + rtt * 0.2;
    });
    on("netsim", (conditions) => {
      this.stats.netsim = { lag: conditions.lag, jitter: conditions.jitter, drop: conditions.drop };
    });
    this.#pingTimer = setInterval(() => this.connection.sendPing(performance.now()), PING_INTERVAL_MS);
  }

  #onJoined({ player, netsim }) {
    // Also runs after a reconnect: the server made a new ship, so start over.
    this.playerId = player.playerId;
    this.stats.netsim = netsim;
    this.#recentInputs = [];
    this.buffer.clear();
    this.predictor = new Predictor({
      bounds: this.arena,
      playerId: this.playerId,
      players: this.players,
      dt: TICK_SECONDS,
      perturb: this.perturb,
      onFire: () => this.dispatchEvent(new Event("fired")),
    });
  }

  #onState(state) {
    const now = performance.now();
    this.latestState = state;
    this.stats.serverTick = state.tick;
    this.buffer.push(state, now);
    this.#snapshotTimes.push(now);

    const correction = this.predictor?.reconcile(state);
    if (correction !== null && correction !== undefined) {
      this.stats.correction = correction;
      this.#corrections.push({ at: now, value: correction });
      this.dispatchEvent(new CustomEvent("correction", { detail: correction }));
    }

    const ownShipId = this.#ownShipData(state)?.id;
    for (const { type, id } of state.events) {
      // Own shots already made their sound when they were predicted.
      if (type === "fired" && id === ownShipId && this.prediction) continue;
      this.dispatchEvent(new Event(type));
    }
  }

  #ownShipData(state) {
    return state?.entities.find((e) => e.kind === "ship" && !e.bot && e.owner === this.playerId);
  }

  // One client simulation step = one input, same dt as a server tick.
  step(controls) {
    if (!this.predictor) return;
    const seq = ++this.#seq;
    this.#recentInputs.push({ seq, controls });
    if (this.#recentInputs.length > MAX_INPUTS_PER_MESSAGE) this.#recentInputs.shift();
    this.connection.sendInputs(this.#recentInputs);
    this.predictor.applyInput(seq, controls);
  }

  setNetSim(conditions) {
    this.connection.sendNetSim(conditions);
  }

  // What to draw this frame: [{ entity, alpha, offset? }].
  renderables(now, frameSeconds, stepAlpha) {
    const items = [];
    const isOwn = (data) => data.owner === this.playerId && !data.bot && (data.kind === "ship" || data.kind === "bullet");
    const context = { players: this.players };

    if (this.interpolation) {
      const sample = this.buffer.sample(now);
      if (sample) {
        const before = new Map(sample.before.entities.map((e) => [e.id, e]));
        const after = new Set();
        for (const data of sample.after.entities) {
          after.add(data.id);
          if (this.prediction && isOwn(data)) continue;
          const lerped = interpolateEntity(before.get(data.id), data, sample.alpha, this.arena);
          items.push({ entity: entityFromSnapshot(lerped, context), alpha: 1 });
        }
        // Gone in the newer snapshot: keep drawing it until we get there.
        if (sample.alpha < 1)
          for (const data of sample.before.entities)
            if (!after.has(data.id) && !(this.prediction && isOwn(data)))
              items.push({ entity: entityFromSnapshot(data, context), alpha: 1 });
      }
    } else if (this.latestState) {
      for (const data of this.latestState.entities)
        if (!(this.prediction && isOwn(data))) items.push({ entity: entityFromSnapshot(data, context), alpha: 1 });
    }

    if (this.prediction && this.predictor) {
      this.predictor.smooth(frameSeconds);
      for (const entity of this.predictor.entities()) {
        const offset = entity === this.predictor.ship ? this.predictor.offset : null;
        items.push({ entity, alpha: stepAlpha, offset });
      }
    }
    // Prediction off: the own ship took the remote path above, so it moves
    // only when snapshots say so, a full round trip after the key press.
    return items;
  }

  // HUD data: own ship (predicted when possible) and the bot.
  hudState() {
    const own = this.prediction ? this.predictor?.ship : null;
    const ownData = this.#ownShipData(this.latestState);
    const botData = this.latestState?.entities.find((e) => e.kind === "ship" && e.bot);
    const context = { players: this.players };
    return {
      player: own ?? (ownData ? entityFromSnapshot(ownData, context) : null),
      bot: botData ? entityFromSnapshot(botData, context) : null,
    };
  }

  // Netgraph numbers, refreshed once per second for the rates.
  sampleStats(now) {
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
      codec: this.connection.codec,
      snapshotAge: latest ? now - latest.receivedAt : null,
      pendingInputs: this.predictor?.pendingCount ?? 0,
      interpolationDelayMs: this.buffer.interpolationDelayMs,
      renderTicksBehind: latest ? latest.state.tick - this.buffer.renderTick : 0,
      prediction: this.prediction,
      interpolation: this.interpolation,
    };
  }

  dispose() {
    clearInterval(this.#pingTimer);
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
  }
}
