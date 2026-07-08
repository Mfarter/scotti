// Client mirror of crates/house-math/src/aggregator.rs — the median-of-eligible
// price over a pool set, gated by a majority quorum. Operates on the per-pool
// PriceStatus the EXISTING pinned `priceStatus` (clmm.ts) already computes, so the
// eligibility rule is byte-for-byte the on-chain per-pool gate (fresh + spot in
// band) and is never re-derived. The VERDICT (which pools are eligible, whether
// quorum is met, which pool's TWAP is the median) matches the on-chain aggregate
// for the same accounts — if it ever disagrees, that is a real bug to report, not
// to fudge (VAULT-2 stop-and-report).
import type { PriceStatus } from "./clmm.ts";
import { quorumOf } from "./vaultspec.ts";

export interface SetVerdict {
  poolSetLen: number;
  perPool: PriceStatus[];   // one per member, in set order
  eligible: number;         // count of members that pass the per-pool gate (commitAllowed)
  quorum: number;           // ⌊n/2⌋ + 1
  quorumMet: boolean;
  medianIndex: number | null; // index into perPool of the pool whose TWAP is the aggregate
  price1e12: bigint | null;   // the aggregate (median) TWAP in the on-chain fixed point
}

/** Aggregate per-pool statuses into the set verdict — median of the eligible
 *  pools' TWAPs, gated by the majority quorum. Deterministic and integer-exact:
 *  the aggregate is one member's TWAP (`sorted[m/2]`), never an average. */
export function aggregate(perPool: PriceStatus[], setLen: number): SetVerdict {
  const n = Math.min(setLen, perPool.length);
  const quorum = quorumOf(setLen);
  // eligible members with their in-set index and TWAP (the on-chain gate == commitAllowed)
  const elig = perPool
    .slice(0, n)
    .map((p, i) => ({ i, twap: p.twap1e12 }))
    .filter((e): e is { i: number; twap: bigint } => e.twap !== null && perPool[e.i].commitAllowed);

  if (elig.length < quorum) {
    return { poolSetLen: setLen, perPool, eligible: elig.length, quorum, quorumMet: false, medianIndex: null, price1e12: null };
  }
  // sort ascending by TWAP; median at index m/2 (upper-middle for even m), matching
  // aggregator.rs::aggregate exactly (a pure order statistic, integer bigint).
  const sorted = [...elig].sort((a, b) => (a.twap < b.twap ? -1 : a.twap > b.twap ? 1 : 0));
  const med = sorted[Math.floor(sorted.length / 2)];
  return { poolSetLen: setLen, perPool, eligible: elig.length, quorum, quorumMet: true, medianIndex: med.i, price1e12: med.twap };
}

/** Synthesize a PriceStatus for a set vault from the verdict + the median pool, so
 *  the existing card/page code (which reads `status.price`) renders a set vault
 *  with no special-casing. LIVE carries the median TWAP + the median pool's spot;
 *  below-quorum carries no price (commitAllowed false) and the amber QUORUM kind.
 *  (Single-pool legacy vaults keep the existing LIVE/UNSTABLE/STALE states.) */
export function setPriceStatus(v: SetVerdict): PriceStatus {
  const n = v.poolSetLen;
  if (!v.quorumMet || v.medianIndex === null || v.price1e12 === null) {
    return {
      kind: "QUORUM", label: "QUORUM NOT MET",
      reason: `only ${v.eligible}/${n} pools eligible — need ${v.quorum} (a majority) to price`,
      spot: null, twap: null, twap1e12: null, bandBp: null,
      staleSecs: 0, coverageSecs: 0, obsCount: n, commitAllowed: false,
    };
  }
  const m = v.perPool[v.medianIndex];
  return {
    kind: "LIVE", label: "LIVE",
    reason: `${v.eligible}/${n} pools live · median ${m.twap!.toFixed(2)} CHIP/SOL (of ${v.eligible} eligible)`,
    spot: m.spot, twap: m.twap, twap1e12: v.price1e12, bandBp: m.bandBp,
    staleSecs: m.staleSecs, coverageSecs: m.coverageSecs, obsCount: n, commitAllowed: true,
  };
}
