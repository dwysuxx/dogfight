import { drawGameHud } from "./draw.js";

export function createGameHud(element, world, { player, bot }) {
  let paused = false;
  const render = () => drawGameHud(element, { player, bot, paused });
  const controller = new AbortController();
  const onScore = () => render();

  world.addEventListener("scoreChanged", onScore, { signal: controller.signal });
  world.addEventListener("respawned", render, { signal: controller.signal });
  render();

  return {
    render(nextPaused) {
      paused = nextPaused;
      render();
    },
    dispose() {
      controller.abort();
    },
  };
}
