// The determinism probe from the lab: run the whole simulation for N steps on
// a scripted input sequence and hash the final state. Node (the test) and
// every browser (window.dogfightDeterminism() in the console) must print the
// same hash. Any Math.random(), Date.now() or order-dependent iteration in the
// sim shows up here as a different hash.
import { botControls } from "./ai.js";
import { createGame } from "./game.js";
import { hashWorld } from "./snapshot.js";

export const SCENARIO_DT = 1 / 30;

export function scriptedControls(step) {
  return {
    left: step % 120 < 30,
    right: step % 300 > 250,
    thrust: step % 200 < 140,
    fire: step % 9 === 0,
  };
}

export function runDeterminismScenario({ seed = 7, steps = 1000 } = {}) {
  const { world, player, bot } = createGame({ seed, assignIds: true });
  for (let step = 0; step < steps; step++) {
    world.step(
      SCENARIO_DT,
      new Map([
        [player.id, { ...scriptedControls(step), seq: step + 1 }],
        [bot.id, botControls(world, bot)],
      ]),
    );
  }
  return { hash: hashWorld(world), tick: world.tick, entities: world.size };
}
