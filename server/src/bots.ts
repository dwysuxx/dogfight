import { type Seq, seq } from "@dogfight/shared/brand.ts";
import type { Controls, InputFrame } from "@dogfight/shared/protocol.ts";
import { wrapAngle } from "@dogfight/shared/sim/math.ts";
import { type Rng, createRng } from "@dogfight/shared/sim/rng.ts";
import type { Ship } from "@dogfight/shared/sim/ship.ts";
import type { World } from "@dogfight/shared/sim/world.ts";

// Anything that drives a ship. A network client produces its InputFrames
// from the keyboard; a Bot from the world state. Both end up in the same
// Match.receiveInputs, so the server cannot tell them apart.
export interface PlayerInput {
  readonly id: string;
  readonly name: string;
}

const EVADE_DISTANCE = 110; // px ahead of the nose that counts as "about to hit"
const FIRE_RANGE = 460;

export class Bot implements PlayerInput {
  readonly id: string;
  readonly name: string;
  readonly #rng: Rng;
  #seq = 0;
  #aimError = 0;

  constructor(id: string, name: string, seed: number) {
    this.id = id;
    this.name = name;
    this.#rng = createRng(seed);
  }

  // One input per tick, numbered like a client's.
  next(world: World, self: Ship | undefined): InputFrame {
    const next: Seq = seq(++this.#seq);
    return { seq: next, controls: self?.alive ? this.#think(world, self) : IDLE };
  }

  #think(world: World, self: Ship): Controls {
    // Evade: an asteroid close ahead wins over everything else.
    const all = world.all;
    for (let i = 0; i < all.length; i++) {
      const rock = all[i];
      if (rock?.kind !== "asteroid") continue;
      const dx = rock.pos.x - self.pos.x;
      const dy = rock.pos.y - self.pos.y;
      const distance = Math.hypot(dx, dy) - rock.radius - self.radius;
      if (distance > EVADE_DISTANCE) continue;
      const bearing = wrapAngle(Math.atan2(dy, dx) - self.angle);
      if (Math.abs(bearing) < 0.9) return { left: bearing > 0, right: bearing <= 0, thrust: true, fire: false };
    }

    // Chase the nearest other ship (human, bot or the house bot).
    let target: Ship | null = null;
    let best = Infinity;
    for (let i = 0; i < all.length; i++) {
      const ship = all[i];
      if (ship?.kind !== "ship" || ship === self || !ship.alive) continue;
      const d = ship.pos.distanceTo(self.pos);
      if (d < best) {
        best = d;
        target = ship;
      }
    }
    if (!target) return { left: false, right: true, thrust: this.#rng() < 0.3, fire: false };

    // A little aim error, re-rolled now and then, so bots are not perfect.
    if (this.#seq % 45 === 0) this.#aimError = this.#rng.range(-0.12, 0.12);
    const desired = Math.atan2(target.pos.y - self.pos.y, target.pos.x - self.pos.x) + this.#aimError;
    const diff = wrapAngle(desired - self.angle);
    return {
      left: diff < -0.06,
      right: diff > 0.06,
      thrust: best > 220 && Math.abs(diff) < 0.7,
      fire: Math.abs(diff) < 0.15 && best < FIRE_RANGE,
    };
  }
}

const IDLE: Controls = { left: false, right: false, thrust: false, fire: false };
