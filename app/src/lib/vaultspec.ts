// VAULT-1 spec constants — the SINGLE source of truth for the launch wizard's
// client-side validation AND the /docs clamp table. Mirrors, exactly:
//   • crates/house-math/src/margin.rs  (the margin-floor invariant + caps)
//   • programs/house/src/lib.rs::create_vault  (every require! clamp)
//   • crates/house-math/src/aggregator.rs::quorum + MAX_POOLS
// If a value here disagrees with the program, the wizard would let a doomed tx
// through — so these are pinned to the on-chain numbers and nothing duplicates
// them (the docs render this module; they do not restate the numbers).

export const BP = 10_000n;

// ---- margin.rs caps ----
export const DUAL_RTP_MIN_BP = 9_200; // 92%
export const DUAL_RTP_MAX_BP = 9_500; // 95%
export const BAND_CAP_BP = 300; // 3%
export const MARGIN_FLOOR_BP = 200; // 2%
// ---- twap.rs ring coverage ----
export const RING_MIN_COVERAGE_SECS = 1_485; // 99 × 15s
// ---- aggregator.rs ----
export const MAX_POOLS = 5;
/** Majority-of-set quorum (⌊n/2⌋ + 1): 1,2,2,3,3 for n = 1..5. */
export const quorumOf = (setLen: number): number => Math.floor(setLen / 2) + 1;

/** margin.rs::margin_floor_holds — worst-case effective payout ≤ BP − floor.
 *  rtpMax·(BP+band) ≤ (BP−m)·BP. Integer-exact (bigint), same as on-chain. */
export function marginFloorHolds(rtpMaxBp: number, bandBp: number, mBp: number): boolean {
  return BigInt(rtpMaxBp) * (BP + BigInt(bandBp)) <= (BP - BigInt(mBp)) * BP;
}

/** The clamped, user-settable parameters of a vault (the create_vault DualParams,
 *  minus the pool/observation which come from the set). All the wizard's PARAMS
 *  step edits, with the defaults the live proof used (the dual-chip-1 profile). */
export interface VaultParams {
  tokenDecimals: number;
  dLow: bigint; dMid: bigint; dHigh: bigint;
  maxExposureBp: number; smoothWindow: bigint; epochLength: bigint;
  twapWindowSecs: number; maxStalenessSecs: number;
  bandBp: number; mBp: number; haircutBp: number; rtpMaxBp: number; maxPendingSpins: number;
}

/** Defaults prefilled by the wizard — the values `scripts/vault1-live-proof.ts`
 *  created the live vault-set-1 with (a shallow, best-odds profile on CHIP/WSOL). */
export const DEFAULT_PARAMS: VaultParams = {
  tokenDecimals: 9,
  dLow: 1_000_000_000_000n, dMid: 100_000_000_000_000n, dHigh: 1_000_000_000_000_000n,
  maxExposureBp: 100, smoothWindow: 9_000n, epochLength: 1_350n,
  twapWindowSecs: 60, maxStalenessSecs: 180,
  bandBp: 300, mBp: 200, haircutBp: 1_500, rtpMaxBp: 9_500, maxPendingSpins: 100,
};

/** One row of the clamp table — rendered by /docs AND checked by the wizard. */
export interface Clamp {
  key: keyof VaultParams | "setLen";
  label: string;
  min: number | null; // inclusive; null = no lower bound beyond > 0 where noted
  max: number | null;
  note: string;
  error: string; // the on-chain HouseError a violation would raise
}

// The clamp table, in the order create_vault checks them. `min`/`max` are the
// numeric bounds where they fit an integer field; the structural ordering rule
// (0 < d_low < d_mid < d_high) is validated separately in `validateParams`.
export const CLAMPS: Clamp[] = [
  { key: "setLen", label: "Pool-set size", min: 1, max: MAX_POOLS, note: "1–5 CLMM pools of the payout token. Odd sizes (1, 3, 5) are recommended (see the pool-set section).", error: "InvalidSetLen" },
  { key: "tokenDecimals", label: "Token decimals", min: 0, max: 18, note: "The SPL mint's decimals (read from the mint account).", error: "InvalidParams" },
  { key: "maxExposureBp", label: "Max exposure", min: 1, max: 10_000, note: "Largest fraction of token depth one spin can reserve (basis points; 100 = 1%).", error: "InvalidParams" },
  { key: "twapWindowSecs", label: "TWAP window", min: 1, max: RING_MIN_COVERAGE_SECS, note: "Averaging window per pool, in seconds. Capped at the 1485s the Raydium observation ring can cover.", error: "TwapWindowExceedsRingCoverage" },
  { key: "maxStalenessSecs", label: "Max staleness", min: 1, max: null, note: "A pool is ineligible if its newest observation is older than this (seconds).", error: "InvalidParams" },
  { key: "maxPendingSpins", label: "Max pending spins", min: 1, max: 65_535, note: "Concurrent un-settled spins allowed.", error: "InvalidParams" },
  { key: "haircutBp", label: "Haircut reserve", min: 0, max: 10_000, note: "Extra cushion reserved per spin against reveal-window drift (basis points; 1500 = 15%).", error: "InvalidParams" },
  { key: "rtpMaxBp", label: "RTP ceiling", min: DUAL_RTP_MIN_BP, max: DUAL_RTP_MAX_BP, note: "Realized-RTP ceiling. Clamped to the dual [92%, 95%] corridor so no vault can be a faucet.", error: "MarginFloorViolation" },
  { key: "bandBp", label: "Price band", min: 0, max: BAND_CAP_BP, note: "A pool is ineligible if its spot drifts more than this from its own TWAP (basis points). Capped at 300bp.", error: "MarginFloorViolation" },
  { key: "mBp", label: "Margin floor", min: MARGIN_FLOOR_BP, max: 9_999, note: "House margin floor. Must satisfy rtpMax·(BP+band) ≤ (BP−m)·BP — the invariant proven over ~14.6M configs.", error: "MarginFloorViolation" },
];

export interface ParamIssue { key: string; message: string; error: string }

/** Mirror of create_vault's require! chain + validate_dual_params + the margin
 *  floor. Returns every issue so the wizard can flag them inline; empty = the tx
 *  would pass the on-chain clamps (client validation NEVER replaces on-chain
 *  enforcement — a passing result only means "not doomed for a clamp reason"). */
export function validateParams(p: VaultParams, setLen: number): ParamIssue[] {
  const out: ParamIssue[] = [];
  const push = (key: string, message: string, error: string) => out.push({ key, message, error });

  if (setLen < 1 || setLen > MAX_POOLS) push("setLen", `Pool-set size must be 1–${MAX_POOLS}.`, "InvalidSetLen");
  // structural ordering
  if (!(p.dLow > 0n && p.dLow < p.dMid && p.dMid < p.dHigh))
    push("dLow", "Depth knees must satisfy 0 < d_low < d_mid < d_high.", "InvalidParams");
  if (!(p.maxExposureBp >= 1 && p.maxExposureBp <= 10_000)) push("maxExposureBp", "Max exposure must be 1–10000 bp.", "InvalidParams");
  if (!(p.smoothWindow > 0n)) push("smoothWindow", "Smoothing window must be > 0.", "InvalidParams");
  if (!(p.epochLength > 0n)) push("epochLength", "Epoch length must be > 0.", "InvalidParams");
  if (!(p.tokenDecimals >= 0 && p.tokenDecimals <= 18)) push("tokenDecimals", "Token decimals must be 0–18.", "InvalidParams");
  if (!(p.twapWindowSecs >= 1)) push("twapWindowSecs", "TWAP window must be ≥ 1s.", "InvalidParams");
  if (p.twapWindowSecs > RING_MIN_COVERAGE_SECS) push("twapWindowSecs", `TWAP window must be ≤ ${RING_MIN_COVERAGE_SECS}s (ring coverage).`, "TwapWindowExceedsRingCoverage");
  if (!(p.maxStalenessSecs >= 1)) push("maxStalenessSecs", "Max staleness must be ≥ 1s.", "InvalidParams");
  if (!(p.maxPendingSpins >= 1)) push("maxPendingSpins", "Max pending spins must be ≥ 1.", "InvalidParams");
  if (!(p.haircutBp >= 0 && p.haircutBp <= 10_000)) push("haircutBp", "Haircut must be 0–10000 bp.", "InvalidParams");

  // the margin-floor gate (validate_dual_params)
  if (!(p.rtpMaxBp >= DUAL_RTP_MIN_BP && p.rtpMaxBp <= DUAL_RTP_MAX_BP))
    push("rtpMaxBp", `RTP ceiling must be within [${DUAL_RTP_MIN_BP}, ${DUAL_RTP_MAX_BP}] bp.`, "MarginFloorViolation");
  if (!(p.bandBp <= BAND_CAP_BP)) push("bandBp", `Price band must be ≤ ${BAND_CAP_BP} bp.`, "MarginFloorViolation");
  if (!(p.mBp >= MARGIN_FLOOR_BP)) push("mBp", `Margin floor must be ≥ ${MARGIN_FLOOR_BP} bp.`, "MarginFloorViolation");
  if (p.mBp >= 10_000) push("mBp", "Margin floor must be < 10000 bp.", "MarginFloorViolation");
  else if (!marginFloorHolds(p.rtpMaxBp, p.bandBp, p.mBp))
    push("mBp", `Infeasible: ${p.rtpMaxBp}·(10000+${p.bandBp}) > (10000−${p.mBp})·10000 crosses the house floor.`, "MarginFloorViolation");

  return out;
}
