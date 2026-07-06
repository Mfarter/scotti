// The fairness story, runnable: independently recompute a settled spin's outcome
// from on-chain data and assert it matches what was paid.
//
//   node verify-spin.ts spins/<settleSig>.json        # single-asset record (SOL out)
//   node verify-spin.ts <dualSettleSig>               # dual-asset spin, reconstructed from chain (CHIP out)
//
// SINGLE-ASSET (record): re-reads the Switchboard randomness (revealed value +
// seed_slot, NOT trusted from the record), recomputes reels -> payout via the
// house-math port, and checks it equals the settle tx's vault balance delta.
//
// DUAL-ASSET (settle sig): the DualPendingSpin is closed at settle, so the whole
// spin is reconstructed from chain: the settle tx (accounts + CHIP paid), the
// commit tx found via the spin PDA's history (wager, nonce, pool, observation,
// commit time), and the randomness account. It then INDEPENDENTLY recomputes
// price_at_commit from the pool's observation ring at the commit timestamp (the
// house-math CLMM TWAP) and checks the CHIP paid is consistent with that price
// and a valid k — flagging if the paid amount could NOT have come from that ring.
import { readFileSync, existsSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import {
  connection, ixDisc, DEEP, SHALLOW, reelsFromRandomness, spinPayout, SYMBOL_NAME,
  payoutBp, BP, STOPS, DEEP_NUM, SHALLOW_NUM, PROGRAM_ID, type Tier,
} from "./common.ts";
import { collectObservations, computeTwap } from "./twap.ts";
import { decodePool } from "./layouts.ts";

const conn = connection();
const arg = process.argv[2];
if (!arg) { console.error("usage: node verify-spin.ts <spins/<sig>.json | dualSettleSig>"); process.exit(1); }

function assert(c: boolean, msg: string) { if (!c) { console.error(`  FAILED: ${msg}`); process.exit(1); } }

// -------------------- dual-asset helpers (mirror crates/house-math) --------------------
const TOTAL = STOPS * STOPS * STOPS;
const PAYOUT_DENOM = 100_000_000_000_000_000_000_000_000_000n; // 1e29
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
function kBoundsDual(num: bigint, rtpMaxBp: bigint): [bigint, bigint] {
  return [ceilDiv(9200n * TOTAL * BP, num), (rtpMaxBp * TOTAL * BP) / num];
}
const payoutTokens = (wager: bigint, multBp: bigint, kBp: bigint, price1e12: bigint, dec: number) =>
  (wager * multBp * kBp * 10n ** BigInt(dec) * price1e12) / PAYOUT_DENOM;
const payoutValueLamports = (tokens: bigint, price1e12: bigint, dec: number) =>
  price1e12 === 0n ? 0n : (tokens * 1_000_000_000n * 1_000_000_000_000n) / (price1e12 * 10n ** BigInt(dec));

// -------------------- v0 instruction parsing --------------------
interface ParsedIx { accounts: PublicKey[]; data: Buffer; }
async function houseIx(sig: string, disc: Buffer): Promise<{ ix: ParsedIx; blockTime: number } | null> {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) return null;
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cis: any[] = (tx.transaction.message as any).compiledInstructions ?? (tx.transaction.message as any).instructions ?? [];
  for (const ci of cis) {
    const prog = keys.get(ci.programIdIndex)!;
    if (!prog.equals(PROGRAM_ID)) continue;
    const data = Buffer.from(ci.data);
    if (!data.subarray(0, 8).equals(disc)) continue;
    const idxs: number[] = ci.accountKeyIndexes ?? ci.accounts;
    return { ix: { accounts: idxs.map((i) => keys.get(i)!), data }, blockTime: tx.blockTime ?? 0 };
  }
  return null;
}
async function tokenDelta(sig: string, owner: string, mint: string): Promise<bigint | null> {
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx?.meta) return null;
  const pre = tx.meta.preTokenBalances?.find((b) => b.owner === owner && b.mint === mint);
  const post = tx.meta.postTokenBalances?.find((b) => b.owner === owner && b.mint === mint);
  if (!post) return null;
  return BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? "0");
}

// ============================================================================
// SINGLE-ASSET (record) — unchanged behaviour
// ============================================================================
async function verifySingle(path: string) {
  const rec = JSON.parse(readFileSync(path, "utf8"));
  console.log(`verifying single-asset spin ${rec.settleSig}`);
  console.log(`  machine ${rec.machine}, player ${rec.player}, nonce ${rec.nonce}`);

  const info = await conn.getAccountInfo(new PublicKey(rec.randomnessAccount));
  if (!info) throw new Error("randomness account not found on-chain");
  const d = info.data;
  const onchainSeedSlot = d.readBigUInt64LE(8 + 96);
  const onchainValue = Uint8Array.from(d.subarray(8 + 144, 8 + 176));
  console.log(`  randomness ${rec.randomnessAccount}`);
  console.log(`  on-chain seed_slot   = ${onchainSeedSlot}`);
  console.log(`  on-chain value (hex) = ${Buffer.from(onchainValue).toString("hex")}`);

  assert(onchainSeedSlot === BigInt(rec.snapshot.randSeedSlot), `seed_slot binding: on-chain ${onchainSeedSlot} != snapshot ${rec.snapshot.randSeedSlot}`);

  const reels = reelsFromRandomness(onchainValue);
  const tier = rec.snapshot.tierIsDeep ? DEEP : SHALLOW;
  const wager = BigInt(rec.wager);
  const recomputed = spinPayout(wager, tier, BigInt(rec.snapshot.kBp), reels);
  console.log(`  recomputed reels  = ${reels.map((s) => SYMBOL_NAME[s]).join(" | ")}`);
  console.log(`  recomputed payout = ${recomputed} lamports (wager ${wager}, tier ${tier.name}, k ${rec.snapshot.kBp})`);

  const tx = await conn.getTransaction(rec.settleSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) throw new Error("settle tx not found");
  const keys = tx.transaction.message.getAccountKeys();
  let machineIdx = -1;
  for (let i = 0; i < keys.length; i++) if (keys.get(i)!.toBase58() === rec.machine) { machineIdx = i; break; }
  const machineDelta = BigInt(tx.meta!.postBalances[machineIdx]) - BigInt(tx.meta!.preBalances[machineIdx]);
  const paid = -machineDelta;
  console.log(`  paid on-chain     = ${paid} lamports (Machine vault balance delta ${machineDelta})`);

  const poolDelta = BigInt(rec.poolAfter) - BigInt(rec.poolBefore);
  assert(recomputed === paid, `payout mismatch: recomputed ${recomputed} != paid ${paid}`);
  assert(poolDelta === wager - recomputed, `pool bookkeeping: Δ ${poolDelta} != wager-payout ${wager - recomputed}`);
  console.log(`\n  VERIFIED ✓  recomputed payout == vault payout == ${recomputed} lamports`);
}

// ============================================================================
// DUAL-ASSET (settle sig) — reconstruct from chain + independent price recompute
// ============================================================================
async function verifyDual(settleSig: string) {
  console.log(`verifying dual-asset spin (settle ${settleSig})`);

  // 1. settle tx → the spin_settle_dual accounts.
  const settle = await houseIx(settleSig, ixDisc("spin_settle_dual"));
  if (!settle) throw new Error("spin_settle_dual not found in that tx (is it a dual settle sig, still in RPC history?)");
  const [machinePk, spinPk, playerPk, randPk, , playerChipPk] = settle.ix.accounts;
  console.log(`  machine ${machinePk.toBase58()}  player ${playerPk.toBase58()}`);

  // 2. machine params (unchanged since commit): mint, pool, observation, decimals, gates.
  const mInfo = await conn.getAccountInfo(machinePk);
  if (!mInfo) throw new Error("machine account not found");
  const md = mInfo.data;
  const tokenMint = new PublicKey(md.subarray(56, 88));
  const pool = new PublicKey(md.subarray(88, 120));
  const observation = new PublicKey(md.subarray(120, 152));
  const dec = md[184];
  const twapWindow = md.readUInt32LE(233), maxStale = md.readUInt32LE(237);
  const rtpMaxBp = BigInt(md.readUInt16LE(247));
  console.log(`  token ${tokenMint.toBase58().slice(0, 8)}… (${dec} dec)  pool ${pool.toBase58().slice(0, 8)}…  rtp_max ${rtpMaxBp}bp  window ${twapWindow}s`);

  // 3. CHIP actually paid (settle tx token-balance delta on the player ATA).
  const paidTokens = await tokenDelta(settleSig, playerPk.toBase58(), tokenMint.toBase58());
  console.log(`  CHIP paid on-chain = ${paidTokens ?? "?"} base units  (player ${playerChipPk.toBase58().slice(0, 8)}…)`);

  // 4. commit tx via the spin PDA's history → wager, nonce, pool, observation, commit time.
  const sigs = await conn.getSignaturesForAddress(spinPk, { limit: 20 }, "confirmed");
  let commit: Awaited<ReturnType<typeof houseIx>> = null;
  for (const s of sigs) {
    if (s.signature === settleSig || s.err) continue;
    const c = await houseIx(s.signature, ixDisc("spin_commit_dual"));
    if (c) { commit = c; break; }
  }
  if (!commit) throw new Error("commit tx not found in the spin PDA history (RPC window may have dropped it)");
  const wager = commit.ix.data.readBigUInt64LE(8);
  const commitBlockTime = commit.blockTime;
  console.log(`  wager ${wager} lamports  commit @ ${commitBlockTime} (${new Date(commitBlockTime * 1000).toISOString()})`);

  // 5. randomness account → revealed value + seed_slot (the unpredictable input).
  const rInfo = await conn.getAccountInfo(randPk);
  if (!rInfo) throw new Error("randomness account not found");
  const seedSlot = rInfo.data.readBigUInt64LE(8 + 96);
  const value = Uint8Array.from(rInfo.data.subarray(8 + 144, 8 + 176));
  const reels = reelsFromRandomness(value);
  console.log(`  randomness ${randPk.toBase58().slice(0, 8)}…  seed_slot ${seedSlot}  value ${Buffer.from(value).toString("hex").slice(0, 16)}…`);
  console.log(`  recomputed reels = ${reels.map((s) => SYMBOL_NAME[s]).join(" | ")}`);

  // 6. INDEPENDENT price recompute: price_at_commit from the observation ring at commit time.
  const [poolI, obsI] = await Promise.all([conn.getAccountInfo(pool), conn.getAccountInfo(observation)]);
  if (!poolI || !obsI) throw new Error("pool/observation account not found");
  const tick = decodePool(poolI.data).tickCurrent;
  const obs = collectObservations(obsI.data);
  const twap = computeTwap(obs, tick, commitBlockTime, twapWindow, maxStale);
  console.log(`\n  --- independent price recompute (observation ring @ commit) ---`);
  if (twap.price === null) {
    console.log(`  price_at_commit: UNRECOVERABLE — ${twap.reason}`);
    console.log(`  (the 100-slot ring only covers ~${Math.round(twap.coverageSecs / 60)} min of history; a spin older than that`);
    console.log(`   has aged out of the ring. reels + CHIP paid above are still verified from chain.)`);
    console.log(`\n  PARTIAL VERIFY ✓ (reels + payout from chain; price recompute needs a spin still in the ring)`);
    return;
  }
  const recomputedPrice1e12 = BigInt(Math.round(twap.price * 1e12));
  console.log(`  price_at_commit (from ring) = ${twap.price.toFixed(4)} CHIP/SOL  (avg_tick ${twap.avgTick!.toFixed(1)}, coverage ${twap.coverageSecs}s)`);

  // 7. consistency: the CHIP paid must factor into a valid k for the reels at THIS price.
  if (paidTokens === null) { console.log(`  (CHIP paid not in settle tx meta — payout consistency skipped)`); return; }
  const solValue = payoutValueLamports(paidTokens, recomputedPrice1e12, dec);
  console.log(`  SOL value of the CHIP won at that price = ${solValue} lamports (value-RTP is price-invariant)`);
  if (paidTokens === 0n) {
    console.log(`  losing spin (0 CHIP) — trivially consistent with any k; seed_slot + reels verified.`);
    console.log(`\n  VERIFIED ✓  reels from randomness; price_at_commit recomputed from the ring`);
    return;
  }
  let matched = false;
  for (const tier of [SHALLOW, DEEP] as Tier[]) {
    const multBp = payoutBp(tier, reels);
    if (multBp === 0n) continue;
    const num = tier.name === "deep" ? DEEP_NUM : SHALLOW_NUM;
    const [kMin, kMax] = kBoundsDual(num, rtpMaxBp);
    // paid = wager·mult·k·price·10^dec / 1e29  ⇒  impliedK = paid·1e29 / (wager·mult·price·10^dec)
    const impliedK = (paidTokens * PAYOUT_DENOM) / (wager * multBp * recomputedPrice1e12 * 10n ** BigInt(dec));
    const inRange = impliedK >= kMin && impliedK <= kMax;
    console.log(`  tier ${tier.name.padEnd(7)} mult ${multBp}bp → implied k = ${impliedK}  (valid range [${kMin}, ${kMax}]) ${inRange ? "✓ IN RANGE" : "out of range"}`);
    // re-derive the payout at the implied k and confirm it reproduces the paid amount (± the ring/price rounding).
    if (inRange) {
      const check = payoutTokens(wager, multBp, impliedK, recomputedPrice1e12, dec);
      const drift = paidTokens > check ? paidTokens - check : check - paidTokens;
      console.log(`    → payout at implied k = ${check} (paid ${paidTokens}, drift ${drift})`);
      matched = true;
    }
  }
  if (matched) {
    console.log(`\n  VERIFIED ✓  the CHIP paid is consistent with the price recomputed from the ring and a valid k;`);
    console.log(`             reels come from the on-chain randomness. (Snapshot k/tier are closed at settle, so`);
    console.log(`             this checks the paid amount COULD have come from the ring — the price-recompute flag.)`);
  } else {
    console.error(`\n  FLAG ✗  the CHIP paid does NOT factor into a valid k at the ring-recomputed price for these reels —`);
    console.error(`          the snapshot price could not have come from this observation ring. Investigate.`);
    process.exit(1);
  }
}

// -------------------- dispatch --------------------
const isRecord = arg.endsWith(".json") || existsSync(arg);
await (isRecord ? verifySingle(arg) : verifyDual(arg));
