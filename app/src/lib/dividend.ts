// SOL dividend ledger math — mirrors crates/house-math/src/dividend.rs. The dual
// LP's pending SOL dividend = its share entitlement minus its reward debt.
export const SOL_INDEX_SCALE = 1_000_000_000_000_000_000_000_000n; // 1e24

/** floor(shares · acc / 1e24) — a share count's SOL entitlement to date. */
export const solEntitlement = (shares: bigint, accSolPerShare: bigint): bigint => (shares * accSolPerShare) / SOL_INDEX_SCALE;

/** pending SOL for a position: entitlement − debt, floored, never negative. */
export function pendingSol(shares: bigint, solDebt: bigint, accSolPerShare: bigint): bigint {
  const ent = solEntitlement(shares, accSolPerShare);
  return ent > solDebt ? ent - solDebt : 0n;
}
