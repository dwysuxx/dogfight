import { Entity } from "./entity.js";
import { World } from "./world.js";
import { Ship } from "./ship.js";
import { Vector2 } from "./vector.js";
import { createSpawner, spawnAsteroid } from "./spawner.js";

// Builds a ready-to-run game: world + player (+ optional bot) + asteroids.
export function createGame({
  width = 960,
  height = 540,
  seed = 1,
  asteroids = 6,
  withBot = true,
} = {}) {
  Entity.resetIds();
  const world = new World({ width, height, seed });

  const player = world.spawn(
    new Ship({
      pos: new Vector2(width / 3, height / 2),
      color: "#e8f0ff",
      name: "player",
    }),
  );
  const bot = withBot
    ? world.spawn(
        new Ship({
          pos: new Vector2((width * 2) / 3, height / 2),
          color: "#ff8a8a",
          name: "bot",
          damage: 10,
        }),
      )
    : null;

  for (let i = 0; i < asteroids; i++) spawnAsteroid(world, { inside: true });
  world.addSystem(createSpawner({ asteroids }));
  return { world, player, bot };
}
