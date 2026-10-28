// A read-only window into the running game for end-to-end tests (and the
// DevTools console): who am I, and where is every ship in the latest snapshot.
import type { GameSession } from "./net/session.ts";

export interface DebugShip {
  owner: number;
  name: string;
  x: number;
  y: number;
}

export interface DebugState {
  playerId: number | null;
  tick: number;
  ships: DebugShip[];
}

declare global {
  interface Window {
    dogfight?: { state(): DebugState | null };
  }
}

export function exposeDebug(current: () => GameSession | null): void {
  window.dogfight = {
    state() {
      const session = current();
      const latest = session?.latestState;
      if (!session || !latest) return null;
      const ships: DebugShip[] = [];
      for (const entity of latest.entities) {
        if (entity.kind !== "ship") continue;
        const name = entity.bot ? "bot" : (session.players.get(entity.owner)?.name ?? "?");
        ships.push({ owner: entity.owner, name, x: entity.x, y: entity.y });
      }
      return { playerId: session.playerId, tick: latest.tick, ships };
    },
  };
}
