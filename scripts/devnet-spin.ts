// The artifact: one full live spin against Switchboard On-Demand randomness on
// devnet. A throwaway player creates + commits a randomness account and sends
// spin_commit (bundled, so seed_slot == commit_slot - 1), waits for the oracle
// reveal, then cranks reveal + spin_settle (bundled, so get_value lands this
// slot). Prints the reels, payout, exact pool_value delta, and Solscan URLs.
//
// Records the spin to scripts/spins/<settleSig>.json for verify-spin.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { Keypair, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { asV0Tx, getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import {
  PROGRAM_ID, SOL, connection, convergedSnapshot, decodeMachine, decodePendingSpin,
  ixDisc, loadWallet, machineId, machinePda, reelsFromRandomness, sleep, spinPayout,
  spinPda, SYMBOL_NAME, DEEP, SHALLOW, smoothedUpdate, kBoundsConst, kOfDepth, maxBet as maxBetFn,
  solscanTx, u64,
} from "./common.ts";

const conn = connection();
const wallet = loadWallet();
const LABEL = process.env.MACHINE_LABEL ?? "house-demo-1";
const id = machineId(LABEL);
const machine = machinePda(id);

async function currentSlot(): Promise<bigint> { return BigInt(await conn.getSlot("confirmed")); }
async function poolValue(): Promise<bigint> { return decodeMachine((await conn.getAccountInfo(machine))!.data).poolValue; }

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<string> {
  const tx = await asV0Tx({ connection: conn, ixs, payer: signers[0].publicKey, signers, computeUnitPrice: 50_000, computeUnitLimitMultiple: 1.3 });
  const sig = await conn.sendRawTransaction((tx as VersionedTransaction).serialize(), { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${label} confirmation timed out`);
}

// pick a wager safely under the max_bet at the depth the commit will read.
async function chooseWager(): Promise<bigint> {
  for (let i = 0; i < 40; i++) {
    const m = decodeMachine((await conn.getAccountInfo(machine))!.data);
    const slot = await currentSlot();
    const depth = smoothedUpdate(m.smoothedValue, m.smoothedLastSlot, m.poolValue, slot, m.smoothWindow);
    const isDeep = depth >= m.dMid;
    const tier = isDeep ? DEEP : SHALLOW;
    const [kMin, kMax] = kBoundsConst(isDeep);
    const k = kOfDepth(depth, m.dLow, m.dHigh, kMin, kMax);
    const mb = maxBetFn(depth, m.maxExposureBp, tier, k);
    if (mb >= 20_000n) {
      const w = mb / 2n;
      console.log(`  smoothed depth ≈ ${depth} lamports, tier ${tier.name}, k ${k}, max_bet ${mb} → wager ${w}`);
      return w;
    }
    console.log(`  waiting for smoothing to converge (max_bet ${mb} lamports, slot ${slot})...`);
    await sleep(5000);
  }
  throw new Error("max_bet stayed too small — is the machine seeded?");
}

// -------------------- run one spin --------------------

console.log(`\n=== live spin on "${LABEL}" (${machine.toBase58()}) ===`);
const queue = await getDefaultDevnetQueue(process.env.HOUSE_RPC ?? "https://api.devnet.solana.com");
const sbProgram = (queue as any).program;

// throwaway player, funded from the deploy wallet
const player = Keypair.generate();
console.log(`throwaway player: ${player.publicKey.toBase58()}`);
{
  const ix = SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: player.publicKey, lamports: Number(SOL / 20n) }); // 0.05 SOL
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const t = new Transaction().add(ix); t.recentBlockhash = blockhash; t.feePayer = wallet.publicKey; t.sign(wallet);
  const s = await conn.sendRawTransaction(t.serialize());
  for (let i = 0; i < 40; i++) { await sleep(1000); const st = (await conn.getSignatureStatus(s)).value; if (st?.err) throw new Error("fund failed"); if (st?.confirmationStatus) break; }
  console.log(`  funded 0.05 SOL`);
}

const wager = await chooseWager();
const nonce = BigInt(Date.now());
const spin = spinPda(machine, player.publicKey, nonce);

// --- commit phase: [createRandomness, commit, spin_commit] in one tx ---
const rngKp = Keypair.generate();
const [randomness, createIx] = await Randomness.create(sbProgram, rngKp, queue.pubkey, player.publicKey);
const commitIx = await randomness.commitIx(queue.pubkey, player.publicKey);
const spinCommitData = Buffer.concat([ixDisc("spin_commit"), u64(wager), u64(nonce)]);
const spinCommitIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: machine, isSigner: false, isWritable: true },
    { pubkey: spin, isSigner: false, isWritable: true },
    { pubkey: player.publicKey, isSigner: true, isWritable: true },
    { pubkey: randomness.pubkey, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: spinCommitData,
});

const poolBefore = await poolValue();
const commitSig = await sendV0([createIx, commitIx, spinCommitIx], [player, rngKp], "commit");
console.log(`  commit  → ${solscanTx(commitSig)}`);

// read the frozen snapshot from the PendingSpin (before settle closes it)
const snap = decodePendingSpin((await conn.getAccountInfo(spin))!.data);
const tier = snap.tierIsDeep ? DEEP : SHALLOW;
console.log(`  snapshot: k=${snap.kBp} tier=${tier.name} max_payout=${snap.maxPayout} seed_slot=${snap.randSeedSlot}`);

// --- reveal phase: poll the oracle, then [reveal, spin_settle] in one tx ---
let revealIx: TransactionInstruction | null = null;
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  try { revealIx = await randomness.revealIx(player.publicKey); break; }
  catch (e) { console.log(`  reveal not ready (attempt ${i + 1}) — ${(e as Error).message.slice(0, 80)}`); }
}
if (!revealIx) throw new Error("oracle never revealed within the polling window");

const spinSettleData = Buffer.concat([ixDisc("spin_settle"), u64(nonce)]);
const spinSettleIx = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: machine, isSigner: false, isWritable: true },
    { pubkey: spin, isSigner: false, isWritable: true },
    { pubkey: player.publicKey, isSigner: false, isWritable: true },
    { pubkey: randomness.pubkey, isSigner: false, isWritable: false },
    { pubkey: player.publicKey, isSigner: true, isWritable: true }, // cranker (permissionless)
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: spinSettleData,
});
const settleSig = await sendV0([revealIx, spinSettleIx], [player], "settle");
console.log(`  settle  → ${solscanTx(settleSig)}`);

// --- outcome: recompute from the revealed randomness + snapshot ---
const rdata = await randomness.loadData();
const value = Uint8Array.from(rdata.value as number[]);
const reels = reelsFromRandomness(value);
const payout = spinPayout(wager, tier, snap.kBp, reels);
const poolAfter = await poolValue();
const poolDelta = poolAfter - poolBefore;

console.log(`\n  RESULT`);
console.log(`  reels     : ${reels.map((s) => SYMBOL_NAME[s]).join(" | ")}`);
console.log(`  wager     : ${wager} lamports`);
console.log(`  payout    : ${payout} lamports  (${payout > wager ? "player win" : "house win"})`);
console.log(`  pool Δ    : ${poolDelta} lamports  (expected wager - payout = ${wager - payout})`);
if (poolDelta !== wager - payout) console.error(`  !! pool delta mismatch`);
else console.log(`  reconciled: pool_value moved by exactly wager - payout ✓`);

mkdirSync("spins", { recursive: true });
const record = {
  machine: machine.toBase58(), label: LABEL, player: player.publicKey.toBase58(),
  nonce: nonce.toString(), wager: wager.toString(),
  snapshot: { kBp: snap.kBp.toString(), tierIsDeep: snap.tierIsDeep, tier: tier.name, maxPayout: snap.maxPayout.toString(), randSeedSlot: snap.randSeedSlot.toString() },
  randomnessAccount: randomness.pubkey.toBase58(), revealedValueHex: Buffer.from(value).toString("hex"),
  reels: reels.map((s) => SYMBOL_NAME[s]), payout: payout.toString(),
  poolBefore: poolBefore.toString(), poolAfter: poolAfter.toString(),
  commitSig, settleSig,
  commitUrl: solscanTx(commitSig), settleUrl: solscanTx(settleSig),
};
writeFileSync(`spins/${settleSig}.json`, JSON.stringify(record, null, 2));
console.log(`  record    : scripts/spins/${settleSig}.json`);
