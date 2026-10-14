// The collision SYSTEM: takes the world, emits (a, b) pairs. It knows nothing
// about damage or scoring (that is rules.js), so it can be swapped for a
// spatial hash later — World only needs "a function world -> iterable of pairs".
// Naive O(n^2); Lab 7 measures it.
export function* findCollisions(world) {
  const bodies = [];
  for (const e of world) if (e.alive && e.collides) bodies.push(e);

  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      const dx = a.pos.x - b.pos.x;
      const dy = a.pos.y - b.pos.y;
      const r = a.radius + b.radius;
      if (dx * dx + dy * dy <= r * r) yield [a, b];
    }
  }
}
