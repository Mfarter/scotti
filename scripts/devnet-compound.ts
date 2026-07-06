// H6c-1 live acceptance artifact: a real compound_epoch on devnet against the
// UPGRADED program — an SPL-mode LP position's earmarked SOL swapped into CHIP
// through the REAL Raydium CLMM swap_v2 CPI (WSOL wrap → swap → unwrap, all
// signed by the machine PDA), minted into shares at the pre-swap price. Sets the
// position to SPL mode, runs one dual spin to accrue SOL, earmarks it, waits for
// a fresh in-band CLMM TWAP, then cranks compound_epoch with the real swap
// accounts + an explicit ComputeBudget. Verifies EVERYTHING by independent
// recompute (machine SOL down by exactly the earmark, vault CHIP up by the swap
// output ≥ min_out, shares minted == compound_mint_shares at the pre-swap price).
import {
  PublicKey, TransactionInstruction, SystemProgram, ComputeBudgetProgram,
  VersionedTransaction, TransactionMessage, Keypair,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { asV0Tx, getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import BN from "bn.js";
import { Raydium, PoolUtils } from "@raydium-io/raydium-sdk-v2";
import {
  PROGRAM_ID, RPC, connection, loadWallet, ixDisc, u64, sleep, solscanTx, solscanAcct,
} from "./common.ts";
import {
  CLMM_POOL, OBSERVATION_STATE, CHIP_MINT, CLMM_PROGRAM_ID, AMM_CONFIG,
  POOL_VAULT_A_WSOL, POOL_VAULT_B_CHIP,
} from "./raydium-constants.ts";
import { decodePool } from "./layouts.ts";
import { collectObservations, computeTwap } from "./twap.ts";

const conn = connection();
const admin = loadWallet(); // HouseConfig admin + payer + LP owner + player + cranker

const TOKEN_2022_PID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const MEMO_PID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const EX_BITMAP = new PublicKey("4815Bgtf9ZFjDNPrrzfJywAyDFD5ussN6Cj5T41azwai");
const REWARD_MODE_SPL = 1;

const label = "dual-chip-1";
const machineId = Buffer.alloc(16); Buffer.from(label).copy(machineId);
const dmachine = PublicKey.findProgramAddressSync([Buffer.from("dual-machine"), machineId], PROGRAM_ID)[0];
const dlp = (o: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("dual-lp"), dmachine.toBuffer(), o.toBuffer()], PROGRAM_ID)[0];
const dspin = (p: PublicKey, n: bigint) => PublicKey.findProgramAddressSync([Buffer.from("dual-spin"), dmachine.toBuffer(), p.toBuffer(), u64(n)], PROGRAM_ID)[0];
const vault = getAssociatedTokenAddressSync(CHIP_MINT, dmachine, true);
const adminChip = getAssociatedTokenAddressSync(CHIP_MINT, admin.publicKey, true);
const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, dmachine, true); // machine PDA's WSOL ATA

const AM = (pubkey: PublicKey, s = false, w = false) => ({ pubkey, isSigner: s, isWritable: w });
const u128at = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

interface M { lamports: bigint; twapWin: number; staleMax: number; bandBp: number; tokenBalance: bigint; totalShares: bigint; divPool: bigint; earmarked: bigint; accPerShare: bigint; epoch: bigint; }
async function readMachine(): Promise<M> {
  const ai = (await conn.getAccountInfo(dmachine))!;
  const d = ai.data;
  const elen = d.readBigUInt64LE(225) === 0n ? 1350n : d.readBigUInt64LE(225);
  const slot = BigInt(await conn.getSlot("confirmed"));
  return {
    lamports: BigInt(ai.lamports),
    twapWin: d.readUInt32LE(233), staleMax: d.readUInt32LE(237), bandBp: d.readUInt16LE(241),
    tokenBalance: u128at(d, 253), divPool: d.readBigUInt64LE(293), totalShares: u128at(d, 301),
    accPerShare: u128at(d, 317), earmarked: d.readBigUInt64LE(333), epoch: slot / elen,
  };
}
interface P { shares: bigint; pendingShares: bigint; solDebt: bigint; rewardMode: number; earmarked: bigint; lastEpoch: bigint; }
async function readPos(): Promise<P | null> {
  const ai = await conn.getAccountInfo(dlp(admin.publicKey));
  if (!ai) return null;
  const d = ai.data;
  return {
    shares: u128at(d, 72), pendingShares: u128at(d, 88), solDebt: u128at(d, 112),
    rewardMode: d[128], earmarked: d.readBigUInt64LE(129), lastEpoch: d.readBigUInt64LE(137),
  };
}
const tokBal = (a: PublicKey) => conn.getTokenAccountBalance(a).then(r => BigInt(r.value.amount)).catch(() => 0n);

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], lbl: string): Promise<string> {
  const tx = await asV0Tx({ connection: conn, ixs, payer: admin.publicKey, signers, computeUnitPrice: 50_000, computeUnitLimitMultiple: 1.3 });
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${lbl} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${lbl} confirm timeout`);
}
// Manual v0 sender so we control the ComputeBudget explicitly (and can read the
// real CU consumed from the confirmed tx afterwards).
async function sendV0Manual(ixs: TransactionInstruction[], signers: Keypair[], lbl: string): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign(signers);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${lbl} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${lbl} confirm timeout`);
}

async function waitTwapLive(m: M): Promise<{ spot: number; twap: number; bandBp: number }> {
  for (let i = 0; i < 40; i++) {
    const [pb, ob, slot] = await Promise.all([conn.getAccountInfo(CLMM_POOL), conn.getAccountInfo(OBSERVATION_STATE), conn.getSlot()]);
    const now = (await conn.getBlockTime(slot))!;
    const pool = decodePool(pb!.data);
    const obs = collectObservations(ob!.data);
    const r = computeTwap(obs, pool.tickCurrent, now, m.twapWin, m.staleMax);
    const band = r.status === "LIVE" ? Math.round(Math.abs(pool.price - r.price!) / r.price! * 10000) : null;
    console.log(`  [${i}] spot ${pool.price.toFixed(2)} twap ${r.status === "LIVE" ? r.price!.toFixed(2) : "—"} fresh ${r.staleSecs}s band ${band ?? "—"}bp [${r.status}]`);
    if (r.status === "LIVE" && band !== null && band <= m.bandBp) return { spot: pool.price, twap: r.price!, bandBp: band };
    await sleep(8000);
  }
  throw new Error("TWAP never became LIVE+in-band — is the keeper running?");
}

async function main() {
  console.log("== H6c-1 live compound_epoch ==  machine", dmachine.toBase58());
  console.log("payer/cranker/LP", admin.publicKey.toBase58(), "balance", (await conn.getBalance(admin.publicKey)) / 1e9, "SOL");

  let pos = await readPos();
  if (!pos || pos.shares === 0n) throw new Error("admin has no LP position/shares on dual-chip-1 — run devnet-dual-spin first");

  let m = await readMachine();
  const needAccrual = pos.earmarked === 0n;
  if (!needAccrual) console.log(`\nposition already has ${pos.earmarked} lamports earmarked — skipping accrual, compounding it directly`);

  // 1) SPL reward mode (compound only touches SPL-mode earmarked SOL).
  if (needAccrual && pos.rewardMode !== REWARD_MODE_SPL) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID, data: Buffer.concat([ixDisc("set_reward_mode"), Buffer.from([REWARD_MODE_SPL])]),
      keys: [AM(dmachine, false, true), AM(dlp(admin.publicKey), false, true), AM(admin.publicKey, true, true)],
    });
    console.log("set_reward_mode(SPL) →", solscanTx(await sendV0([ix], [admin], "set_mode")));
  } else console.log("position already SPL mode");

  // 2-3) accrue SOL via one dual spin (the only path that credits div_pool_sol),
  //      then earmark it. Skipped entirely when SOL is already earmarked.
  if (needAccrual) {
    console.log("\nwaiting for a fresh CLMM TWAP before the accrual spin …");
    await waitTwapLive(m);

    const nonce = BigInt(Date.now() % 1_000_000);
    let wager = 2_000_000n; // 0.002 SOL; fall back to 0.001 if it exceeds max-bet
    const queue = await getDefaultDevnetQueue(RPC);
    const sbProgram = (queue as any).program;
    const rngKp = Keypair.generate();
    const [randomness, createIx] = await Randomness.create(sbProgram, rngKp, queue.pubkey, admin.publicKey);
    const commitIx = await randomness.commitIx(queue.pubkey, admin.publicKey);
    const spinCommitIx = (w: bigint) => new TransactionInstruction({
      programId: PROGRAM_ID, data: Buffer.concat([ixDisc("spin_commit_dual"), u64(w), u64(nonce)]),
      keys: [AM(dmachine, false, true), AM(dspin(admin.publicKey, nonce), false, true), AM(admin.publicKey, true, true),
        AM(randomness.pubkey), AM(CLMM_POOL), AM(OBSERVATION_STATE), AM(SystemProgram.programId)],
    });
    let commitSig: string;
    try { commitSig = await sendV0([createIx, commitIx, spinCommitIx(wager)], [admin, rngKp], "commit"); }
    catch (e) {
      if (!String(e).includes("BetExceedsMax") && !String(e).includes("0x")) throw e;
      console.log("  0.002 rejected, retrying at 0.001 SOL …");
      wager = 1_000_000n;
      commitSig = await sendV0([createIx, commitIx, spinCommitIx(wager)], [admin, rngKp], "commit");
    }
    console.log(`accrual spin_commit (${Number(wager) / 1e9} SOL) →`, solscanTx(commitSig));

    let revealIx: TransactionInstruction | null = null;
    for (let i = 0; i < 30; i++) {
      await sleep(4000);
      try { revealIx = await randomness.revealIx(admin.publicKey); break; }
      catch { if (i % 5 === 0) console.log(`  reveal not ready (${i}) …`); }
    }
    if (!revealIx) throw new Error("oracle never revealed");
    const spinSettleIx = new TransactionInstruction({
      programId: PROGRAM_ID, data: Buffer.concat([ixDisc("spin_settle_dual"), u64(nonce)]),
      keys: [AM(dmachine, false, true), AM(dspin(admin.publicKey, nonce), false, true), AM(admin.publicKey, false, true),
        AM(randomness.pubkey), AM(vault, false, true), AM(adminChip, false, true), AM(TOKEN_PROGRAM_ID),
        AM(admin.publicKey, true, true), AM(SystemProgram.programId)],
    });
    console.log("accrual spin_settle →", solscanTx(await sendV0([revealIx, spinSettleIx], [admin], "settle")));

    const earmarkIx = new TransactionInstruction({
      programId: PROGRAM_ID, data: ixDisc("earmark_sol"),
      keys: [AM(dmachine, false, true), AM(dlp(admin.publicKey), false, true), AM(admin.publicKey, true, true)],
    });
    console.log("earmark_sol →", solscanTx(await sendV0([earmarkIx], [admin], "earmark")));
  }

  pos = await readPos();
  m = await readMachine();
  const earmark = pos!.earmarked;
  console.log(`\nearmarked to compound: ${earmark} lamports (${Number(earmark) / 1e9} SOL); machine earmarked_sol ${m.earmarked}`);
  if (earmark === 0n) throw new Error("nothing earmarked — accrual/earmark did not produce pending SOL");

  // 4) fresh in-band TWAP for the compound swap itself.
  console.log("\nwaiting for a fresh in-band TWAP for the compound swap …");
  const px = await waitTwapLive(m);

  // 5) Raydium tick arrays for a WSOL→CHIP swap of `earmark` lamports. Retried:
  //    the public RPC + the running keeper make the SDK's multi-account fetch 429.
  console.log("\nloading Raydium route (tick arrays) for the swap …");
  const retry = async <T>(fn: () => Promise<T>, lbl: string): Promise<T> => {
    for (let i = 0; i < 8; i++) {
      try { return await fn(); }
      catch (e) { console.log(`  ${lbl} attempt ${i + 1} — ${String(e).slice(0, 60)}`); await sleep(3000 * (i + 1)); }
    }
    throw new Error(`${lbl} exhausted retries`);
  };
  const raydium = await Raydium.load({ connection: conn, owner: admin, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });
  const rd = await retry(() => raydium.clmm.getPoolInfoFromRpc(CLMM_POOL.toBase58()), "getPoolInfoFromRpc");
  const epochInfo = await retry(() => raydium.fetchEpochInfo(), "fetchEpochInfo");
  const outc = await PoolUtils.computeAmountOut({
    poolInfo: rd.computePoolInfo, tickArrayCache: rd.tickData[CLMM_POOL.toBase58()],
    baseMint: NATIVE_MINT, amountIn: new BN(earmark.toString()), slippage: 0.05, epochInfo,
    tickarrayBitmapExtension: (rd.computePoolInfo as any).exBitmapInfo,
  });
  const tickArrays: PublicKey[] = (outc.remainingAccounts as PublicKey[]).filter(a => !a.equals(EX_BITMAP));
  console.log("  tick arrays:", tickArrays.map(a => a.toBase58()).join(", "));
  console.log("  SDK est. amountOut:", outc.amountOut.amount.toString(), "min:", outc.minAmountOut.amount.toString());

  // 6) compound_epoch — 7 fixed accounts + the real swap set as remaining accounts
  //    (seam order), with an explicit ComputeBudget (swap CPI + wrap exceeds 200k).
  const remaining = [
    AM(admin.publicKey, true, true),          // [0] cranker: fronted the WSOL, reimbursed
    AM(NATIVE_MINT, false, false),            // [1] wsol_mint / input_vault_mint
    AM(wsolAta, false, true),                 // [2] machine PDA's WSOL ATA (funded by crank)
    AM(CLMM_PROGRAM_ID, false, false),        // [3] swap target (owner-checked)
    AM(AMM_CONFIG, false, false),             // [4]
    AM(CLMM_POOL, false, true),               // [5] pool_state
    AM(POOL_VAULT_A_WSOL, false, true),       // [6] input_vault (WSOL)
    AM(POOL_VAULT_B_CHIP, false, true),       // [7] output_vault (CHIP)
    AM(OBSERVATION_STATE, false, true),       // [8]
    AM(TOKEN_2022_PID, false, false),         // [9]
    AM(MEMO_PID, false, false),               // [10]
    AM(CHIP_MINT, false, false),              // [11] output_vault_mint
    AM(EX_BITMAP, false, true),               // [12] tickarray_bitmap_extension
    ...tickArrays.map(a => AM(a, false, true)), // [13..] tick arrays
  ];
  const compoundIx = new TransactionInstruction({
    programId: PROGRAM_ID, data: ixDisc("compound_epoch"),
    keys: [
      AM(dmachine, false, true),      // machine
      AM(dlp(admin.publicKey), false, true), // position
      AM(vault, false, true),         // token_vault
      AM(CLMM_POOL, false, false),    // price_pool
      AM(OBSERVATION_STATE, false, false), // price_observation
      AM(TOKEN_PROGRAM_ID),           // token_program
      AM(admin.publicKey, true, false), // cranker
      ...remaining,
    ],
  });

  // pre-swap snapshot for the recompute.
  const preLamports = m.lamports, preTokenBal = m.tokenBalance, preShares = m.totalShares;
  const preVault = await tokBal(vault);
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const cpIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
  // Front the WSOL for the machine PDA in the SAME tx, right before compound: the
  // machine can't be a system-transfer source, so the crank creates + funds +
  // sync_natives the machine's WSOL ATA with exactly `earmark`; the seam swaps it
  // and reimburses the crank out of the machine (machine delta == −earmark).
  const createWsolAta = createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, wsolAta, dmachine, NATIVE_MINT);
  const fundWsol = SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: wsolAta, lamports: earmark });
  const syncWsol = createSyncNativeInstruction(wsolAta);
  console.log("\ncompound_epoch → sending (CU limit 400k) …");
  const sig = await sendV0Manual([cuIx, cpIx, createWsolAta, fundWsol, syncWsol, compoundIx], [admin], "compound");
  console.log("compound_epoch →", solscanTx(sig));

  // 7) recompute verification.
  const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const cu = tx?.meta?.computeUnitsConsumed;
  const m2 = await readMachine();
  const pos2 = await readPos();
  const postVault = await tokBal(vault);
  const received = postVault - preVault;
  const dec = 9;
  const minOut = (() => {
    // min_out = value_at_twap × (1 − band): mirror the on-chain payout_tokens.
    const price1e12 = BigInt(Math.round(px.twap * 1e12));
    const valueAtTwap = (earmark * price1e12 * (10n ** BigInt(dec))) / (10n ** 12n) / (10n ** 9n);
    return valueAtTwap * BigInt(10000 - m.bandBp) / 10000n;
  })();
  const mintedExpected = (received * preShares) / preTokenBal; // compound_mint_shares (wide_mul_div)
  const mintedActual = m2.totalShares - preShares;
  const posSharesMinted = pos2!.shares - pos!.shares;

  console.log("\n================= RECOMPUTE =================");
  console.log(`measured CU consumed: ${cu}`);
  console.log(`\n[SOL] machine lamports: ${preLamports} → ${m2.lamports}  (Δ ${m2.lamports - preLamports})`);
  console.log(`      earmarked spent  : ${earmark}`);
  console.log(`      EXACT down-by-earmark: ${preLamports - m2.lamports === earmark ? "YES ✓" : "NO ✗ (Δ " + (preLamports - m2.lamports) + ")"}`);
  console.log(`      machine earmarked_sol ${m.earmarked} → ${m2.earmarked}  (cleared: ${m2.earmarked === m.earmarked - earmark ? "YES ✓" : "NO ✗"})`);
  console.log(`      position earmarked   ${pos!.earmarked} → ${pos2!.earmarked}  (cleared: ${pos2!.earmarked === 0n ? "YES ✓" : "NO ✗"})`);
  console.log(`\n[CHIP] vault: ${preVault} → ${postVault}  (received ${received})`);
  console.log(`       min_out (twap×(1−band)): ${minOut}`);
  console.log(`       received ≥ min_out: ${received >= minOut ? "YES ✓" : "NO ✗"}`);
  console.log(`       machine token_balance: ${preTokenBal} → ${m2.tokenBalance}  (== vault: ${m2.tokenBalance === postVault ? "YES ✓" : "NO ✗"})`);
  console.log(`       token_balance up by received: ${m2.tokenBalance - preTokenBal === received ? "YES ✓" : "NO ✗"}`);
  console.log(`\n[SHARES] compound_mint_shares(received ${received}, ts ${preShares}, tb ${preTokenBal}) = ${mintedExpected}`);
  console.log(`         machine total_shares minted: ${mintedActual}  (match: ${mintedActual === mintedExpected ? "YES ✓" : "NO ✗"})`);
  console.log(`         position shares minted:      ${posSharesMinted}  (match: ${posSharesMinted === mintedExpected ? "YES ✓" : "NO ✗"})`);
  console.log(`         position last_compound_epoch: ${pos!.lastEpoch} → ${pos2!.lastEpoch}`);

  const allOk = preLamports - m2.lamports === earmark && received >= minOut &&
    m2.tokenBalance === postVault && mintedActual === mintedExpected && posSharesMinted === mintedExpected &&
    pos2!.earmarked === 0n;
  console.log(`\nOVERALL: ${allOk ? "ALL CHECKS PASS ✓" : "SOME CHECK FAILED ✗"}`);

  // 8) ledger coherence read post-compound (position is SPL, so a read — not
  //    claim_sol — confirms the dividend ledger is consistent).
  console.log("\n--- post-compound ledger ---");
  console.log(`  div_pool_sol ${m2.divPool}  acc_sol_per_share ${m2.accPerShare}`);
  console.log(`  position: shares ${pos2!.shares} sol_debt ${pos2!.solDebt} earmarked ${pos2!.earmarked} mode ${pos2!.rewardMode}`);
  const pendingAfter = (() => {
    const earning = pos2!.shares + pos2!.pendingShares;
    const ent = (earning * m2.accPerShare) / (10n ** 24n);
    return ent > pos2!.solDebt ? ent - pos2!.solDebt : 0n;
  })();
  console.log(`  pending_sol now: ${pendingAfter} (0 expected right after earmark+compound)`);
  console.log("\nmachine", solscanAcct(dmachine));
  console.log("WSOL ATA (should be closed / 0):", solscanAcct(wsolAta));
  if (!allOk) process.exit(1);
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
