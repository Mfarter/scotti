// Browser CLMM price read — the client twin of the machine's on-chain price seam.
// Mirrors scripts/layouts.ts (pinned PoolState/ObservationState offsets,
// ground-truthed in H6a) and scripts/twap.ts (cumulative-tick TWAP) EXACTLY, the
// same way housemath.ts mirrors crates/house-math. The pinned offsets are the
// ones verify-layouts.ts guards against the live devnet program; keep them
// identical here. Uses the "buffer" polyfill like the rest of the app.
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";

// ---- devnet CHIP/WSOL demo market (scripts/raydium-constants.ts) ----
export const CLMM_PROGRAM_ID = new PublicKey("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
export const CHIP_MINT = new PublicKey("75zyWBYdFSNNFKDaTdEu9nZWdHaZCuuCd7tgCCxi2w6p");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// ---- PoolState pinned offsets (span 1544), from scripts/layouts.ts ----
const POOL_SPAN = 1544;
const POOL = { observationId: 201, sqrtPriceX64: 253, tickCurrent: 269 } as const;
// ---- ObservationState pinned offsets (span 4483) ----
const OBS = { SPAN: 4483, observationIndex: 17, observations: 51, ITEM_STRIDE: 44, ITEM_ts: 0, ITEM_cum: 4, COUNT: 100 } as const;

function u128LE(b: Buffer, o: number): bigint { return b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n); }

export interface PoolView { sqrtPriceX64: bigint; tickCurrent: number; price: number; span: number; }
/** Q64.64 sqrt price → CHIP-per-SOL (mintA = WSOL, mintB = CHIP, equal decimals). */
export function decodePool(b: Buffer): PoolView {
  const sqrtPriceX64 = u128LE(b, POOL.sqrtPriceX64);
  const num = Number(sqrtPriceX64) / 2 ** 64;
  return { sqrtPriceX64, tickCurrent: b.readInt32LE(POOL.tickCurrent), price: num * num, span: b.length };
}

export interface Obs { ts: number; tickCum: bigint; }
/** Initialized observations (ts>0), de-duped, ascending by ts (twap.ts). */
export function collectObservations(b: Buffer): Obs[] {
  const seen = new Map<number, bigint>();
  for (let i = 0; i < OBS.COUNT; i++) {
    const off = OBS.observations + i * OBS.ITEM_STRIDE;
    const ts = b.readUInt32LE(off + OBS.ITEM_ts);
    if (ts > 0) seen.set(ts, b.readBigInt64LE(off + OBS.ITEM_cum));
  }
  return [...seen.entries()].map(([ts, tickCum]) => ({ ts, tickCum })).sort((a, b) => a.ts - b.ts);
}

/** Cumulative tick at time t; extrapolates past the newest obs using currentTick. */
function cumulativeAt(obs: Obs[], currentTick: number, t: number): bigint | null {
  if (obs.length === 0) return null;
  const newest = obs[obs.length - 1];
  if (t >= newest.ts) return newest.tickCum + BigInt(currentTick) * BigInt(t - newest.ts);
  if (t < obs[0].ts) return null;
  for (let i = obs.length - 1; i > 0; i--) {
    const b = obs[i], a = obs[i - 1];
    if (t >= a.ts && t <= b.ts) {
      if (b.ts === a.ts) return a.tickCum;
      const rate = Number(b.tickCum - a.tickCum) / (b.ts - a.ts);
      return a.tickCum + BigInt(Math.round(rate * (t - a.ts)));
    }
  }
  return null;
}

export type TwapStatusKind = "LIVE" | "STALE";
export interface TwapResult {
  status: TwapStatusKind; reason: string;
  avgTick: number | null; price: number | null; // CHIP per SOL
  coverageSecs: number; staleSecs: number; obsCount: number;
}
export function computeTwap(obs: Obs[], currentTick: number, now: number, windowSecs: number, maxStaleness: number): TwapResult {
  const base = { obsCount: obs.length };
  if (obs.length === 0) return { status: "STALE", reason: "cold-start: no observations yet", avgTick: null, price: null, coverageSecs: 0, staleSecs: Infinity, ...base };
  const newest = obs[obs.length - 1], oldest = obs[0];
  const staleSecs = now - newest.ts;
  const coverageSecs = newest.ts - oldest.ts;
  const cumNow = cumulativeAt(obs, currentTick, now)!;
  const cumThen = cumulativeAt(obs, currentTick, now - windowSecs);
  if (cumThen === null) return { status: "STALE", reason: `cold-start: history ${coverageSecs}s < window ${windowSecs}s`, avgTick: null, price: null, coverageSecs, staleSecs, ...base };
  if (staleSecs > maxStaleness) return { status: "STALE", reason: `stale: newest obs ${staleSecs}s old > max ${maxStaleness}s`, avgTick: null, price: null, coverageSecs, staleSecs, ...base };
  const avgTick = Number(cumNow - cumThen) / windowSecs;
  return { status: "LIVE", reason: "ok", avgTick, price: Math.pow(1.0001, avgTick), coverageSecs, staleSecs, ...base };
}

// -------------------- price-status (the machine's commit gate, client-side) --------------------

export type PriceStatusKind = "LIVE" | "UNSTABLE" | "STALE";
export interface PriceStatus {
  kind: PriceStatusKind;          // LIVE = fresh + in band; UNSTABLE = band exceeded; STALE = obs too old / cold
  label: string;                  // "LIVE" | "PRICE UNSTABLE" | "STALE"
  reason: string;                 // human explanation (the on-chain refusal reason)
  spot: number | null;            // CHIP per SOL
  twap: number | null;            // CHIP per SOL (the price_at_commit the machine would snapshot)
  twap1e12: bigint | null;        // TWAP scaled 1e12 (the on-chain fixed point)
  bandBp: number | null;          // |spot − twap| / twap in bp
  staleSecs: number;              // age of the newest observation
  coverageSecs: number; obsCount: number;
  commitAllowed: boolean;         // would spin_commit_dual accept right now?
}

/** Classify the pool the way eval_price_gates does: staleness first (STALE), then
 * band (PRICE UNSTABLE). `now` is cluster unix time. windowSecs/maxStaleness/bandBp
 * come from the DualMachine params (identical gate as the on-chain seam). */
export function priceStatus(
  poolData: Buffer, obsData: Buffer, now: number,
  windowSecs: number, maxStalenessSecs: number, bandBp: number,
): PriceStatus {
  const pool = decodePool(poolData);
  const okSpan = pool.span >= POOL_SPAN && obsData.length >= OBS.SPAN;
  const obs = collectObservations(obsData);
  const twap = computeTwap(obs, pool.tickCurrent, now, windowSecs, maxStalenessSecs);
  const spot = pool.price;
  if (!okSpan) {
    return { kind: "STALE", label: "STALE", reason: "pool/observation account layout unexpected", spot, twap: null, twap1e12: null, bandBp: null, staleSecs: twap.staleSecs, coverageSecs: twap.coverageSecs, obsCount: twap.obsCount, commitAllowed: false };
  }
  if (twap.status === "STALE") {
    return { kind: "STALE", label: "STALE", reason: twap.reason, spot, twap: null, twap1e12: null, bandBp: null, staleSecs: twap.staleSecs, coverageSecs: twap.coverageSecs, obsCount: twap.obsCount, commitAllowed: false };
  }
  const twapPrice = twap.price!;
  const band = Math.round((Math.abs(spot - twapPrice) / twapPrice) * 10_000);
  const twap1e12 = BigInt(Math.round(twapPrice * 1e12));
  if (band > bandBp) {
    return { kind: "UNSTABLE", label: "PRICE UNSTABLE", reason: `spot ${spot.toFixed(2)} drifted ${band}bp from TWAP ${twapPrice.toFixed(2)} (> ${bandBp}bp band)`, spot, twap: twapPrice, twap1e12, bandBp: band, staleSecs: twap.staleSecs, coverageSecs: twap.coverageSecs, obsCount: twap.obsCount, commitAllowed: false };
  }
  return { kind: "LIVE", label: "LIVE", reason: "fresh and in band", spot, twap: twapPrice, twap1e12, bandBp: band, staleSecs: twap.staleSecs, coverageSecs: twap.coverageSecs, obsCount: twap.obsCount, commitAllowed: true };
}
