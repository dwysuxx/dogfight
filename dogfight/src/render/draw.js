import { TAU, lerp, lerpAngle } from "../sim/math.js";
import { EFFECTS } from "../sim/pickup.js";
import { Ship } from "../sim/ship.js";

// Every entity is drawn at lerp(previous, current, alpha) — the Lab 1
// interpolation, now applied to all of them (angle via the shortest path).
export function drawEntity(ctx, e, alpha) {
  if (e.kind === "explosion") return drawExplosion(ctx, e);

  const x = lerp(e.prevPos.x, e.pos.x, alpha);
  const y = lerp(e.prevPos.y, e.pos.y, alpha);
  const angle = lerpAngle(e.prevAngle, e.angle, alpha);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  switch (e.kind) {
    case "ship":
      drawShip(ctx, e);
      break;
    case "bullet":
      drawBullet(ctx, e);
      break;
    case "asteroid":
      drawAsteroid(ctx, e);
      break;
    case "pickup":
      drawPickup(ctx, e);
      break;
  }
  ctx.restore();
}

function drawShip(ctx, ship) {
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 8);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, -8);
  ctx.closePath();
  ctx.fillStyle = ship.color;
  ctx.fill();
  ctx.strokeStyle = "#7fb2ff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (ship.thrusting) {
    ctx.beginPath();
    ctx.moveTo(-6, 3);
    ctx.lineTo(-16 - Math.random() * 6, 0);
    ctx.lineTo(-6, -3);
    ctx.closePath();
    ctx.fillStyle = "#ff9c4a";
    ctx.fill();
  }

  const shield = ship.effects.get("shield");
  if (
    shield !== undefined &&
    (shield > 1.5 || Math.floor(performance.now() / 120) % 2 === 0)
  ) {
    ctx.beginPath();
    ctx.arc(0, 0, ship.radius + 6, 0, TAU);
    ctx.strokeStyle = EFFECTS.shield.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawBullet(ctx, bullet) {
  const homing = bullet.behaviors.length > 0;
  ctx.beginPath();
  ctx.arc(0, 0, homing ? 4 : 3, 0, TAU);
  ctx.fillStyle = homing ? EFFECTS.homing.color : "#fff7b0";
  ctx.fill();
}

function drawAsteroid(ctx, a) {
  const n = a.shape.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const r = a.radius * a.shape[i];
    const px = Math.cos((i / n) * TAU) * r;
    const py = Math.sin((i / n) * TAU) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  const damaged = 1 - a.hp / a.maxHp;
  ctx.fillStyle = `rgba(${90 + damaged * 60}, ${80 - damaged * 30}, ${70 - damaged * 30}, 0.55)`;
  ctx.fill();
  // hunters (asteroids with the homing behavior) get a red outline
  ctx.strokeStyle = a.behaviors.length > 0 ? "#ff5a5a" : "#b9a88e";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawPickup(ctx, p) {
  const fx = EFFECTS[p.effect];
  const pulse = 1 + 0.15 * Math.sin(performance.now() / 200);
  ctx.beginPath();
  ctx.arc(0, 0, p.radius * pulse, 0, TAU);
  ctx.strokeStyle = fx.color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = fx.color;
  ctx.font = "bold 12px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(fx.label, 0, 1);
}

function drawExplosion(ctx, e) {
  ctx.save();
  ctx.fillStyle = e.color;
  for (const p of e.particles) {
    if (p.life <= 0) continue;
    ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
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

export function drawGameHud(el, { player, bot, paused }) {
  const lines = [`HP ${player.hp}/${Ship.MAX_HP}   Score ${player.score}`];
  if (!player.alive) lines.push("destroyed - respawning...");
  for (const [name, left] of player.effects) lines.push(`${name} ${left.toFixed(1)}s`);
  if (bot) lines.push(`BOT  HP ${bot.hp}   Score ${bot.score}`);
  if (paused) lines.push("PAUSED (P)");
  el.textContent = lines.join("\n");
}
