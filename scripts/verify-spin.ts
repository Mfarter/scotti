// The fairness story, runnable: independently recompute a settled spin's
// outcome from on-chain data and assert it matches what was paid.
//
//   node verify-spin.ts spins/<settleSig>.json
//
// Inputs used:
//   * the Switchboard randomness account (still on-chain) — the revealed 32
//     bytes and its seed_slot, re-read fresh (NOT trusted from the record);
//   * the Machine params (on-chain);
//   * the frozen snapshot (k, tier) the program stored at commit;
//   * the settle transaction's balance deltas — the payout actually paid.
// It recomputes reels -> payout via the house-math port and checks all three
// agree. The PendingSpin is closed at settle (rent reclaimed), so the snapshot
// travels in the record; every unpredictable input (the randomness) and the
// realized payout are taken straight from the chain.
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { connection, DEEP, SHALLOW, reelsFromRandomness, spinPayout, SYMBOL_NAME } from "./common.ts";

const path = process.argv[2];
if (!path) { console.error("usage: node verify-spin.ts spins/<settleSig>.json"); process.exit(1); }
const rec = JSON.parse(readFileSync(path, "utf8"));
const conn = connection();

console.log(`verifying spin ${rec.settleSig}`);
console.log(`  machine ${rec.machine}, player ${rec.player}, nonce ${rec.nonce}`);

// 1. re-read the randomness account from chain: revealed value + seed_slot.
const randAcct = new PublicKey(rec.randomnessAccount);
const info = await conn.getAccountInfo(randAcct);
if (!info) throw new Error("randomness account not found on-chain");
// RandomnessAccountData layout (after 8-byte disc): authority[32] queue[32]
// seed_slothash[32] seed_slot(u64@96) oracle[32] reveal_slot(u64@136) value[32@144]
const d = info.data;
const onchainSeedSlot = d.readBigUInt64LE(8 + 96);
const onchainValue = Uint8Array.from(d.subarray(8 + 144, 8 + 176));
console.log(`  randomness ${randAcct.toBase58()}`);
console.log(`  on-chain seed_slot   = ${onchainSeedSlot}`);
console.log(`  on-chain value (hex) = ${Buffer.from(onchainValue).toString("hex")}`);

// 2. the account must be the one bound at commit (seed_slot matches snapshot).
const snapSeedSlot = BigInt(rec.snapshot.randSeedSlot);
assert(onchainSeedSlot === snapSeedSlot, `seed_slot binding: on-chain ${onchainSeedSlot} != snapshot ${snapSeedSlot}`);

// 3. recompute reels + payout from the on-chain randomness and frozen snapshot.
const reels = reelsFromRandomness(onchainValue);
const tier = rec.snapshot.tierIsDeep ? DEEP : SHALLOW;
const k = BigInt(rec.snapshot.kBp);
const wager = BigInt(rec.wager);
const recomputed = spinPayout(wager, tier, k, reels);
console.log(`  recomputed reels  = ${reels.map((s) => SYMBOL_NAME[s]).join(" | ")}`);
console.log(`  recomputed payout = ${recomputed} lamports (wager ${wager}, tier ${tier.name}, k ${k})`);

// 4. cross-check against the payout ACTUALLY paid, from the settle tx meta.
const tx = await conn.getTransaction(rec.settleSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
if (!tx) throw new Error("settle tx not found");
const keys = tx.transaction.message.getAccountKeys();
const machineIdx = findKey(keys, rec.machine);
const machineDelta = BigInt(tx.meta!.postBalances[machineIdx]) - BigInt(tx.meta!.preBalances[machineIdx]);
// the vault (Machine PDA) pays the payout out of its lamports; on settle it
// receives nothing else, so -machineDelta == payout.
const paid = -machineDelta;
console.log(`  paid on-chain     = ${paid} lamports (Machine vault balance delta ${machineDelta})`);

// 5. and the recorded pool_value bookkeeping delta = wager - payout.
const poolDelta = BigInt(rec.poolAfter) - BigInt(rec.poolBefore);
assert(recomputed === paid, `payout mismatch: recomputed ${recomputed} != paid ${paid}`);
assert(poolDelta === wager - recomputed, `pool bookkeeping: Δ ${poolDelta} != wager-payout ${wager - recomputed}`);

console.log(`\n  VERIFIED ✓  recomputed payout == vault payout == ${recomputed} lamports`);
console.log(`  pool_value moved by wager - payout = ${poolDelta} lamports (house edge accrues to LPs)`);

function assert(c: boolean, msg: string) { if (!c) { console.error(`  FAILED: ${msg}`); process.exit(1); } }
function findKey(keys: any, b58: string): number {
  for (let i = 0; i < keys.length; i++) if (keys.get(i)!.toBase58() === b58) return i;
  throw new Error(`account ${b58} not in tx`);
}
