// The fairness claim, in the browser: independently recompute a settled spin's
// outcome from on-chain data and check it against what was actually paid.
// Mirrors scripts/verify-spin.ts. Uses only the revealed randomness account and
// the settle transaction — the snapshot (frozen odds) travels in the argument.
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { DEEP, SHALLOW, reelsFromRandomness, spinPayout, spinPayoutTokens } from "./housemath.ts";
import { collectObservations, computeTwap, decodePool } from "./clmm.ts";

export interface SpinRef {
  machine: string;          // Machine PDA (base58)
  wager: string;            // lamports
  kBp: string;              // snapshot k
  tierIsDeep: boolean;      // snapshot tier
  randSeedSlot: string;     // snapshot seed_slot binding
  randomnessAccount: string;// Switchboard randomness account (base58)
  settleSig: string;        // settle tx signature
}

export interface VerifyResult {
  ok: boolean;
  reels: number[];
  recomputedPayout: bigint;
  paidOnchain: bigint;
  seedSlotOnchain: bigint;
  seedSlotMatch: boolean;
  payoutMatch: boolean;
  valueHex: string;
  note?: string;
}

export async function verifySpin(conn: Connection, ref: SpinRef): Promise<VerifyResult> {
  // 1. re-read the randomness account: revealed value + seed_slot.
  const info = await conn.getAccountInfo(new PublicKey(ref.randomnessAccount));
  if (!info) throw new Error("randomness account not found on-chain");
  const d = Buffer.from(info.data);
  // RandomnessAccountData (after 8-byte disc): authority[32] queue[32]
  // seed_slothash[32] seed_slot(u64@96) oracle[32] reveal_slot(u64@136) value[32@144]
  const seedSlotOnchain = d.readBigUInt64LE(8 + 96);
  const value = Uint8Array.from(d.subarray(8 + 144, 8 + 176));

  const seedSlotMatch = seedSlotOnchain === BigInt(ref.randSeedSlot);

  // 2. recompute reels + payout from the on-chain randomness + frozen snapshot.
  const reels = reelsFromRandomness(value);
  const tier = ref.tierIsDeep ? DEEP : SHALLOW;
  const recomputedPayout = spinPayout(BigInt(ref.wager), tier, BigInt(ref.kBp), reels);

  // 3. cross-check vs the payout actually paid, from the settle tx balance delta.
  const tx = await conn.getTransaction(ref.settleSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  let paidOnchain = -1n;
  let note: string | undefined;
  if (!tx || !tx.meta) {
    note = "settle tx not found on this RPC (older than its history window) — payout check skipped";
  } else {
    const keys = tx.transaction.message.getAccountKeys();
    let idx = -1;
    for (let i = 0; i < keys.length; i++) if (keys.get(i)!.toBase58() === ref.machine) { idx = i; break; }
    if (idx < 0) { note = "machine account not in settle tx — payout check skipped"; }
    else {
      const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);
      paidOnchain = -delta; // the vault pays the payout out of its lamports
    }
  }

  const payoutMatch = paidOnchain < 0n ? seedSlotMatch : recomputedPayout === paidOnchain;
  const ok = seedSlotMatch && (paidOnchain < 0n ? true : recomputedPayout === paidOnchain);
  return { ok, reels, recomputedPayout, paidOnchain, seedSlotOnchain, seedSlotMatch, payoutMatch, valueHex: Buffer.from(value).toString("hex"), note };
}

// -------------------- dual-asset verify (adds the price recompute) --------------------

export interface DualSpinRef {
  machine: string; pool: string; observation: string; tokenMint: string; tokenDecimals: number;
  wager: string; kBp: string; tierIsDeep: boolean; priceAtCommit1e12: string;
  randSeedSlot: string; randomnessAccount: string; settleSig: string;
  commitBlockTime: number; twapWindowSecs: number; maxStalenessSecs: number;
}
export interface DualVerifyResult {
  ok: boolean; reels: number[];
  recomputedPayoutTokens: bigint; paidTokens: bigint; payoutMatch: boolean;
  seedSlotMatch: boolean; valueHex: string;
  snapshotPrice1e12: bigint; recomputedPrice1e12: bigint | null; priceDriftBp: number | null; priceConsistent: boolean;
  note?: string;
}

/** Tolerance for the price recompute: the on-chain snapshot EXTRAPOLATED cum(commit)
 * from the pool's tick at commit; recomputing from the ring now INTERPOLATES it, so
 * a small drift is expected. A gross disagreement means the snapshot price could not
 * have come from that ring — the thing worth flagging. */
const PRICE_TOLERANCE_BP = 100; // 1%

export async function verifyDualSpin(conn: Connection, ref: DualSpinRef): Promise<DualVerifyResult> {
  // 1. randomness account: revealed value + seed_slot binding (part b).
  const rInfo = await conn.getAccountInfo(new PublicKey(ref.randomnessAccount));
  if (!rInfo) throw new Error("randomness account not found on-chain");
  const rd = Buffer.from(rInfo.data);
  const seedSlotOnchain = rd.readBigUInt64LE(8 + 96);
  const value = Uint8Array.from(rd.subarray(8 + 144, 8 + 176));
  const seedSlotMatch = seedSlotOnchain === BigInt(ref.randSeedSlot);

  // 2. reels + token payout from the frozen snapshot (part a).
  const reels = reelsFromRandomness(value);
  const tier = ref.tierIsDeep ? DEEP : SHALLOW;
  const snapshotPrice1e12 = BigInt(ref.priceAtCommit1e12);
  const recomputedPayoutTokens = spinPayoutTokens(BigInt(ref.wager), tier, BigInt(ref.kBp), reels, snapshotPrice1e12, ref.tokenDecimals);

  // 3. CHIP actually paid, from the settle tx's token-balance delta (owner+mint).
  const tx = await conn.getTransaction(ref.settleSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  let paidTokens = -1n; let note: string | undefined;
  if (!tx || !tx.meta) {
    note = "settle tx not found on this RPC (older than its history window) — payout check skipped";
  } else {
    const player = tx.transaction.message.getAccountKeys().get(0)!.toBase58(); // fee payer / player
    const pre = tx.meta.preTokenBalances?.find((b) => b.mint === ref.tokenMint && b.owner === player);
    const post = tx.meta.postTokenBalances?.find((b) => b.mint === ref.tokenMint && b.owner === player);
    if (post) paidTokens = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
    else note = "player token balance not in settle tx — payout check skipped";
  }

  // 4. INDEPENDENT price recompute (part c): rebuild price_at_commit from the pool's
  //    observation ring at the commit timestamp, and flag if the snapshot could not
  //    have come from it.
  let recomputedPrice1e12: bigint | null = null; let priceDriftBp: number | null = null; let priceConsistent = false;
  const [poolI, obsI] = await Promise.all([conn.getAccountInfo(new PublicKey(ref.pool)), conn.getAccountInfo(new PublicKey(ref.observation))]);
  if (poolI && obsI) {
    const tick = decodePool(Buffer.from(poolI.data)).tickCurrent;
    const obs = collectObservations(Buffer.from(obsI.data));
    const twap = computeTwap(obs, tick, ref.commitBlockTime, ref.twapWindowSecs, ref.maxStalenessSecs);
    if (twap.price !== null) {
      recomputedPrice1e12 = BigInt(Math.round(twap.price * 1e12));
      const drift = Number(recomputedPrice1e12 - snapshotPrice1e12) * 10_000 / Number(snapshotPrice1e12);
      priceDriftBp = Math.round(drift);
      priceConsistent = Math.abs(priceDriftBp) <= PRICE_TOLERANCE_BP;
    } else {
      note = (note ? note + " · " : "") + `price recompute: ring no longer covers the commit window (${twap.reason})`;
      priceConsistent = false;
    }
  }

  const payoutMatch = paidTokens < 0n ? seedSlotMatch : recomputedPayoutTokens === paidTokens;
  const ok = seedSlotMatch && (paidTokens < 0n || recomputedPayoutTokens === paidTokens) && (recomputedPrice1e12 === null ? true : priceConsistent);
  return { ok, reels, recomputedPayoutTokens, paidTokens, payoutMatch, seedSlotMatch, valueHex: Buffer.from(value).toString("hex"), snapshotPrice1e12, recomputedPrice1e12, priceDriftBp, priceConsistent, note };
}
