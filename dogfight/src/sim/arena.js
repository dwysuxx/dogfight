export function wrapPosition(ship, width, height, margin = 20) {
  if (ship.x < -margin) ship.x = width + margin;
  else if (ship.x > width + margin) ship.x = -margin;

  if (ship.y < -margin) ship.y = height + margin;
  else if (ship.y > height + margin) ship.y = -margin;
}
