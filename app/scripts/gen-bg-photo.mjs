// gen-bg-photo.mjs — the dithered PHOTOGRAPHIC background (UI-5), replacing the
// procedural mountains of gen-bg.mjs with Michelangelo's The Last Judgment.
//
// SOURCE (public domain, one-time fetch): Wikimedia Commons
//   https://commons.wikimedia.org/wiki/File:Last_Judgement_(Michelangelo).jpg
// fetched via Special:FilePath at ~1500px, `sips` JPG→PNG →
//   app/scripts/bg-src/last-judgment.png (committed).
//
// Zero-dependency, matching the repo discipline: the PNG is DECODED by hand
// (node zlib inflate + scanline defilter — None/Sub/Up/Average/Paeth), the exact
// inverse of gen-bg.mjs's hand-rolled PNG WRITER, which is reused verbatim below
// along with its Bayer 8×8 ordered-dither. The image is box-downscaled to a chunky
// working resolution (the dither must be VISIBLE — the Remilia halftone look, not a
// faithful reproduction), then rendered in one of two treatments:
//   • NATURAL  — the fresco's own colours, per-channel posterised + Bayer dithered.
//   • TINTED   — luminance mapped onto a paper→tint duotone ramp (pink / peach /
//                neutral), preserving the app's per-page tint system exactly.
// Shown with `image-rendering: pixelated` so the ordered grain stays crisp.
//
// Usage (exact commands recorded in this repo's UI-5 report):
//   node scripts/gen-bg-photo.mjs --treat=natural --out=public/bg-natural.png
//   node scripts/gen-bg-photo.mjs --treat=pink     --out=public/bg-pink.png
//   node scripts/gen-bg-photo.mjs --treat=peach    --out=public/bg-peach.png
//   node scripts/gen-bg-photo.mjs --treat=paper    --out=public/bg-paper.png
// Knobs: --src=scripts/bg-src/last-judgment.png  --dw=560 (working width)
//        --levels=5 (natural per-channel steps)  --contrast=1.2  --gamma=1.0
//        --crop=0.0 (top fraction to drop)  --pink/--peach/--paper/--ink/--ink2 hex

import { inflateSync, deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
const SRC = resolve(process.cwd(), String(args.src ?? "scripts/bg-src/last-judgment.png"));
const DW = Number(args.dw ?? 560);                 // working width (chunky)
const LEVELS = Number(args.levels ?? 5);           // natural: per-channel steps
const CONTRAST = Number(args.contrast ?? 1.2);
const GAMMA = Number(args.gamma ?? 1.0);
const CROP = Number(args.crop ?? 0.0);             // drop this top fraction of the source
const TREAT = String(args.treat ?? "natural");     // natural | pink | peach | paper
const OUT = resolve(process.cwd(), String(args.out ?? `public/bg-${TREAT}.png`));

function hex(s) { const h = s.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function lerp3(a, b, t) { return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function mix(cols, ws) { const s = ws.reduce((a, b) => a + b, 0) || 1; return [0, 1, 2].map((k) => cols.reduce((a, c, i) => a + c[k] * ws[i], 0) / s); }

// ---- hand-rolled PNG decode (inverse of the writer below) ----
function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
function decodePNG(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error("not a PNG");
  let p = 8, ihdr = null; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString("ascii", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), bd: data[8], ct: data[9], interlace: data[12] };
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error("no IHDR");
  if (ihdr.bd !== 8 || ihdr.interlace !== 0 || (ihdr.ct !== 2 && ihdr.ct !== 6))
    throw new Error(`unsupported PNG: bit-depth ${ihdr.bd}, colour-type ${ihdr.ct}, interlace ${ihdr.interlace} — re-export as 8-bit RGB/RGBA non-interlaced (sips -s format png)`);
  const bpp = ihdr.ct === 6 ? 4 : 3, { w, h } = ihdr, stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < h * (stride + 1)) throw new Error("truncated IDAT");
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, y * stride + stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (ft === 1) v = (v + a) & 255;
      else if (ft === 2) v = (v + b) & 255;
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (ft === 4) v = (v + paeth(a, b, c)) & 255;
      cur[i] = v;
    }
    prev = cur;
  }
  return { w, h, bpp, pix: out };
}

// ---- box-average downscale to (dw × dh), returning RGB floats ----
function downscale(img, dw, cropTop) {
  const { w, h, bpp, pix } = img;
  const y0 = Math.floor(h * clamp01(cropTop)), hh = h - y0;
  const dh = Math.max(1, Math.round((hh * dw) / w));
  const rgb = new Float64Array(dw * dh * 3);
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = y0 + Math.floor((dy * hh) / dh), sy1 = y0 + Math.max(Math.floor(((dy + 1) * hh) / dh), Math.floor((dy * hh) / dh) + 1);
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = Math.floor((dx * w) / dw), sx1 = Math.max(Math.floor(((dx + 1) * w) / dw), sx0 + 1);
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
        const o = (sy * w + sx) * bpp; r += pix[o]; g += pix[o + 1]; b += pix[o + 2]; n++;
      }
      const o = (dy * dw + dx) * 3; rgb[o] = r / n; rgb[o + 1] = g / n; rgb[o + 2] = b / n;
    }
  }
  return { w: dw, h: dh, rgb };
}

// ---- Bayer 8×8 ordered dither (shared with gen-bg.mjs) ----
const BAYER8 = [[0,32,8,40,2,34,10,42],[48,16,56,24,50,18,58,26],[12,44,4,36,14,46,6,38],
  [60,28,52,20,62,30,54,22],[3,35,11,43,1,33,9,41],[51,19,59,27,49,17,57,25],
  [15,47,7,39,13,45,5,37],[63,31,55,23,61,29,53,21]].map((r) => r.map((v) => v / 64));
function ditherChannel(v, mask, levels) {
  const vn = (v / 255) * (levels - 1);
  const qi = Math.min(levels - 1, Math.max(0, Math.round(vn + (mask - 0.5))));
  return Math.round((qi * 255) / (levels - 1)); // levels ≥ 2 here (natural 5, tint 6)
}

// tone shaping: contrast around mid then gamma, on a 0..1 value.
function shape(x) { return clamp01(Math.pow(clamp01((x - 0.5) * CONTRAST + 0.5), GAMMA)); }
const lum = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) / 255; // rec601, 0..1

// duotone ramps: shadow → mid → highlight(paper), preserving the per-page tints.
const RAMPS = {
  pink:  { shadow: lerp3(PINK, INK, 0.66),  mid: mix([PINK, PEACH], [3, 1]),               light: PAPER },
  peach: { shadow: lerp3(PEACH, INK, 0.60),  mid: mix([PEACH, PINK], [3, 1]),               light: PAPER },
  paper: { shadow: lerp3(INK, mix([PINK, PEACH], [1, 1]), 0.24), mid: INK2,                 light: PAPER }, // warm neutral
};
function rampColor(L, ramp) {
  return L < 0.5 ? lerp3(ramp.shadow, ramp.mid, L * 2) : lerp3(ramp.mid, ramp.light, (L - 0.5) * 2);
}

// ---- render the working image → dithered RGB scanlines ----
const src = decodePNG(readFileSync(SRC));
const small = downscale(src, DW, CROP);
const W = small.w, H = small.h;
const isNatural = TREAT === "natural";
const ramp = RAMPS[TREAT];
if (!isNatural && !ramp) { console.error(`unknown --treat=${TREAT} (natural|pink|peach|paper)`); process.exit(1); }

const rawPng = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const rowOff = y * (1 + W * 3);
  rawPng[rowOff] = 0; // filter: None
  for (let x = 0; x < W; x++) {
    const si = (y * W + x) * 3;
    let r = small.rgb[si], g = small.rgb[si + 1], b = small.rgb[si + 2];
    let col, lv;
    if (isNatural) {
      // fresco colours, contrast-shaped per channel, then per-channel posterise+dither.
      col = [shape(r / 255) * 255, shape(g / 255) * 255, shape(b / 255) * 255];
      lv = LEVELS;
    } else {
      // luminance → paper→tint duotone. 6 steps per channel keeps the ramp smooth
      // while the ordered dither carries the tone between them.
      col = rampColor(shape(lum(r, g, b)), ramp);
      lv = 6;
    }
    const m = BAYER8[y & 7][x & 7], o = rowOff + 1 + x * 3;
    rawPng[o]     = ditherChannel(col[0], m, lv);
    rawPng[o + 1] = ditherChannel(col[1], m, lv);
    rawPng[o + 2] = ditherChannel(col[2], m, lv);
  }
}

// ---- PNG assembly (hand-rolled writer, shared with gen-bg.mjs) ----
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
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rawPng, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`bg-photo(${TREAT}) → ${OUT}  ${W}×${H}px  ${(png.length / 1024).toFixed(0)}KB  src=${src.w}×${src.h} dw=${DW} levels=${LEVELS} contrast=${CONTRAST}`);
