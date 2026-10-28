// Seeded PRNG (mulberry32). The simulation never calls Math.random(), so the
// same seed + the same inputs always produce the same game — the property
// the shared server-authoritative simulation depends on.
export interface Rng {
  (): number; // [0, 1)
  range(lo: number, hi: number): number;
  pick<T>(list: readonly T[]): T;
}

export function createRng(seed = 1): Rng {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.assign(next, {
    range: (lo: number, hi: number) => lo + (hi - lo) * next(),
    pick<T>(list: readonly T[]): T {
      const item = list[Math.floor(next() * list.length)];
      if (item === undefined) throw new RangeError("Cannot pick from an empty list");
      return item;
    },
  });
}
