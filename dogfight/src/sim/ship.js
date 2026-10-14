const MAX_SPEED = 320; // px/s
const THRUST_ACCEL = 260; // px/s^2
const ROTATE_SPEED = Math.PI * 1.6; // rad/s
const DRAG = 0.62; // fraction of velocity bled off per second

export function createShip(x, y) {
  return { x, y, vx: 0, vy: 0, angle: -Math.PI / 2, thrust: false };
}

export function cloneShip(ship) {
  return { ...ship };
}

export function integrate(ship, input, dt) {
  const rotateLeft = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const rotateRight = input.isDown("ArrowRight") || input.isDown("KeyD");
  const thrusting = input.isDown("ArrowUp") || input.isDown("KeyW");

  if (rotateLeft) ship.angle -= ROTATE_SPEED * dt;
  if (rotateRight) ship.angle += ROTATE_SPEED * dt;

  ship.thrust = thrusting;
  if (thrusting) {
    ship.vx += Math.cos(ship.angle) * THRUST_ACCEL * dt;
    ship.vy += Math.sin(ship.angle) * THRUST_ACCEL * dt;
  }

  const dragFactor = Math.max(0, 1 - DRAG * dt);
  ship.vx *= dragFactor;
  ship.vy *= dragFactor;

  const speed = Math.hypot(ship.vx, ship.vy);
  if (speed > MAX_SPEED) {
    const scale = MAX_SPEED / speed;
    ship.vx *= scale;
    ship.vy *= scale;
  }

  ship.x += ship.vx * dt;
  ship.y += ship.vy * dt;
}
