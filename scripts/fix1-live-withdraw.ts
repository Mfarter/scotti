// FIX-1 live proof: the previously-reverting combined withdrawal, on dual-chip-1.
// A SOL-mode LP with an UNCLAIMED SOL dividend runs request_withdraw_token →
// (epoch wait) → process_withdrawal_token in ONE crank, receiving BOTH the token
// pro-rata AND the SOL dividend. Before FIX-1 this reverted (UnbalancedInstruction:
// dividend lamport surgery before the token CPI). Recompute-verified, exact.
//
//   node fix1-live-withdraw.ts        # full run (spin to accrue → request → wait → process)
//   node fix1-live-withdraw.ts process <requestSlot?>  # only the process step (resume)
import { PublicKey, TransactionInstruction, SystemProgram, Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { asV0Tx, getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import {
  PROGRAM_ID, RPC, connection, loadWallet, ixDisc, u64, u128, sleep, solscanTx,
  reelsFromRandomness, SYMBOL_NAME, SHALLOW, DEEP, payoutBp,
} from "./common.ts";
import { CLMM_POOL, OBSERVATION_STATE, CHIP_MINT } from "./raydium-constants.ts";
import { decodePool } from "./layouts.ts";
import { collectObservations, computeTwap } from "./twap.ts";

const conn = connection();
const admin = loadWallet();
const dec = 9;
const DENOM = 100_000_000_000_000_000_000_000_000_000n; // 1e29
const label = "dual-chip-1";
const machineId = Buffer.alloc(16); Buffer.from(label).copy(machineId);
const dmachine = PublicKey.findProgramAddressSync([Buffer.from("dual-machine"), machineId], PROGRAM_ID)[0];
const dlp = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("dual-lp"), dmachine.toBuffer(), o.toBuffer()], PROGRAM_ID)[0];
const dspin = (p: PublicKey, n: bigint) => PublicKey.findProgramAddressSync([Buffer.from("dual-spin"), dmachine.toBuffer(), p.toBuffer(), u64(n)], PROGRAM_ID)[0];
const vault = getAssociatedTokenAddressSync(CHIP_MINT, dmachine, true);
const adminChip = getAssociatedTokenAddressSync(CHIP_MINT, admin.publicKey, true);
const AM = (pubkey: PublicKey, s = false, w = false) => ({ pubkey, isSigner: s, isWritable: w });

const u64at = (d: Buffer, o: number) => d.readBigUInt64LE(o);
const u128at = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
const wideMulDiv = (a: bigint, b: bigint, den: bigint) => (a * b) / den; // JS BigInt is exact

async function readMachine() {
  const d = (await conn.getAccountInfo(dmachine))!.data;
  return {
    dec: d[184], epoch_length: u64at(d, 225), token_balance: u128at(d, 253), reserved_tokens: u128at(d, 269),
    div_pool_sol: u64at(d, 293), total_shares: u128at(d, 301), acc: u128at(d, 317), earmarked: u64at(d, 333),
  };
}
async function readLp() {
  const d = (await conn.getAccountInfo(dlp(admin.publicKey)))!.data;
  return {
    shares: u128at(d, 72), pending_shares: u128at(d, 88), pending_epoch: u64at(d, 104),
    sol_debt: u128at(d, 112), reward_mode: d[128], earmarked_sol: u64at(d, 129),
  };
}
const pendingDiv = (lp: Awaited<ReturnType<typeof readLp>>, acc: bigint) => {
  const ent = wideMulDiv(lp.shares + lp.pending_shares, acc, 10n ** 24n);
  return ent > lp.sol_debt ? ent - lp.sol_debt : 0n;
};
const tokBal = async (a: PublicKey) => BigInt((await conn.getTokenAccountBalance(a)).value.amount);

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], lbl: string): Promise<string> {
  const tx = await asV0Tx({ connection: conn, ixs, payer: admin.publicKey, signers, computeUnitPrice: 50_000, computeUnitLimitMultiple: 1.3 });
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${lbl} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${lbl} confirmation timed out`);
}

function payoutTokens(wager: bigint, multBp: bigint, kBp: bigint, price1e12: bigint): bigint {
  return (wager * multBp * kBp * 10n ** BigInt(dec) * price1e12) / DENOM;
}

async function ensureSolMode() {
  const lp = await readLp();
  if (lp.reward_mode === 0) { console.log("LP already in SOL reward mode"); return; }
  console.log("switching LP SPL → SOL reward mode (realizes current SPL pending as earmark) …");
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.concat([ixDisc("set_reward_mode"), Buffer.from([0])]),
    keys: [AM(dmachine, false, true), AM(dlp(admin.publicKey), false, true), AM(admin.publicKey, true, true)],
  });
  console.log("  set_reward_mode(SOL) →", solscanTx(await sendV0([ix], [admin], "set_reward_mode")));
}

async function waitTwapLive(): Promise<void> {
  console.log("waiting for a LIVE in-band CLMM TWAP (keeper up) …");
  for (let i = 0; i < 40; i++) {
    const [pb, ob, slot] = await Promise.all([conn.getAccountInfo(CLMM_POOL), conn.getAccountInfo(OBSERVATION_STATE), conn.getSlot()]);
    const now = (await conn.getBlockTime(slot))!;
    const pool = decodePool(pb!.data);
    const r = computeTwap(collectObservations(ob!.data), pool.tickCurrent, now, 300, 90);
    const band = r.status === "LIVE" ? Math.round(Math.abs(pool.price - r.price!) / r.price! * 10000) : null;
    console.log(`  [${i}] spot ${pool.price.toFixed(2)} twap ${r.status === "LIVE" ? r.price!.toFixed(2) : "—"} band ${band ?? "—"}bp [${r.status}]`);
    if (r.status === "LIVE" && band !== null && band <= 300) return;
    await sleep(8000);
  }
  throw new Error("TWAP never LIVE+in-band — is the keeper running?");
}

async function accrueViaSpin(): Promise<bigint> {
  await waitTwapLive();
  const nonce = BigInt(Date.now() % 1_000_000);
  const wager = 2_000_000n; // 0.002 SOL — accrues in full to the dividend ledger
  const queue = await getDefaultDevnetQueue(RPC);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbProgram = (queue as any).program;
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(sbProgram, rngKp, queue.pubkey, admin.publicKey);
  const commitIx = await randomness.commitIx(queue.pubkey, admin.publicKey);
  const spinCommitIx = new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.concat([ixDisc("spin_commit_dual"), u64(wager), u64(nonce)]),
    keys: [AM(dmachine, false, true), AM(dspin(admin.publicKey, nonce), false, true), AM(admin.publicKey, true, true),
           AM(randomness.pubkey), AM(CLMM_POOL), AM(OBSERVATION_STATE), AM(SystemProgram.programId)],
  });
  console.log("commit_dual →", solscanTx(await sendV0([createIx, commitIx, spinCommitIx], [admin, rngKp], "commit")));
  const s = (await conn.getAccountInfo(dspin(admin.publicKey, nonce)))!.data;
  const kBp = u128at(s, 88); const tierIsDeep = s[104] === 1; const price = u128at(s, 105);

  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) { await sleep(4000); try { revealIx = await randomness.revealIx(admin.publicKey); break; } catch { /* not ready */ } }
  if (!revealIx) throw new Error("oracle never revealed");
  const settleIx = new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.concat([ixDisc("spin_settle_dual"), u64(nonce)]),
    keys: [AM(dmachine, false, true), AM(dspin(admin.publicKey, nonce), false, true), AM(admin.publicKey, false, true),
           AM(randomness.pubkey), AM(vault, false, true), AM(adminChip, false, true), AM(TOKEN_PROGRAM_ID),
           AM(admin.publicKey, true, true), AM(SystemProgram.programId)],
  });
  console.log("settle_dual →", solscanTx(await sendV0([revealIx, settleIx], [admin], "settle")));
  const rdata = await randomness.loadData();
  const reels = reelsFromRandomness(Uint8Array.from(rdata.value as number[]));
  const mult = payoutBp(tierIsDeep ? DEEP : SHALLOW, reels);
  console.log(`  spin outcome ${reels.map(r => SYMBOL_NAME[r]).join(" · ")}  → wager ${wager} accrued to the dividend ledger (paid ${payoutTokens(wager, mult, kBp, price)} CHIP)`);
  return wager;
}

async function requestPartial(): Promise<bigint> {
  const lp = await readLp();
  const shares = lp.shares / 10n; // withdraw 10% — keeps the position open (earmark stays)
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.concat([ixDisc("request_withdraw_token"), u128(shares)]),
    keys: [AM(dmachine, false, false), AM(dlp(admin.publicKey), false, true), AM(admin.publicKey, true, false)],
  });
  console.log("request_withdraw_token (10%) →", solscanTx(await sendV0([ix], [admin], "request")));
  return shares;
}

async function waitEpoch(pendingEpoch: bigint, epochLen: bigint) {
  console.log(`waiting to cross the epoch boundary (pending_epoch ${pendingEpoch}, epoch_length ${epochLen} slots ≈ 9 min) …`);
  for (;;) {
    const slot = BigInt(await conn.getSlot("confirmed"));
    const ep = slot / epochLen;
    if (ep > pendingEpoch) { console.log(`  epoch ${ep} > ${pendingEpoch} — processable`); return; }
    process.stdout.write(`  slot ${slot} epoch ${ep} …\r`);
    await sleep(15000);
  }
}

async function processAndVerify() {
  // pre-state for the recompute.
  const m0 = await readMachine();
  const lp0 = await readLp();
  const div0 = pendingDiv(lp0, m0.acc);
  const free0 = m0.token_balance - m0.reserved_tokens;
  const freeShares = wideMulDiv(free0, m0.total_shares, m0.token_balance);
  const fill = lp0.pending_shares < freeShares ? lp0.pending_shares : freeShares;
  const expectTokens = wideMulDiv(fill, m0.token_balance, m0.total_shares);
  const expectSol = div0 < BigInt(m0.div_pool_sol) ? div0 : BigInt(m0.div_pool_sol);

  const chipBefore = await tokBal(adminChip);
  const machSolBefore = BigInt(await conn.getBalance(dmachine));
  const divPoolBefore = BigInt(m0.div_pool_sol);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID, data: ixDisc("process_withdrawal_token"),
    keys: [AM(dmachine, false, true), AM(dlp(admin.publicKey), false, true), AM(admin.publicKey, false, true),
           AM(vault, false, true), AM(adminChip, false, true), AM(TOKEN_PROGRAM_ID),
           AM(admin.publicKey, true, true), AM(SystemProgram.programId)],
  });
  const sig = await sendV0([ix], [admin], "process_withdrawal_token");
  console.log("\nprocess_withdrawal_token (ONE crank) →", solscanTx(sig));

  const chipAfter = await tokBal(adminChip);
  const m1 = await readMachine();
  const tokensPaid = chipAfter - chipBefore;
  const machSolPaid = machSolBefore - BigInt(await conn.getBalance(dmachine));
  const divDrained = divPoolBefore - BigInt(m1.div_pool_sol);

  console.log("\n=== RECOMPUTE (exact) ===");
  console.log(`  token pro-rata  expected ${expectTokens}  paid ${tokensPaid}  ${expectTokens === tokensPaid ? "✓" : "✗"}`);
  console.log(`  SOL dividend    expected ${expectSol}  div_pool drained ${divDrained}  machine SOL out ${machSolPaid}  ${expectSol === divDrained && divDrained === machSolPaid ? "✓" : "✗"}`);
  console.log(`  (token payout = fill_shares ${fill} × token_balance ÷ total_shares; SOL = whole-position pending dividend)`);
  const ok = expectTokens === tokensPaid && expectSol === divDrained && divDrained === machSolPaid;
  console.log(ok ? "\nVERIFIED ✓  combined both-asset withdrawal succeeded and reconciles to the base unit / lamport" : "\nMISMATCH ✗");
  if (!ok) process.exit(1);
  return sig;
}

async function main() {
  const mode = process.argv[2];
  console.log("machine", dmachine.toBase58(), "LP(admin)", admin.publicKey.toBase58());
  if (mode === "process") { await processAndVerify(); return; }

  await ensureSolMode();
  const wager = await accrueViaSpin();
  const lpAfterSpin = await readLp();
  const m = await readMachine();
  const div = pendingDiv(lpAfterSpin, m.acc);
  console.log(`accrued SOL-mode pending dividend: ${div} lamports (spin wager ${wager}); div_pool_sol ${m.div_pool_sol}`);
  if (div === 0n) throw new Error("no pending dividend accrued — cannot prove the combined path");

  await requestPartial();
  const lp = await readLp();
  await waitEpoch(lp.pending_epoch, m.epoch_length);
  await processAndVerify();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
