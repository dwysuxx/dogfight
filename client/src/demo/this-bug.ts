// A runnable demonstration of the `this` bug (Section 2 of the notes).
//   Node:     node src/demo/this-bug.ts
//   Browser:  await import("./src/demo/this-bug.ts")   (in the DevTools console with Vite)
// TypeScript does not catch it either: `const fire = ship.fire` is a legal
// (Ship) => Bullet | null value; the `this` it needs is not part of its type.
import { Ship } from "@dogfight/shared/sim/ship.ts";
import { Vector2 } from "@dogfight/shared/sim/vector.ts";
import { World } from "@dogfight/shared/sim/world.ts";

function freshShip(): Ship {
  const world = new World();
  return world.spawn(new Ship({ pos: new Vector2(100, 100) }));
}

const count = (ship: Ship) => ship.world?.countKind("bullet") ?? 0;
const flush = (ship: Ship) => ship.world?.step(1 / 60); // spawned bullets appear after a step

// --- 1. The bug, version A: a detached call. `this` is undefined (strict mode).
{
  const ship = freshShip();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the bug this demo reproduces on purpose
  const fire = ship.fire; // passed the function, not the call
  try {
    fire();
  } catch (error: unknown) {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    console.log("1. detached call ->", `${name}:`, error instanceof Error ? error.message : error);
  }
}

// --- 2. The bug, version B: as an event listener. `this` = the event target.
{
  const ship = freshShip();
  const button = new EventTarget();
  // eslint-disable-next-line @typescript-eslint/unbound-method -- the bug this demo reproduces on purpose
  button.addEventListener("click", ship.fire); // BUG: passes the function
  button.dispatchEvent(new Event("click"));
  flush(ship);
  console.log(
    "2. addEventListener(ship.fire) -> bullets:",
    count(ship),
    "(silently nothing happened)",
  );
}

// --- 3. Fix #1: an arrow wrapper. Cheap, explicit, easy to add arguments.
{
  const ship = freshShip();
  const button = new EventTarget();
  button.addEventListener("click", () => ship.fire());
  button.dispatchEvent(new Event("click"));
  flush(ship);
  console.log("3. arrow wrapper         -> bullets:", count(ship));
}

// --- 4. Fix #2: bind. One bound function; cannot be rebound, but you cannot
// removeEventListener it unless you keep a reference to the bound function.
{
  const ship = freshShip();
  const button = new EventTarget();
  button.addEventListener("click", ship.fire.bind(ship));
  button.dispatchEvent(new Event("click"));
  flush(ship);
  console.log("4. fire.bind(ship)       -> bullets:", count(ship));
}

// --- 5. Fix #3: an arrow function as a class field. Always bound, but each
// instance gets its own closure (memory), and it is not on the prototype.
{
  class Turret {
    shots = 0;
    fire = () => {
      this.shots++; // `this` is lexical: always the Turret
    };
  }
  const turret = new Turret();
  const button = new EventTarget();
  button.addEventListener("click", turret.fire); // safe to pass directly
  button.dispatchEvent(new Event("click"));
  console.log("5. arrow class field     -> shots:", turret.shots);
  console.log(
    "   own property (per instance)?",
    Object.hasOwn(turret, "fire"),
    "| on the prototype?",
    Object.hasOwn(Turret.prototype, "fire"),
  );
}
