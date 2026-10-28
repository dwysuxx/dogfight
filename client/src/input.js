// Input as a closure over private state. Nothing outside this module can reach
// `down` or `justPressedSet`; the returned object is the whole API.
export function createInput(target) {
  const down = new Set();
  const justPressedSet = new Set();
  const controller = new AbortController();
  const options = { signal: controller.signal };

  target.addEventListener("keydown", (event) => {
    if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
    if (!down.has(event.code)) justPressedSet.add(event.code); // rising edge only
    down.add(event.code);
  }, options);

  target.addEventListener("keyup", (event) => {
    down.delete(event.code);
  }, options);
  target.addEventListener("blur", () => {
    down.clear();
    justPressedSet.clear();
  }, options);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => justPressedSet.has(code),
    // Call once per simulation step, after all justPressed() checks.
    update: () => justPressedSet.clear(),
    dispose: () => controller.abort(),
  };
}

// Keyboard -> abstract controls, the only shape the simulation understands.
export function readControls(input) {
  return {
    left: input.isDown("ArrowLeft") || input.isDown("KeyA"),
    right: input.isDown("ArrowRight") || input.isDown("KeyD"),
    thrust: input.isDown("ArrowUp") || input.isDown("KeyW"),
    fire: input.isDown("Space"),
  };
}
