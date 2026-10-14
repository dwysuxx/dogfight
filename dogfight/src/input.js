export function createInput(target) {
  const down = new Set();
  const justPressedSet = new Set();

  target.addEventListener("keydown", (event) => {
    if (!down.has(event.code)) {
      justPressedSet.add(event.code); // only on the rising edge
    }
    down.add(event.code);
  });

  target.addEventListener("keyup", (event) => {
    down.delete(event.code);
  });

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => justPressedSet.has(code),
    update: () => justPressedSet.clear(),
  };
}
