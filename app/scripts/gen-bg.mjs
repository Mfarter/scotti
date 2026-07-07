// gen-bg.mjs — renders the dithered vaporwave-mountain background the app floats on.
//
// Zero dependencies (successor to gen-sky.mjs): it composes a pastel gradient sky
// (paper→pink→peach) with a low sun disc, receding mountain ridgelines that haze
// toward the sky as they recede (atmospheric perspective), and a thin perspective
// horizon grid — all rendered as REAL pixels with ordered (Bayer 8x8) dithering,
// then written to a valid PNG by hand (raw RGB scanlines → zlib → PNG chunks with a
// hand-rolled CRC32). Node's built-in zlib is the only import.
//
// Shown with `image-rendering: pixelated` so the ordered grain stays crisp when the
// browser scales it to fill the viewport.
//
// Usage:
//   node scripts/gen-bg.mjs --tint=pink  --out=public/bg-pink.png
//   node scripts/gen-bg.mjs --tint=peach --out=public/bg-peach.png
//   node scripts/gen-bg.mjs --tint=paper --out=public/bg-paper.png
// Knobs: --pink=#e9c3dc --peach=#f8d8c6 --paper=#fdfcfa --ink=#3a2733
//        --w=800 --h=1000 --scale=2 --levels=6 --seed=1337 --tint=pink|peach|paper
//        --ridges=5 --horizon=0.6 --sun=1 --grid=1

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
const INK   = hex(args.ink   ?? "#3a2733");
const INK2  = hex(args.ink2  ?? "#856070");
const WHITE = [255, 255, 255];
const SCALE = Number(args.scale ?? 2);
const W = Math.round(Number(args.w ?? 800) * SCALE);
const H = Math.round(Number(args.h ?? 1000) * SCALE);
const LEVELS = Number(args.levels ?? 8);
const SEED = Number(args.seed ?? 1337);
const TINT = String(args.tint ?? "pink");            // pink | peach | paper
const NRIDGE = Number(args.ridges ?? 5);
const HORIZON = Number(args.horizon ?? 0.6);
const SUN = args.sun === undefined ? true : args.sun !== "0";
const GRID = args.grid === undefined ? true : args.grid !== "0";
const OUT = resolve(process.cwd(), String(args.out ?? `public/bg-${TINT}.png`));

function hex(s) { const h = s.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function smooth(t) { return t * t * (3 - 2 * t); }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function mix(cols, ws) { const s = ws.reduce((a, b) => a + b, 0) || 1; return [0, 1, 2].map((k) => cols.reduce((a, c, i) => a + c[k] * ws[i], 0) / s); }

// ---- deterministic value noise (hash fbm) ----
function hash2(ix, iy) {
  let h = (ix * 374761393 + iy * 668265263 + SEED * 362437) | 0;
  h = (h ^ (h >>> 13)) * 1274126177; h = h ^ (h >>> 16);
  return ((h >>> 0) % 100000) / 100000;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}
function fbm1(x, o0) {           // 1-D ridge profile (sample noise along a fixed row)
  let v = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 5; o++) { v += amp * vnoise(x * freq + o0, o0 * 3.1 + o * 17.7); freq *= 2; amp *= 0.5; }
  return v;
}

// ---- Bayer 8x8 ordered dither ----
const BAYER8 = [[0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],[12,44,4,36,14,46,6,38],
  [60,28,52,20,62,30,54,22],[3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
  [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]].map((r) => r.map((v) => v / 64));
function ditherChannel(v, mask) {
  const vn = (v / 255) * (LEVELS - 1);
  const qi = Math.min(LEVELS - 1, Math.max(0, Math.round(vn + (mask - 0.5))));
  return Math.round((qi * 255) / (LEVELS - 1));
}

// ---- tint leans (within the locked palette — no cool tone exists) ----
// A tint biases both the sky mid-stop and the mountain body toward pink / peach,
// or desaturates toward paper for the neutral cut.
// haze = far ridges take on the sky's own tint (atmospheric perspective) so they
// stay pastel, not gray; deep = the near ridge body; ground = the grid plane.
const TINTS = {
  pink:  { skyMid: mix([PINK, PEACH], [3, 1]),  deep: lerp3(PINK, INK, 0.36),  haze: lerp3(mix([PINK, PEACH], [3, 1]), PAPER, 0.42), ground: lerp3(PINK, INK, 0.30) },
  peach: { skyMid: mix([PEACH, PINK], [3, 1]),  deep: lerp3(PEACH, INK, 0.34), haze: lerp3(mix([PEACH, PINK], [3, 1]), PAPER, 0.42), ground: lerp3(mix([PEACH, PINK], [2, 1]), INK, 0.24) },
  paper: { skyMid: mix([PINK, PEACH, PAPER], [1, 1, 2]), deep: lerp3(mix([PINK, PEACH], [1, 1]), INK, 0.26), haze: lerp3(mix([PINK, PEACH], [1, 1]), PAPER, 0.6), ground: lerp3(mix([PINK, PEACH], [1, 1]), INK, 0.18) },
}[TINT] ?? null;
if (!TINTS) { console.error(`unknown --tint=${TINT} (pink|peach|paper)`); process.exit(1); }

const horizonY = Math.round(H * HORIZON);
function skyColor(ny) {
  // paper (top) → tinted mid → peach at the horizon
  return ny < 0.55 ? lerp3(PAPER, TINTS.skyMid, smooth(ny / 0.55))
    : lerp3(TINTS.skyMid, PEACH, smooth((ny - 0.55) / 0.45));
}

// ---- precompute ridge crest lines (screen y per column, per layer) ----
const ridgeTop = [];   // ridgeTop[i][x] = crest y (px); nearer layers have larger i
for (let i = 0; i < NRIDGE; i++) {
  const t = NRIDGE === 1 ? 1 : i / (NRIDGE - 1);
  const crestBase = lerp(0.30, 0.585, t) * H;      // far ridges sit high, near ridges low
  const amp = lerp(0.09, 0.14, t) * H;             // near ridges more jagged
  const freq = lerp(1.4, 3.0, t);
  const row = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const p = fbm1((x / W) * freq, i * 11.3);      // [0,1]-ish
    row[x] = crestBase - amp * (p - 0.28);         // peaks rise (smaller y)
  }
  ridgeTop.push(row);
}

// ---- render ----
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const rowOff = y * (1 + W * 3);
  raw[rowOff] = 0;
  const ny = y / (H - 1);
  for (let x = 0; x < W; x++) {
    const nx = x / W;
    let col;

    // frontmost ridge whose crest is at/above this pixel (only above the horizon)
    let ridge = -1;
    if (y < horizonY) { for (let i = NRIDGE - 1; i >= 0; i--) { if (y >= ridgeTop[i][x]) { ridge = i; break; } } }

    if (ridge >= 0) {
      const t = NRIDGE === 1 ? 1 : ridge / (NRIDGE - 1);
      // atmospheric perspective: far ridge ≈ haze (near sky), near ridge ≈ deep plum
      let fill = lerp3(TINTS.haze, TINTS.deep, t);
      // vertical shading within the ridge body (a touch darker toward its base)
      const depth = clamp01((y - ridgeTop[ridge][x]) / (horizonY - ridgeTop[ridge][x] + 1));
      fill = lerp3(fill, TINTS.deep, depth * 0.18 * t);
      // crisp ink rim right at the crest for definition (fainter on far ridges)
      const edge = y - ridgeTop[ridge][x];
      if (edge < 2.0 * SCALE) fill = lerp3(fill, INK, lerp(0.5, 0.12, t));
      col = fill;
    } else if (y >= horizonY) {
      // ground: darker tinted plane + a thin receding perspective grid
      let g = lerp3(TINTS.ground, INK, clamp01((ny - HORIZON) / (1 - HORIZON)) * 0.22);
      if (GRID) {
        const gy = (y - horizonY) / (H - horizonY);         // 0 at horizon → 1 at bottom
        // horizontal lines bunched near the horizon
        const rows = 14;
        const line = Math.abs(Math.sin(Math.sqrt(gy) * rows * Math.PI));
        const hLine = smooth(clamp01(1 - line * 8));
        // vertical lines fanning from the vanishing point (0.5 W, horizon)
        const persp = gy < 0.001 ? 0 : (nx - 0.5) / (gy * 0.9 + 0.02);
        const vv = Math.abs(Math.sin(persp * 9 * Math.PI));
        const vLine = smooth(clamp01(1 - vv * 6)) * clamp01(gy * 3);
        const grid = Math.max(hLine, vLine) * lerp(0.5, 0.0, gy);  // fade out toward bottom
        g = lerp3(g, mix([INK2, PAPER], [1, 1]), grid * 0.5);
      }
      col = g;
    } else {
      // open sky (behind the ridges): gradient + optional sun disc/glow
      col = skyColor(ny);
      if (SUN) {
        const sx = 0.5, sy = HORIZON - 0.30;               // rides high enough to peek above the far crest
        const dx = (nx - sx) * (W / H), dy = ny - sy;      // aspect-correct
        const dist = Math.sqrt(dx * dx + dy * dy);
        const r = 0.135;
        const disc = smooth(clamp01((r - dist) / 0.04));   // solid core
        const glow = smooth(clamp01((r * 2.6 - dist) / (r * 2.6))) * 0.55;
        const sunCore = lerp3(PEACH, WHITE, 0.68);
        // retro horizontal sun slits in the lower half of the disc
        const slit = (dy > 0.005 && Math.abs(Math.sin(ny * 80)) < 0.4) ? 0.4 : 1;
        col = lerp3(col, sunCore, glow);
        col = lerp3(col, sunCore, disc * slit);
      }
    }

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
ihdr[8] = 8; ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`bg(${TINT}) → ${OUT}  ${W}×${H}px  ${(png.length / 1024).toFixed(0)}KB  ridges=${NRIDGE} sun=${SUN} grid=${GRID}`);
