// The determinism probe from the lab: run the whole simulation for N steps on
// a scripted input sequence and hash the final state. Node (the test) and
// every browser (window.dogfightDeterminism() in the console) must print the
// same hash. Any Math.random(), Date.now() or order-dependent iteration in the
// sim shows up here as a different hash.
import { seq } from "../brand.ts";
import type { Controls } from "../protocol.ts";
import { botControls } from "./ai.ts";
import type { StepControls } from "./entity.ts";
import { createGame } from "./game.ts";
import { hashWorld } from "./snapshot.ts";
import type { StepInputs } from "./world.ts";

export const SCENARIO_DT = 1 / 30;

export function scriptedControls(step: number): Controls {
  return {
    left: step % 120 < 30,
    right: step % 300 > 250,
    thrust: step % 200 < 140,
    fire: step % 9 === 0,
  };
}

export function runDeterminismScenario({ seed = 7, steps = 1000 }: { seed?: number; steps?: number } = {}): {
  hash: string;
  tick: number;
  entities: number;
} {
  const { world, player, bot } = createGame({ seed, assignIds: true });
  if (!player || !bot) throw new Error("The scenario needs a player and a bot");
  for (let step = 0; step < steps; step++) {
    const inputs: StepInputs = new Map<typeof player.id, StepControls>([
      [player.id, { ...scriptedControls(step), seq: seq(step + 1) }],
      [bot.id, botControls(world, bot)],
    ]);
    world.step(SCENARIO_DT, inputs);
  }
  return { hash: hashWorld(world), tick: world.tick, entities: world.size };
}
