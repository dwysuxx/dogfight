import { createLoop } from "./loop.js";
import { createInput } from "./input.js";
import { createShip, cloneShip, integrate } from "./sim/ship.js";
import { wrapPosition } from "./sim/arena.js";
import { setupCanvas } from "./render/canvas.js";
import { drawShip, drawGrid, drawHud, interpolateShip } from "./render/draw.js";

const canvas = document.getElementById("game");
const hud = document.getElementById("hud");
const { ctx, getSize } = setupCanvas(canvas);
const input = createInput(window);

let current = createShip(window.innerWidth / 2, window.innerHeight / 2);
let previous = cloneShip(current);

const loop = createLoop({
  step: 1 / 60,
  simulate(dt) {
    previous = cloneShip(current);
    integrate(current, input, dt);
    const { width, height } = getSize();
    wrapPosition(current, width, height);
    input.update(); // clear justPressed edges once this step has consumed them
  },
  render(alpha) {
    const { width, height } = getSize();
    ctx.clearRect(0, 0, width, height);
    drawGrid(ctx, width, height);
    const drawnShip = interpolateShip(previous, current, alpha);
    drawShip(ctx, drawnShip);
  },
  onStats(stats) {
    drawHud(hud, stats);
  },
});

loop.start();
