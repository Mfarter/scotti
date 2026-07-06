// The verification discipline, at ingest time. Every spin is RECOMPUTED from chain
// — reels from the randomness account, wager from the commit tx, payout from the
// settle tx's balance/token delta — and the paid amount is checked against
// house-math (the same logic as scripts/verify-spin.ts). Nothing is trusted.
//
//   verified     — recompute confirms the paid amount for verifiable reels + wager
//                  (single-asset: exact; dual-asset: consistent with the ring-
//                  recomputed price and a valid k).
//   partial      — reels + payout verified from chain, but a dual spin's price
//                  aged out of the 100-slot observation ring, so price_at_commit
//                  can't be independently recomputed. Honest, not "ok".
//   unverifiable — the randomness account is closed or the commit tx aged out of
//                  RPC history, so reels/wager can't be recovered. Stored as such.
//   mismatch     — a paid amount that does NOT factor into any valid house-math
//                  outcome for the verified reels. A bug somewhere; a STOP trigger.
import {
  payoutBp, spinPayout, kBoundsConst, DEEP, SHALLOW, DEEP_NUM, SHALLOW_NUM, BP, STOPS, SYMBOL_NAME, type Tier,
} from "./reuse.ts";

export type VerifyStatus = "verified" | "partial" | "unverifiable" | "mismatch";
export interface VerifyResult {
  status: VerifyStatus;
  detail: string;
  reels: number[] | null;
  tier: string | null;
  impliedK: bigint | null;
}

export interface RecomputeInputs {
  kind: "single" | "dual";
  wager: bigint | null;
  reels: number[] | null;
  paid: bigint | null;
  price1e12?: bigint | null; // dual: recomputed from the ring at commit (null if aged out)
  rtpMaxBp?: bigint;         // dual band max
  decimals?: number;         // dual token decimals
}

const TOTAL = STOPS * STOPS * STOPS;
const PAYOUT_DENOM = 100_000_000_000_000_000_000_000_000_000n; // 1e29
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
// dual k-bounds (mirrors scripts/verify-spin.ts kBoundsDual).
const kBoundsDual = (num: bigint, rtpMaxBp: bigint): [bigint, bigint] =>
  [ceilDiv(9200n * TOTAL * BP, num), (rtpMaxBp * TOTAL * BP) / num];
const payoutTokens = (wager: bigint, multBp: bigint, kBp: bigint, price1e12: bigint, dec: number) =>
  (wager * multBp * kBp * 10n ** BigInt(dec) * price1e12) / PAYOUT_DENOM;
const reelStr = (r: number[]) => r.map((s) => SYMBOL_NAME[s]).join(" · ");

export function recomputeSpin(inp: RecomputeInputs): VerifyResult {
  const { kind, wager, reels, paid } = inp;
  if (reels === null) return un("randomness account closed — reels unrecoverable");
  if (paid === null) return un("settle payout delta unreadable from the tx");
  if (wager === null) return un("commit tx aged out of RPC history — wager unrecoverable");

  const tiers: Tier[] = [SHALLOW, DEEP];

  // Losing spin (0 paid): the common case is a non-winning reel combo (payoutBp 0),
  // consistent with 0 regardless of price. A winning combo that floored to 0 for a
  // tiny wager is also possible — checkable only when we can compute the payout.
  if (paid === 0n) {
    for (const t of tiers) if (payoutBp(t, reels) === 0n)
      return ok("verified", `losing spin — reels ${reelStr(reels)} pay 0 in ${t.name}`, reels, t.name, null);
    // winning combo, paid 0: dual needs the price to judge; without it, honest partial.
    if (kind === "dual" && (inp.price1e12 === null || inp.price1e12 === undefined))
      return ok("partial", `reels ${reelStr(reels)} + 0 payout from chain; price aged out of the ring`, reels, null, null);
    for (const t of tiers) {
      const [kMin, kMax] = tierBounds(kind, t, inp);
      if (kMin <= kMax && spinLikePayout(kind, wager, t, kMin, reels, inp) === 0n)
        return ok("verified", `reels ${reelStr(reels)} floor to 0 payout at valid k in ${t.name}`, reels, t.name, kMin);
    }
    return mismatch(`paid 0 but reels ${reelStr(reels)} pay a positive amount at every valid k`, reels);
  }

  // Winning spin. Dual needs a recomputed price to check; without it we've still
  // verified reels + payout from chain → partial.
  if (kind === "dual" && (inp.price1e12 === null || inp.price1e12 === undefined)) {
    return ok("partial", `reels ${reelStr(reels)} + payout verified from chain; price aged out of the ring (price_at_commit not independently recomputable)`, reels, null, null);
  }

  for (const t of tiers) {
    const multBp = payoutBp(t, reels);
    if (multBp === 0n) continue;
    const [kMin, kMax] = tierBounds(kind, t, inp);
    if (kind === "single") {
      // exact: the true k satisfies paid = floor(floor(wager·mult/BP)·k/BP). Test the
      // floored implied k and its successor; accept if either reproduces paid exactly.
      const implied = (paid * BP * BP) / (wager * multBp);
      for (const kc of [implied, implied + 1n]) {
        if (kc >= kMin && kc <= kMax && spinPayout(wager, t, kc, reels) === paid)
          return ok("verified", `${reelStr(reels)} — ${t.name} k=${kc}, recompute == paid ${paid}`, reels, t.name, kc);
      }
    } else {
      const price = inp.price1e12!, dec = inp.decimals ?? 0;
      const implied = (paid * PAYOUT_DENOM) / (wager * multBp * price * 10n ** BigInt(dec));
      if (implied >= kMin && implied <= kMax) {
        const check = payoutTokens(wager, multBp, implied, price, dec);
        const drift = check > paid ? check - paid : paid - check;
        return ok("verified", `${reelStr(reels)} — ${t.name} implied k=${implied} in range, consistent with ring price (drift ${drift})`, reels, t.name, implied);
      }
    }
  }
  return mismatch(`paid ${paid} does not factor into a valid k for reels ${reelStr(reels)} at ${kind === "dual" ? "the ring price" : "any tier"}`, reels);
}

function tierBounds(kind: "single" | "dual", t: Tier, inp: RecomputeInputs): [bigint, bigint] {
  if (kind === "single") return kBoundsConst(t === DEEP);
  const num = t === DEEP ? DEEP_NUM : SHALLOW_NUM;
  return kBoundsDual(num, inp.rtpMaxBp ?? 9500n);
}
function spinLikePayout(kind: "single" | "dual", wager: bigint, t: Tier, k: bigint, reels: number[], inp: RecomputeInputs): bigint {
  if (kind === "single") return spinPayout(wager, t, k, reels);
  return payoutTokens(wager, payoutBp(t, reels), k, inp.price1e12 ?? 0n, inp.decimals ?? 0);
}

const un = (detail: string): VerifyResult => ({ status: "unverifiable", detail, reels: null, tier: null, impliedK: null });
const mismatch = (detail: string, reels: number[]): VerifyResult => ({ status: "mismatch", detail, reels, tier: null, impliedK: null });
const ok = (status: VerifyStatus, detail: string, reels: number[], tier: string | null, impliedK: bigint | null): VerifyResult =>
  ({ status, detail, reels, tier, impliedK });
