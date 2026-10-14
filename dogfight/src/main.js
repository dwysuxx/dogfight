import { createLoop } from "./loop.js";
import { createInput, readControls } from "./input.js";
import { createGame } from "./sim/game.js";
import { botControls } from "./ai.js";
import { setupCanvas } from "./render/canvas.js";
import { drawEntity, drawGrid, drawHud, drawGameHud } from "./render/draw.js";

const canvas = document.getElementById("game");
const hud = document.getElementById("hud");
const gameHud = document.getElementById("game-hud");
const fireButton = document.getElementById("fire");

const { ctx, getSize } = setupCanvas(canvas);
const input = createInput(window);

// ?seed=42 in the URL replays the same asteroid field (deterministic sim).
const seed = Number(new URLSearchParams(location.search).get("seed")) || 1;
const { width, height } = getSize();
const { world, player, bot } = createGame({ width, height, seed });

// THE `this` BUG (see README, section "Помилка з this"):
//   fireButton.addEventListener("click", player.fire);   // WRONG
// passes the function, not the call. The event system then calls it with
// `this` = the button, so `this.alive`/`this.world` are undefined and fire()
// silently does nothing. Three fixes (trade-offs in the README):
//   1. an arrow wrapper:          () => player.fire()      <- used here
//   2. bind:                      player.fire.bind(player)
//   3. an arrow class field:      fire = () => {...}       (one closure per instance)
fireButton.addEventListener("click", () => {
  player.fire();
  fireButton.blur(); // keep Space from re-clicking the focused button
});

let paused = false;

const loop = createLoop({
  step: 1 / 60,
  simulate(dt) {
    if (input.justPressed("KeyP")) paused = !paused;
    if (!paused) {
      const size = getSize();
      world.resize(size.width, size.height);
      world.step(
        dt,
        new Map([
          [player.id, readControls(input)],
          [bot.id, botControls(world, bot)],
        ]),
      );
    }
    input.update(); // clear justPressed edges once this step has consumed them
  },
  render(alpha) {
    const size = getSize();
    ctx.clearRect(0, 0, size.width, size.height);
    drawGrid(ctx, size.width, size.height);
    const a = paused ? 1 : alpha; // frozen state: don't wobble between prev/current
    for (const entity of world) drawEntity(ctx, entity, a);
    drawGameHud(gameHud, { player, bot, paused });
  },
  onStats(stats) {
    drawHud(hud, stats);
  },
});

loop.start();
