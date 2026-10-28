import { assertNever } from "@dogfight/shared/protocol.ts";
import type { Asteroid } from "@dogfight/shared/sim/asteroid.ts";
import type { Bullet } from "@dogfight/shared/sim/bullet.ts";
import type { Explosion } from "@dogfight/shared/sim/explosion.ts";
import { TAU, lerp, lerpAngle } from "@dogfight/shared/sim/math.ts";
import { EFFECTS, type Pickup } from "@dogfight/shared/sim/pickup.ts";
import { Ship } from "@dogfight/shared/sim/ship.ts";
import type { GameEntity } from "@dogfight/shared/sim/world.ts";
import type { Assets } from "../assets/loader.ts";

type Ctx = CanvasRenderingContext2D;

// Every entity is drawn at lerp(previous, current, alpha) — the Lab 1
// interpolation, now applied to all of them (angle via the shortest path).
export function drawEntity(ctx: Ctx, e: GameEntity, alpha: number, assets: Assets | null): void {
  if (e.kind === "explosion") return drawExplosion(ctx, e, alpha);

  const x = lerp(e.prevPos.x, e.pos.x, alpha);
  const y = lerp(e.prevPos.y, e.pos.y, alpha);
  const angle = lerpAngle(e.prevAngle, e.angle, alpha);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const frameName = e.kind === "ship" ? (e.isBot ? "botShip" : "playerShip") : e.kind;
  const frame = assets?.frames[frameName];
  if (assets?.spritesheet && frame) {
    const size = e.kind === "ship" ? 34 : e.kind === "asteroid" ? e.radius * 2.2 : e.radius * 2.8;
    ctx.drawImage(assets.spritesheet, ...frame, -size / 2, -size / 2, size, size);
    if (e.kind === "ship") drawShield(ctx, e);
  } else {
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
      default:
        assertNever(e, "entity kind");
    }
  }
  if (e.kind === "ship") drawShipName(ctx, e, angle);
  ctx.restore();
}

function drawShipName(ctx: Ctx, ship: Ship, interpolatedAngle: number): void {
  ctx.save();
  ctx.rotate(-interpolatedAngle);
  ctx.fillStyle = ship.color;
  ctx.font = "12px monospace";
  ctx.textAlign = "center";
  ctx.fillText(ship.name, 0, -22);
  ctx.restore();
}

function drawShip(ctx: Ctx, ship: Ship): void {
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
  drawShield(ctx, ship);
}

function drawShield(ctx: Ctx, ship: Ship): void {
  const shield = ship.effects.get("shield");
  if (shield !== undefined && (shield > 1.5 || Math.floor(performance.now() / 120) % 2 === 0)) {
    ctx.beginPath();
    ctx.arc(0, 0, ship.radius + 6, 0, TAU);
    ctx.strokeStyle = EFFECTS.shield.color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawBullet(ctx: Ctx, bullet: Bullet): void {
  const homing = bullet.behaviors.length > 0;
  ctx.beginPath();
  ctx.arc(0, 0, homing ? 4 : 3, 0, TAU);
  ctx.fillStyle = homing ? EFFECTS.homing.color : "#fff7b0";
  ctx.fill();
}

function drawAsteroid(ctx: Ctx, a: Asteroid): void {
  const n = a.shape.length;
  ctx.beginPath();
  a.shape.forEach((scale, i) => {
    const r = a.radius * scale;
    const px = Math.cos((i / n) * TAU) * r;
    const py = Math.sin((i / n) * TAU) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  const damaged = 1 - a.hp / a.maxHp;
  ctx.fillStyle = `rgba(${90 + damaged * 60}, ${80 - damaged * 30}, ${70 - damaged * 30}, 0.55)`;
  ctx.fill();
  // hunters (asteroids with the homing behavior) get a red outline
  ctx.strokeStyle = a.behaviors.length > 0 ? "#ff5a5a" : "#b9a88e";
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawPickup(ctx: Ctx, p: Pickup): void {
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

function drawExplosion(ctx: Ctx, e: Explosion, _alpha: number): void {
  ctx.save();
  ctx.fillStyle = e.color;
  for (let i = 0; i < e.particleCount; i++) {
    const life = e.particleLife(i);
    if (life <= 0) continue;
    ctx.globalAlpha = life;
    ctx.fillRect(e.particleX(i) - 1.5, e.particleY(i) - 1.5, 3, 3);
  }
  ctx.restore();
}

export function drawGrid(ctx: Ctx, width: number, height: number, spacing = 48): void {
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

export function drawGameHud(el: HTMLElement, { player, bot }: { player: Ship; bot: Ship | null }): void {
  const lines = [`HP ${player.hp}/${Ship.MAX_HP}   Score ${player.score}`];
  if (!player.alive) lines.push("destroyed - respawning...");
  for (const [name, left] of player.effects) lines.push(`${name} ${left.toFixed(1)}s`);
  if (bot) lines.push(`BOT  HP ${bot.hp}   Score ${bot.score}`);
  el.textContent = lines.join("\n");
}
