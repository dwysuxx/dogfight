function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (diff < -Math.PI) diff += Math.PI * 2;
  return a + diff * t;
}

export function interpolateShip(previous, current, alpha) {
  return {
    x: lerp(previous.x, current.x, alpha),
    y: lerp(previous.y, current.y, alpha),
    angle: lerpAngle(previous.angle, current.angle, alpha),
    thrust: current.thrust,
  };
}

export function drawShip(ctx, ship) {
  ctx.save();
  ctx.translate(ship.x, ship.y);
  ctx.rotate(ship.angle);

  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 8);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, -8);
  ctx.closePath();
  ctx.fillStyle = "#e8f0ff";
  ctx.fill();
  ctx.strokeStyle = "#7fb2ff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (ship.thrust) {
    ctx.beginPath();
    ctx.moveTo(-6, 3);
    ctx.lineTo(-16 - Math.random() * 6, 0);
    ctx.lineTo(-6, -3);
    ctx.closePath();
    ctx.fillStyle = "#ff9c4a";
    ctx.fill();
  }

  ctx.restore();
}

export function drawGrid(ctx, width, height, spacing = 48) {
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

export function drawHud(el, stats) {
  el.textContent =
    `steps/s: ${stats.stepsPerSecond}\n` +
    `frames/s: ${stats.framesPerSecond}\n` +
    `frame time: ${stats.lastFrameDuration.toFixed(2)} ms`;
}
