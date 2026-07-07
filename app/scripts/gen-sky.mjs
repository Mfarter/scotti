// gen-sky.mjs — renders the dithered pastel sky the whole app floats on.
//
// Zero dependencies: it composes a vertical paper→pink→peach gradient with soft
// value-noise cloud forms, applies ordered (Bayer 8x8) dithering to real pixel
// grain, and writes a valid PNG by hand (raw RGB scanlines → zlib → PNG chunks
// with hand-rolled CRC32). Node's built-in zlib is the only import.
//
// Usage:
//   node scripts/gen-sky.mjs                       # defaults → public/sky.png
//   node scripts/gen-sky.mjs --pink=#e9c3dc --peach=#f8d8c6
//   node scripts/gen-sky.mjs --w=800 --h=1000 --scale=2 --out=public/sky.png
//
// The output is intended to be shown with `image-rendering: pixelated` so the
// ordered grain stays crisp when the browser scales it to fill the viewport.

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// ---- args ----
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)=(.*)$/); return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
}));
const PAPER = hex(args.paper ?? "#fdfcfa");
const PINK  = hex(args.pink  ?? "#e9c3dc");
const PEACH = hex(args.peach ?? "#f8d8c6");
const SCALE = Number(args.scale ?? 2);
const W = Math.round(Number(args.w ?? 800) * SCALE);
const H = Math.round(Number(args.h ?? 1000) * SCALE);
const OUT = resolve(process.cwd(), String(args.out ?? "public/sky.png"));
const LEVELS = Number(args.levels ?? 6);      // quantization steps per channel → the grain
const SEED = Number(args.seed ?? 1337);

function hex(s) { const h = s.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function smooth(t) { return t * t * (3 - 2 * t); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// ---- deterministic value noise (hash-based fbm) ----
function hash2(ix, iy) {
  let h = (ix * 374761393 + iy * 668265263 + SEED * 362437) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}
function fbm(x, y) {
  let v = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 5; o++) { v += amp * vnoise(x * freq, y * freq); freq *= 2; amp *= 0.5; }
  return v;
}

// ---- Bayer 8x8 ordered-dither matrix (normalized to [0,1)) ----
const BAYER8 = (() => {
  const base = [[0, 32, 8, 40, 2, 34, 10, 42], [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38], [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41], [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37], [63, 31, 55, 23, 61, 29, 53, 21]];
  return base.map((r) => r.map((v) => v / 64));
})();

function ditherChannel(v, mask) {
  // ordered dithering to LEVELS steps → crisp pastel grain
  const vn = (v / 255) * (LEVELS - 1);
  const qi = Math.min(LEVELS - 1, Math.max(0, Math.round(vn + (mask - 0.5))));
  return Math.round((qi * 255) / (LEVELS - 1));
}

// ---- render ----
const WHITE = [255, 255, 255];

const raw = Buffer.alloc(H * (1 + W * 3));   // filter byte + RGB per scanline
for (let y = 0; y < H; y++) {
  const rowOff = y * (1 + W * 3);
  raw[rowOff] = 0;                            // filter: none
  const ty = y / (H - 1);
  // vertical gradient: a thin paper band up top → pink through the middle → peach
  // toward the horizon. Full palette tones so the sky keeps its colour.
  const grad = ty < 0.5 ? lerp3(PAPER, PINK, smooth(ty / 0.5))
    : lerp3(PINK, PEACH, smooth((ty - 0.5) / 0.5));
  for (let x = 0; x < W; x++) {
    const nx = x / W, ny = y / H;
    // SPARSE soft cloud puffs: high threshold so most of the frame is open sky,
    // gently whitened where a puff sits, thinning toward the horizon.
    let cloud = fbm(nx * 2.2 + 1.5, ny * 2.4 + 0.3) * 0.7 + fbm(nx * 4.6, ny * 4.6) * 0.3;
    const falloff = smooth(clamp01(1.2 - ny * 1.1));
    cloud = clamp01((cloud - 0.6) * 3.0) * falloff;
    const col = lerp3(grad, WHITE, cloud * 0.72);                  // gentle white puff
    const m = BAYER8[y & 7][x & 7];
    const o = rowOff + 1 + x * 3;
    raw[o]     = ditherChannel(col[0], m);
    raw[o + 1] = ditherChannel(col[1], m);
    raw[o + 2] = ditherChannel(col[2], m);
  }
}

// ---- PNG assembly ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td), 0);
  return Buffer.concat([len, td, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit, RGB, deflate, no filter, no interlace
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`sky → ${OUT}  ${W}×${H}px  ${(png.length / 1024).toFixed(0)}KB  (paper ${args.paper ?? "#fdfcfa"} · pink ${args.pink ?? "#e9c3dc"} · peach ${args.peach ?? "#f8d8c6"})`);
