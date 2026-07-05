import { SOL } from "./constants.ts";

/** Group a bigint with thin separators, for tabular-numeral money readouts. */
export function fmtLamports(x: bigint): string {
  const s = x.toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
export function fmtSol(x: bigint, dp = 4): string {
  const neg = x < 0n; const a = neg ? -x : x;
  const whole = a / SOL;
  const frac = ((a % SOL) * 10n ** BigInt(dp)) / SOL;
  return `${neg ? "-" : ""}${whole}.${frac.toString().padStart(dp, "0")}`;
}
/** bp (10000 = 100%) to a percent string. */
export function fmtPctBp(bp: bigint, dp = 2): string {
  const scaled = (bp * BigInt(10 ** dp)) / 100n;
  const whole = scaled / BigInt(10 ** dp);
  const frac = scaled % BigInt(10 ** dp);
  return `${whole}.${frac.toString().padStart(dp, "0")}%`;
}
export function shortKey(k: string, n = 4): string {
  return k.length <= n * 2 + 1 ? k : `${k.slice(0, n)}…${k.slice(-n)}`;
}

// -------------------- RTP heat glow --------------------
// A machine's colour is its live odds. High realized RTP (a "cold" machine —
// few players, best odds) glows HOT; the deep/floor machines glow cool. Three
// stops: cool blue → gold → hot red, keyed on realized RTP across the band.

type RGB = [number, number, number];
const COOL: RGB = [63, 169, 255];  // electric blue — floor odds / deep
const MID: RGB = [245, 196, 81];   // Scotti gold
const HOT: RGB = [255, 61, 90];    // hot red — best odds / cold machine

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
/** t in [0,1] across the [92%, 97%] realized-RTP band. */
export function rtpHeat(realizedRtpBp: bigint): number {
  const t = Number(realizedRtpBp - 9200n) / (9700 - 9200);
  return Math.max(0, Math.min(1, t));
}
export function heatColor(t: number, alpha = 1): string {
  const rgb = t < 0.5 ? lerp(COOL, MID, t * 2) : lerp(MID, HOT, (t - 0.5) * 2);
  const [r, g, b] = rgb.map((c) => Math.round(c));
  return alpha >= 1 ? `rgb(${r} ${g} ${b})` : `rgb(${r} ${g} ${b} / ${alpha})`;
}
