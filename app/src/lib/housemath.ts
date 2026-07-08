// house-math port (BigInt, integer-exact) — mirrors crates/house-math/src/lib.rs
// and scripts/common.ts. Pure: no node, no web3. The browser verifier and the
// machine cards recompute odds/payouts through exactly this.

export const BP = 10_000n;
export const STOPS = 32n;
export const JACKPOT = 0, SEVEN = 1, BELL = 2, BAR = 3, CHERRY = 4, BLANK = 5;
export const SYMBOL_NAME = ["JACKPOT", "SEVEN", "BELL", "BAR", "CHERRY", "BLANK"];
export const STRIP: number[] = [
  JACKPOT,
  SEVEN, SEVEN,
  BELL, BELL, BELL, BELL,
  BAR, BAR, BAR, BAR, BAR, BAR,
  CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY,
  BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK,
];

export interface Tier {
  name: string;
  threeJackpot: bigint; threeSeven: bigint; threeBell: bigint;
  threeBar: bigint; threeCherry: bigint; twoCherry: bigint; oneCherry: bigint;
}
export const SHALLOW: Tier = { name: "shallow", threeJackpot: 500000n, threeSeven: 250000n, threeBell: 120000n, threeBar: 80000n, threeCherry: 50000n, twoCherry: 22000n, oneCherry: 8000n };
export const DEEP: Tier = { name: "deep", threeJackpot: 5000000n, threeSeven: 600000n, threeBell: 250000n, threeBar: 100000n, threeCherry: 60000n, twoCherry: 20000n, oneCherry: 7000n };
export const maxMultBp = (t: Tier) => t.threeJackpot;
/** Top multiplier as a human "×" number (e.g. SHALLOW 50, DEEP 500). */
export const topMultiplier = (t: Tier) => Number(t.threeJackpot / BP);

export function payoutBp(t: Tier, s: number[]): bigint {
  if (s[0] === s[1] && s[1] === s[2]) {
    switch (s[0]) {
      case JACKPOT: return t.threeJackpot;
      case SEVEN: return t.threeSeven;
      case BELL: return t.threeBell;
      case BAR: return t.threeBar;
      case CHERRY: return t.threeCherry;
      default: return 0n;
    }
  }
  const c = s.filter((x) => x === CHERRY).length;
  return c === 2 ? t.twoCherry : c === 1 ? t.oneCherry : 0n;
}
export function spinPayout(wager: bigint, t: Tier, kBp: bigint, s: number[]): bigint {
  return ((wager * payoutBp(t, s)) / BP) * kBp / BP;
}
export function reelsFromRandomness(bytes: Uint8Array): number[] {
  return [STRIP[bytes[0] % 32], STRIP[bytes[1] % 32], STRIP[bytes[2] % 32]];
}

function ceilDiv(a: bigint, b: bigint): bigint { return (a + b - 1n) / b; }
export function kBoundsOfNum(num: bigint): [bigint, bigint] {
  const total = STOPS * STOPS * STOPS;
  return [ceilDiv(9200n * total * BP, num), (9700n * total * BP) / num];
}
export const SHALLOW_NUM = 301_132_000n;
export const DEEP_NUM = 302_901_000n;
export const SHALLOW_K = kBoundsOfNum(SHALLOW_NUM);
export const DEEP_K = kBoundsOfNum(DEEP_NUM);
export const kBoundsConst = (isDeep: boolean): [bigint, bigint] => (isDeep ? DEEP_K : SHALLOW_K);
export function kOfDepth(depth: bigint, dLow: bigint, dHigh: bigint, kMin: bigint, kMax: bigint): bigint {
  if (depth <= dLow) return kMax;
  if (depth >= dHigh) return kMin;
  return kMax - ((kMax - kMin) * (depth - dLow)) / (dHigh - dLow);
}
// ODDS-1: the normalized cross-machine odds curve (mirrors crates/house-math).
// k is a global, monotone-decreasing function of pool value against a protocol
// reference, so the lowest pool always has the best odds — no per-machine curve.
export const REF_D_LOW = 100_000_000n; // 0.1 SOL
export const REF_D_MID = 2_000_000_000n; // 2 SOL — tier split and RTP floor point
export const isDeepRef = (poolValue: bigint): boolean => poolValue >= REF_D_MID;
export function targetRtpBp(poolValue: bigint): bigint {
  if (poolValue <= REF_D_LOW) return 9700n;
  if (poolValue >= REF_D_MID) return 9200n;
  return 9700n - ((9700n - 9200n) * (poolValue - REF_D_LOW)) / (REF_D_MID - REF_D_LOW);
}
/** Normalized k target: the scaler realizing target RTP for the active tier's
 * paytable, clamped to the band. Monotone non-increasing in pool value. */
export function kTarget(poolValue: bigint): bigint {
  const isDeep = isDeepRef(poolValue);
  const num = isDeep ? DEEP_NUM : SHALLOW_NUM;
  const [kMin, kMax] = kBoundsConst(isDeep);
  const total = STOPS * STOPS * STOPS;
  const k = (targetRtpBp(poolValue) * total * BP) / num;
  return k < kMin ? kMin : k > kMax ? kMax : k;
}
export function maxBet(depth: bigint, expoBp: bigint, t: Tier, kBp: bigint): bigint {
  const eff = (maxMultBp(t) * kBp) / BP;
  if (eff === 0n) return 0n;
  return (((depth * expoBp) / BP) * BP) / eff;
}
/** SmoothedDepth.update — returns the advanced value. */
export function smoothedUpdate(value: bigint, lastSlot: bigint, depthNow: bigint, slotNow: bigint, window: bigint): bigint {
  let elapsed = slotNow > lastSlot ? slotNow - lastSlot : 0n;
  if (elapsed > window) elapsed = window;
  if (elapsed > 0n) {
    if (depthNow >= value) value += ((depthNow - value) * elapsed) / window;
    else value -= ((value - depthNow) * elapsed) / window;
  }
  return value;
}
/** Realized RTP in bp for a tier at scaler k: base_rtp * k / BP (house-math). */
export function realizedRtpBp(isDeep: boolean, k: bigint): bigint {
  const num = isDeep ? DEEP_NUM : SHALLOW_NUM;
  const total = STOPS * STOPS * STOPS;
  return (num * k) / (total * BP);
}

// -------------------- dual-asset token payout (mirrors crates/house-math/src/payout.rs) --------------------

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const PRICE_SCALE = 1_000_000_000_000n; // 1e12, the price_1e12 fixed point
/** LAMPORTS_PER_SOL · BP² · PRICE_SCALE = 1e29. BigInt is exact, no wide_mul_div needed. */
export const PAYOUT_DENOM = LAMPORTS_PER_SOL * BP * BP * PRICE_SCALE;
export const pow10 = (dec: number): bigint => 10n ** BigInt(dec);

/** Dual k-bounds: like the single-asset bounds but the ceiling respects the
 * machine's validated RTP cap (rtp_max_bp), not the fixed 9700 (spec §4). */
export function kBoundsDual(num: bigint, rtpMaxBp: bigint): [bigint, bigint] {
  const total = STOPS * STOPS * STOPS;
  return [ceilDiv(9200n * total * BP, num), (rtpMaxBp * total * BP) / num];
}

/** payout in token base units: wager·mult·k·price·10^dec / 1e29 (payout.rs). */
export function payoutTokens(wagerLamports: bigint, multBp: bigint, kBp: bigint, price1e12: bigint, dec: number): bigint {
  return (wagerLamports * multBp * kBp * pow10(dec) * price1e12) / PAYOUT_DENOM;
}
export function spinPayoutTokens(wagerLamports: bigint, t: Tier, kBp: bigint, symbols: number[], price1e12: bigint, dec: number): bigint {
  return payoutTokens(wagerLamports, payoutBp(t, symbols), kBp, price1e12, dec);
}
/** token payout → its SOL value in lamports (display + curve depth). */
export function payoutValueLamports(payoutTok: bigint, price1e12: bigint, dec: number): bigint {
  const denom = price1e12 * pow10(dec);
  return denom === 0n ? 0n : (payoutTok * LAMPORTS_PER_SOL * PRICE_SCALE) / denom;
}
