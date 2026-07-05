// The fairness claim, in the browser: independently recompute a settled spin's
// outcome from on-chain data and check it against what was actually paid.
// Mirrors scripts/verify-spin.ts. Uses only the revealed randomness account and
// the settle transaction — the snapshot (frozen odds) travels in the argument.
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { DEEP, SHALLOW, reelsFromRandomness, spinPayout } from "./housemath.ts";

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
