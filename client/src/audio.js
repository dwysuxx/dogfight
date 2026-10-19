export function createAudio() {
  const AudioContextCtor = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContextCtor) return null;

  const context = new AudioContextCtor();
  let buffers = {};
  const controller = new AbortController();

  function play(name) {
    const buffer = buffers[name];
    if (!buffer || context.state !== "running") return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  }

  return {
    context,
    setBuffers(nextBuffers) {
      buffers = nextBuffers;
    },
    async unlock() {
      if (context.state !== "running") await context.resume();
    },
    connect(world) {
      for (const name of ["fired", "hit", "exploded"])
        world.addEventListener(name, () => play(name), { signal: controller.signal });
    },
    async dispose() {
      controller.abort();
      if (context.state !== "closed") await context.close();
    },
  };
}
