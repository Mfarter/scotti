// Share-price semantics — defined ONCE, here, per machine type. The two dual
// series are deliberately NOT blended into a single number:
//
//   single-asset : pool_value / total_shares            (lamports per share)
//   dual PRIMARY : token_balance / total_shares         (token base units per share)
//                  — price-free, manipulation-immune, the headline series.
//   dual SECONDARY (price-dependent, clearly labeled):
//                  pending SOL dividend pool, and token_balance valued at the CLMM
//                  TWAP. Only meaningful when the price is LIVE; null otherwise.
//
// Bigints are stored as decimal strings; per-share prices are ×1e12 fixed point so
// they survive integer storage.
import { collectObservations, computeTwap, decodePool, type Machine } from "./reuse.ts";
import type { DualMachine } from "./dual-decode.ts";

const ONE_E12 = 1_000_000_000_000n;

// value (lamports) of `tokens` base units at `price1e12` token-per-SOL, `dec`
// decimals — the dual value formula (mirrors scripts/verify-spin.ts payoutValueLamports).
export function tokenValueLamports(tokens: bigint, price1e12: bigint, dec: number): bigint {
  return price1e12 === 0n ? 0n : (tokens * 1_000_000_000n * ONE_E12) / (price1e12 * 10n ** BigInt(dec));
}

export interface SingleSample {
  poolValue: bigint;
  totalShares: bigint;
  sharePrice1e12: bigint; // lamports per share ×1e12
}
export function singleSample(m: Machine): SingleSample {
  return {
    poolValue: m.poolValue,
    totalShares: m.totalShares,
    sharePrice1e12: m.totalShares === 0n ? 0n : (m.poolValue * ONE_E12) / m.totalShares,
  };
}

export type PriceKind = "LIVE" | "UNSTABLE" | "STALE";
export interface DualPrice {
  kind: PriceKind;
  twap1e12: bigint | null; // token per SOL ×1e12 (null unless LIVE)
  spot1e12: bigint | null;
  reason: string;
}
/** Reuse the pinned CLMM decoders + house-math TWAP to price the dual pool, then
 * apply the same LIVE/UNSTABLE/STALE gate the on-chain spin_commit_dual applies. */
export function dualPrice(
  poolData: Buffer, obsData: Buffer, now: number, windowSecs: number, maxStale: number, bandBp: number,
): DualPrice {
  const tick = decodePool(poolData).tickCurrent;
  const twap = computeTwap(collectObservations(obsData), tick, now, windowSecs, maxStale);
  const spot = Math.pow(1.0001, tick);
  const spot1e12 = BigInt(Math.round(spot * 1e12));
  if (twap.status !== "LIVE" || twap.price === null) {
    return { kind: "STALE", twap1e12: null, spot1e12, reason: twap.reason };
  }
  const twap1e12 = BigInt(Math.round(twap.price * 1e12));
  const driftBp = Math.abs(spot - twap.price) / twap.price * 10_000;
  if (driftBp > bandBp) return { kind: "UNSTABLE", twap1e12, spot1e12, reason: `spot ${Math.round(driftBp)}bp off TWAP > ${bandBp}bp` };
  return { kind: "LIVE", twap1e12, spot1e12, reason: "ok" };
}

export interface DualSample {
  tokenBalance: bigint;
  totalShares: bigint;
  sharePriceTokens1e12: bigint; // PRIMARY: token base units per share ×1e12
  divPoolSol: bigint;           // SECONDARY: pending SOL dividend pool (lamports)
  twap1e12: bigint | null;      // SECONDARY: token per SOL ×1e12 (null unless LIVE)
  tokenValueLamports: bigint | null; // SECONDARY: token_balance at TWAP (null unless LIVE)
  priceKind: PriceKind;
}
export function dualSample(m: DualMachine, price: DualPrice): DualSample {
  const live = price.kind === "LIVE" && price.twap1e12 !== null;
  return {
    tokenBalance: m.tokenBalance,
    totalShares: m.totalShares,
    sharePriceTokens1e12: m.totalShares === 0n ? 0n : (m.tokenBalance * ONE_E12) / m.totalShares,
    divPoolSol: m.divPoolSol,
    twap1e12: live ? price.twap1e12 : null,
    tokenValueLamports: live ? tokenValueLamports(m.tokenBalance, price.twap1e12!, m.tokenDecimals) : null,
    priceKind: price.kind,
  };
}
