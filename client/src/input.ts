import type { Controls } from "@dogfight/shared/protocol.ts";

export interface Input {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  update(): void; // call once per simulation step, after all justPressed() checks
  dispose(): void;
}

// Input as a closure over private state. Nothing outside this module can reach
// `down` or `justPressedSet`; the returned object is the whole API.
export function createInput(target: Window): Input {
  const down = new Set<string>();
  const justPressedSet = new Set<string>();
  const controller = new AbortController();
  const options = { signal: controller.signal };

  target.addEventListener(
    "keydown",
    (event) => {
      if (event.target instanceof HTMLInputElement) return; // typing in chat / the lobby
      if (event.code === "Space" || event.code.startsWith("Arrow")) event.preventDefault();
      if (!down.has(event.code)) justPressedSet.add(event.code); // rising edge only
      down.add(event.code);
    },
    options,
  );
  target.addEventListener("keyup", (event) => down.delete(event.code), options);
  target.addEventListener(
    "blur",
    () => {
      down.clear();
      justPressedSet.clear();
    },
    options,
  );

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => justPressedSet.has(code),
    update: () => justPressedSet.clear(),
    dispose: () => controller.abort(),
  };
}

// Keyboard -> abstract controls, the only shape the simulation understands.
export function readControls(input: Input): Controls {
  return {
    left: input.isDown("ArrowLeft") || input.isDown("KeyA"),
    right: input.isDown("ArrowRight") || input.isDown("KeyD"),
    thrust: input.isDown("ArrowUp") || input.isDown("KeyW"),
    fire: input.isDown("Space"),
  };
}
