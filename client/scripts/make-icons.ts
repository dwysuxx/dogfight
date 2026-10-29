// Renders the PWA icons (a ship on the arena background) as PNG files with
// no image library: supersampled point-in-polygon, then zlib + CRC32 from Node.
// Run: node client/scripts/make-icons.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

type Point = readonly [number, number];
type Rgb = readonly [number, number, number];

const BG: Rgb = [5, 6, 10];
const SHIP: Rgb = [255, 216, 74];
const FLAME: Rgb = [109, 224, 223];

// Shapes in a unit square, nose up; `scale` shrinks them toward the centre
// (maskable icons keep everything inside the 80 % safe zone).
const SHIP_SHAPE: Point[] = [
  [0.5, 0.14],
  [0.78, 0.8],
  [0.5, 0.66],
  [0.22, 0.8],
];
const FLAME_SHAPE: Point[] = [
  [0.42, 0.72],
  [0.5, 0.92],
  [0.58, 0.72],
  [0.5, 0.68],
];

function inside([x, y]: Point, polygon: readonly Point[]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i] ?? [0, 0];
    const [xj, yj] = polygon[j] ?? [0, 0];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function render(size: number, scale: number): Buffer {
  const SAMPLES = 4;
  const transform = (polygon: readonly Point[]) =>
    polygon.map(([x, y]): Point => [0.5 + (x - 0.5) * scale, 0.5 + (y - 0.5) * scale]);
  const ship = transform(SHIP_SHAPE);
  const flame = transform(FLAME_SHAPE);
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB
    for (let px = 0; px < size; px++) {
      const colour = [0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const point: Point = [(px + (sx + 0.5) / SAMPLES) / size, (py + (sy + 0.5) / SAMPLES) / size];
          const rgb = inside(point, ship) ? SHIP : inside(point, flame) ? FLAME : BG;
          for (let c = 0; c < 3; c++) colour[c] = (colour[c] ?? 0) + (rgb[c] ?? 0);
        }
      }
      for (let c = 0; c < 3; c++) row[1 + px * 3 + c] = Math.round((colour[c] ?? 0) / (SAMPLES * SAMPLES));
    }
    rows.push(row);
  }
  return png(size, Buffer.concat(rows));
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = new URL("../public/icons/", import.meta.url);
mkdirSync(out, { recursive: true });
writeFileSync(new URL("icon-192.png", out), render(192, 1));
writeFileSync(new URL("icon-512.png", out), render(512, 1));
writeFileSync(new URL("maskable-512.png", out), render(512, 0.72));
writeFileSync(new URL("apple-touch-icon.png", out), render(180, 0.9));
console.log("icons written to", out.pathname);
