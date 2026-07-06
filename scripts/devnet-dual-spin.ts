// H6b-3 live artifact: a full dual-asset spin on devnet against the UPGRADED
// program — SOL wager in, CHIP paid out, priced by the REAL Raydium CLMM TWAP
// (the on-chain house-math::clmm reader), settled with real Switchboard On-Demand
// randomness. Creates the dual machine (if absent), deposits CHIP, waits for the
// keeper-freshened TWAP to pass the band/staleness gates, commits, settles,
// claims SOL dividends, and verifies the payout by independent recompute.
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { asV0Tx, getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import { Keypair } from "@solana/web3.js";
import {
  PROGRAM_ID, RPC, connection, loadWallet, configPda, ixDisc, u64, u128, sleep, solscanTx, solscanAcct,
  reelsFromRandomness, SYMBOL_NAME, STRIP, SHALLOW, DEEP, maxMultBp, payoutBp,
} from "./common.ts";
import { CLMM_POOL, OBSERVATION_STATE, CHIP_MINT } from "./raydium-constants.ts";
import { decodePool, decodeObs } from "./layouts.ts";
import { collectObservations, computeTwap } from "./twap.ts";

const conn = connection();
const admin = loadWallet(); // the HouseConfig admin + payer + LP + player + cranker (demo)
const CLMM_PID = new PublicKey("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
const BP = 10_000n, TOTAL = 32768n, DENOM = 100_000_000_000_000_000_000_000_000_000n; // 1e29
const dec = 9;

const label = "dual-chip-1";
const machineId = Buffer.alloc(16); Buffer.from(label).copy(machineId);
const dmachine = PublicKey.findProgramAddressSync([Buffer.from("dual-machine"), machineId], PROGRAM_ID)[0];
const dlp = (owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("dual-lp"), dmachine.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
const dspin = (player: PublicKey, nonce: bigint) => PublicKey.findProgramAddressSync([Buffer.from("dual-spin"), dmachine.toBuffer(), player.toBuffer(), u64(nonce)], PROGRAM_ID)[0];
const vault = getAssociatedTokenAddressSync(CHIP_MINT, dmachine, true);
const adminChip = getAssociatedTokenAddressSync(CHIP_MINT, admin.publicKey, true);

// dual params (margin-floor [92,95] / 300 / 200) — token-only depth, real CLMM price.
const params = {
  d_low: 1_000_000_000_000n, d_mid: 100_000_000_000_000n, d_high: 1_000_000_000_000_000n, // SHALLOW, k pins high
  max_exposure_bp: 100n, smooth_window: 9000n, epoch_length: 1350n,
  twap_window_secs: 60, max_staleness_secs: 180, band_bp: 300, m_bp: 200, haircut_bp: 1500,
  rtp_max_bp: 9500, max_pending_spins: 100,
};

function encodeDualParams(): Buffer {
  const p = params;
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
  return Buffer.concat([
    CLMM_POOL.toBuffer(), OBSERVATION_STATE.toBuffer(), Buffer.from([dec]),
    u64(p.d_low), u64(p.d_mid), u64(p.d_high), u64(p.max_exposure_bp), u64(p.smooth_window), u64(p.epoch_length),
    u32(p.twap_window_secs), u32(p.max_staleness_secs),
    u16(p.band_bp), u16(p.m_bp), u16(p.haircut_bp), u16(p.rtp_max_bp), u16(p.max_pending_spins),
  ]);
}
const AM = (pubkey: PublicKey, s = false, w = false) => ({ pubkey, isSigner: s, isWritable: w });

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = await asV0Tx({ connection: conn, ixs, payer: admin.publicKey, signers, computeUnitPrice: 50_000, computeUnitLimitMultiple: 1.3 });
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${label} confirm timeout`);
}
function tokBal(addr: PublicKey): Promise<bigint> {
  return conn.getTokenAccountBalance(addr).then(r => BigInt(r.value.amount)).catch(() => 0n);
}

// --- dual payout math (mirrors house-math payout.rs / k_bounds_dual) ---
function kBoundsDual(num: bigint, rtpMax: bigint): [bigint, bigint] {
  const kmin = (9200n * TOTAL * BP + num - 1n) / num; // ceil
  const kmax = (rtpMax * TOTAL * BP) / num;           // floor
  return [kmin, kmax];
}
function payoutTokens(wager: bigint, multBp: bigint, kBp: bigint, price1e12: bigint): bigint {
  const first = wager * multBp * kBp * (10n ** BigInt(dec));
  return (first * price1e12) / DENOM;
}

async function main() {
  console.log("== H6b-3 live dual spin ==  machine", dmachine.toBase58());
  console.log("payer/admin", admin.publicKey.toBase58(), "balance", (await conn.getBalance(admin.publicKey)) / 1e9, "SOL");

  // 1) create the dual machine if it doesn't exist yet.
  if (!(await conn.getAccountInfo(dmachine))) {
    const data = Buffer.concat([ixDisc("create_machine_dual"), machineId, encodeDualParams(), admin.publicKey.toBuffer()]);
    const ix = new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
      AM(configPda()), AM(dmachine, false, true), AM(CHIP_MINT), AM(vault, false, true),
      AM(admin.publicKey, true, true), AM(TOKEN_PROGRAM_ID), AM(ASSOCIATED_TOKEN_PROGRAM_ID), AM(SystemProgram.programId), AM(SYSVAR_RENT_PUBKEY),
    ]});
    console.log("create_machine_dual →", solscanTx(await sendV0([ix], [admin], "create")));
  } else console.log("machine exists — skipping create");

  // 2) deposit CHIP so the vault can pay + the curve has depth.
  const DEPOSIT = 20_000n * (10n ** BigInt(dec));
  if ((await tokBal(vault)) < DEPOSIT) {
    const data = Buffer.concat([ixDisc("lp_deposit_token"), u64(DEPOSIT)]);
    const ix = new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
      AM(dmachine, false, true), AM(dlp(admin.publicKey), false, true), AM(admin.publicKey, true, true),
      AM(adminChip, false, true), AM(vault, false, true), AM(TOKEN_PROGRAM_ID), AM(SystemProgram.programId),
    ]});
    console.log("lp_deposit_token →", solscanTx(await sendV0([ix], [admin], "deposit")), `(${DEPOSIT / (10n ** BigInt(dec))} CHIP)`);
  } else console.log("vault already funded — skipping deposit");

  // 3) wait for the keeper-freshened TWAP to be LIVE within the machine's window.
  console.log("\nwaiting for a fresh CLMM TWAP (window", params.twap_window_secs, "s, max_staleness", params.max_staleness_secs, "s) …");
  let twapReady = false;
  for (let i = 0; i < 40; i++) {
    const [pb, ob, slot] = await Promise.all([conn.getAccountInfo(CLMM_POOL), conn.getAccountInfo(OBSERVATION_STATE), conn.getSlot()]);
    const now = (await conn.getBlockTime(slot))!;
    const pool = decodePool(pb!.data);
    const obs = collectObservations(ob!.data);
    const r = computeTwap(obs, pool.tickCurrent, now, params.twap_window_secs, params.max_staleness_secs);
    const bandBp = r.status === "LIVE" ? Math.round(Math.abs(pool.price - r.price!) / r.price! * 10000) : null;
    console.log(`  [${i}] spot ${pool.price.toFixed(2)} twap ${r.status === "LIVE" ? r.price!.toFixed(2) : "—"} cov ${r.coverageSecs}s fresh ${r.staleSecs}s band ${bandBp ?? "—"}bp [${r.status}]`);
    if (r.status === "LIVE" && bandBp !== null && bandBp <= params.band_bp) { twapReady = true; break; }
    await sleep(8000);
  }
  if (!twapReady) throw new Error("TWAP never became LIVE+in-band — is the keeper running?");

  // ensure the player CHIP ATA exists (settle pays into it). admin is the player.
  const playerChip = adminChip;

  // 4) commit phase: [createRandomness, commit, spin_commit_dual] in one tx.
  const nonce = BigInt(Date.now() % 1_000_000);
  const wager = 1_000_000n; // 0.001 SOL
  const queue = await getDefaultDevnetQueue(RPC);
  const sbProgram = (queue as any).program;
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(sbProgram, rngKp, queue.pubkey, admin.publicKey);
  const commitIx = await randomness.commitIx(queue.pubkey, admin.publicKey);
  const spinCommitData = Buffer.concat([ixDisc("spin_commit_dual"), u64(wager), u64(nonce)]);
  const spinCommitIx = new TransactionInstruction({ programId: PROGRAM_ID, data: spinCommitData, keys: [
    AM(dmachine, false, true), AM(dspin(admin.publicKey, nonce), false, true), AM(admin.publicKey, true, true),
    AM(randomness.pubkey), AM(CLMM_POOL), AM(OBSERVATION_STATE), AM(SystemProgram.programId),
  ]});
  const commitSig = await sendV0([createIx, commitIx, spinCommitIx], [admin, rngKp], "commit");
  console.log("\ncommit_dual →", solscanTx(commitSig));

  // read the snapshot the program stored.
  const snap = await conn.getAccountInfo(dspin(admin.publicKey, nonce));
  const s = snap!.data;
  // DualPendingSpin: machine@8, player@40, nonce@72, wager@80, k_bp@88(u128),
  // tier_is_deep@104, price_at_commit_1e12@105(u128).
  const kBp = s.readBigUInt64LE(88) + (s.readBigUInt64LE(96) << 64n);
  const tierIsDeep = s[104] === 1;
  const priceAtCommit = s.readBigUInt64LE(105) + (s.readBigUInt64LE(113) << 64n);
  console.log(`  snapshot: price_at_commit ${(Number(priceAtCommit) / 1e12).toFixed(4)} CHIP/SOL, k ${kBp}, tier ${tierIsDeep ? "DEEP" : "SHALLOW"}`);

  // 5) reveal + settle: poll the oracle, then [reveal, spin_settle_dual] in one tx.
  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    try { revealIx = await randomness.revealIx(admin.publicKey); break; }
    catch (e) { if (i % 5 === 0) console.log(`  reveal not ready (${i}) — ${(e as Error).message.slice(0, 60)}`); }
  }
  if (!revealIx) throw new Error("oracle never revealed");
  const chipBefore = await tokBal(playerChip);
  const settleData = Buffer.concat([ixDisc("spin_settle_dual"), u64(nonce)]);
  const spinSettleIx = new TransactionInstruction({ programId: PROGRAM_ID, data: settleData, keys: [
    AM(dmachine, false, true), AM(dspin(admin.publicKey, nonce), false, true), AM(admin.publicKey, false, true),
    AM(randomness.pubkey), AM(vault, false, true), AM(playerChip, false, true), AM(TOKEN_PROGRAM_ID),
    AM(admin.publicKey, true, true), AM(SystemProgram.programId),
  ]});
  const settleSig = await sendV0([revealIx, spinSettleIx], [admin], "settle");
  console.log("settle_dual →", solscanTx(settleSig));

  // 6) outcome + INDEPENDENT recompute.
  const rdata = await randomness.loadData();
  const value = Uint8Array.from(rdata.value as number[]);
  const reels = reelsFromRandomness(value);
  const tier = tierIsDeep ? DEEP : SHALLOW;
  const multBp = payoutBp(tier, reels);
  const predicted = payoutTokens(wager, multBp, kBp, priceAtCommit);
  const chipAfter = await tokBal(playerChip);
  const paid = chipAfter - chipBefore;
  console.log(`\noutcome: ${reels.map(r => SYMBOL_NAME[r]).join(" · ")}  mult ${multBp}bp`);
  console.log(`  recompute payout (snapshot price + committed k): ${predicted} base units`);
  console.log(`  CHIP actually paid to player:                    ${paid} base units`);
  console.log(`  match: ${predicted === paid ? "YES ✓" : "NO ✗"}`);

  // 7) claim SOL dividends (the settled wager accrued to the ledger).
  const claimData = ixDisc("claim_sol");
  const claimIx = new TransactionInstruction({ programId: PROGRAM_ID, data: claimData, keys: [
    AM(dmachine, false, true), AM(dlp(admin.publicKey), false, true), AM(admin.publicKey, true, true),
  ]});
  console.log("claim_sol →", solscanTx(await sendV0([claimIx], [admin], "claim")));

  console.log("\nfinal balance", (await conn.getBalance(admin.publicKey)) / 1e9, "SOL");
  console.log("machine", solscanAcct(dmachine));
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
