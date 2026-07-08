// VAULT-1 live proof: a SECOND dual vault created PERMISSIONLESSLY from a
// NON-authority throwaway wallet, against the CHIP/WSOL pool as a 1-pool SET,
// then deposited, spun once (SOL in / CHIP out, priced by the on-chain median of
// the set — here one pool), and verified by independent recompute. Also reads
// dual-chip-1 to confirm the upgrade left the legacy single-pool vault untouched.
//
// Mirrors devnet-dual-spin.ts, but: (a) the creator/player is a fresh keypair
// funded from admin (proving permissionlessness), and (b) create uses the new
// `create_vault` with a PoolSet companion PDA + `spin_commit_dual` carries the
// pool_set account in remaining_accounts so the aggregator path runs on-chain.
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction,
} from "@solana/spl-token";
import { asV0Tx, getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import {
  PROGRAM_ID, RPC, connection, loadWallet, ixDisc, u64, sleep, solscanTx, solscanAcct,
  reelsFromRandomness, SYMBOL_NAME, SHALLOW, DEEP, payoutBp,
} from "./common.ts";
import { CLMM_POOL, OBSERVATION_STATE, CHIP_MINT } from "./raydium-constants.ts";
import { decodePool, decodeObs } from "./layouts.ts";
import { collectObservations, computeTwap } from "./twap.ts";

const conn = connection();
const admin = loadWallet(); // funds the throwaway + supplies CHIP; NOT the vault authority
const BP = 10_000n, TOTAL = 32768n, DENOM = 100_000_000_000_000_000_000_000_000_000n;
const dec = 9;
const AM = (pubkey: PublicKey, s = false, w = false) => ({ pubkey, isSigner: s, isWritable: w });

// a distinct 16-byte vault id for the permissionless vault.
const label = "vault-set-1";
const machineId = Buffer.alloc(16); Buffer.from(label).copy(machineId);
const dmachine = PublicKey.findProgramAddressSync([Buffer.from("dual-machine"), machineId], PROGRAM_ID)[0];
const poolSetPda = PublicKey.findProgramAddressSync([Buffer.from("pool-set"), dmachine.toBuffer()], PROGRAM_ID)[0];
const dlp = (owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("dual-lp"), dmachine.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
const dspin = (player: PublicKey, nonce: bigint) => PublicKey.findProgramAddressSync([Buffer.from("dual-spin"), dmachine.toBuffer(), player.toBuffer(), u64(nonce)], PROGRAM_ID)[0];
const vault = getAssociatedTokenAddressSync(CHIP_MINT, dmachine, true);

const params = {
  d_low: 1_000_000_000_000n, d_mid: 100_000_000_000_000n, d_high: 1_000_000_000_000_000n,
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

async function sendV0(ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[], lbl: string): Promise<string> {
  const tx = await asV0Tx({ connection: conn, ixs, payer: payer.publicKey, signers, computeUnitPrice: 50_000, computeUnitLimitMultiple: 1.3 });
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${lbl} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${lbl} confirm timeout`);
}
const tokBal = (a: PublicKey) => conn.getTokenAccountBalance(a).then(r => BigInt(r.value.amount)).catch(() => 0n);
function kBoundsDual(num: bigint, rtpMax: bigint): [bigint, bigint] {
  return [(9200n * TOTAL * BP + num - 1n) / num, (rtpMax * TOTAL * BP) / num];
}
function payoutTokens(wager: bigint, multBp: bigint, kBp: bigint, price1e12: bigint): bigint {
  return (wager * multBp * kBp * (10n ** BigInt(dec)) * price1e12) / DENOM;
}

async function main() {
  console.log("== VAULT-1 permissionless live proof ==");
  console.log("program", PROGRAM_ID.toBase58());
  console.log("admin (funder, NOT vault authority)", admin.publicKey.toBase58());

  // 0) read dual-chip-1 BEFORE — confirm the legacy vault survived the upgrade.
  const legacyId = Buffer.alloc(16); Buffer.from("dual-chip-1").copy(legacyId);
  const legacyPda = PublicKey.findProgramAddressSync([Buffer.from("dual-machine"), legacyId], PROGRAM_ID)[0];
  const legBefore = await conn.getAccountInfo(legacyPda);
  if (!legBefore) throw new Error("dual-chip-1 missing after upgrade!");
  // pool_set_len is the byte right after withdraw_snapshot_epoch; for a legacy
  // account it MUST be 0 (single-pool path). Its offset = SIZE - reserved(15) - 1.
  const legLen = legBefore.data.length;
  const legPoolSetLen = legBefore.data[legLen - 18]; // 15 reserved + this byte
  console.log(`\ndual-chip-1: ${legLen} bytes, pool_set_len=${legPoolSetLen} (0 ⇒ legacy single-pool, untouched)`);
  if (legLen !== 409 || legPoolSetLen !== 0) throw new Error(`dual-chip-1 layout changed! len=${legLen} pool_set_len=${legPoolSetLen}`);

  // 1) a FRESH throwaway wallet — the permissionless creator/curator/LP/player.
  const creator = Keypair.generate();
  console.log("\nthrowaway creator/player:", creator.publicKey.toBase58());
  const creatorChip = getAssociatedTokenAddressSync(CHIP_MINT, creator.publicKey, true);
  const adminChip = getAssociatedTokenAddressSync(CHIP_MINT, admin.publicKey, true);

  // fund it with SOL (rent + wager + fees) and CHIP (to deposit) from admin.
  const CHIP_SEED = 25_000n * (10n ** BigInt(dec));
  const fundIxs = [
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: creator.publicKey, lamports: 500_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, creatorChip, creator.publicKey, CHIP_MINT),
    createTransferInstruction(adminChip, creatorChip, admin.publicKey, CHIP_SEED),
  ];
  console.log("fund throwaway (0.5 SOL + 25,000 CHIP) →", solscanTx(await sendV0(fundIxs, admin, [admin], "fund")));

  // 2) PERMISSIONLESS create_vault — signed + paid by the throwaway, NO admin/config.
  if (!(await conn.getAccountInfo(dmachine))) {
    const data = Buffer.concat([ixDisc("create_vault"), machineId, encodeDualParams(), Buffer.from([1])]); // set_len = 1
    const ix = new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
      AM(dmachine, false, true), AM(poolSetPda, false, true), AM(CHIP_MINT), AM(vault, false, true),
      AM(creator.publicKey, true, true), AM(TOKEN_PROGRAM_ID), AM(ASSOCIATED_TOKEN_PROGRAM_ID),
      AM(SystemProgram.programId), AM(SYSVAR_RENT_PUBKEY),
      AM(CLMM_POOL), AM(OBSERVATION_STATE), // set member 0 (pool, observation)
    ]});
    console.log("create_vault (permissionless, 1-pool set) →", solscanTx(await sendV0([ix], creator, [creator], "create_vault")));
  } else console.log("vault exists — skipping create");
  console.log("  vault machine:", solscanAcct(dmachine));
  console.log("  pool set PDA :", solscanAcct(poolSetPda));

  // 3) deposit CHIP from the throwaway.
  const DEPOSIT = 20_000n * (10n ** BigInt(dec));
  if ((await tokBal(vault)) < DEPOSIT) {
    const data = Buffer.concat([ixDisc("lp_deposit_token"), u64(DEPOSIT)]);
    const ix = new TransactionInstruction({ programId: PROGRAM_ID, data, keys: [
      AM(dmachine, false, true), AM(dlp(creator.publicKey), false, true), AM(creator.publicKey, true, true),
      AM(creatorChip, false, true), AM(vault, false, true), AM(TOKEN_PROGRAM_ID), AM(SystemProgram.programId),
    ]});
    console.log("lp_deposit_token →", solscanTx(await sendV0([ix], creator, [creator], "deposit")), `(20,000 CHIP)`);
  } else console.log("vault already funded — skipping deposit");

  // 4) wait for a keeper-freshened, in-band TWAP.
  console.log("\nwaiting for a fresh CLMM TWAP (window", params.twap_window_secs, "s) …");
  let ok = false;
  for (let i = 0; i < 40; i++) {
    const [pb, ob, slot] = await Promise.all([conn.getAccountInfo(CLMM_POOL), conn.getAccountInfo(OBSERVATION_STATE), conn.getSlot()]);
    const now = (await conn.getBlockTime(slot))!;
    const pool = decodePool(pb!.data);
    const r = computeTwap(collectObservations(ob!.data), pool.tickCurrent, now, params.twap_window_secs, params.max_staleness_secs);
    const band = r.status === "LIVE" ? Math.round(Math.abs(pool.price - r.price!) / r.price! * 10000) : null;
    console.log(`  [${i}] spot ${pool.price.toFixed(2)} twap ${r.status === "LIVE" ? r.price!.toFixed(2) : "—"} fresh ${r.staleSecs}s band ${band ?? "—"}bp [${r.status}]`);
    if (r.status === "LIVE" && band !== null && band <= params.band_bp) { ok = true; break; }
    await sleep(8000);
  }
  if (!ok) throw new Error("TWAP never became LIVE+in-band — is the keeper running?");

  // 5) commit — Switchboard randomness + spin_commit_dual with the pool_set in remaining_accounts.
  const nonce = BigInt(Date.now() % 1_000_000);
  const wager = 1_000_000n; // 0.001 SOL
  const queue = await getDefaultDevnetQueue(RPC);
  const sbProgram = (queue as any).program;
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(sbProgram, rngKp, queue.pubkey, creator.publicKey);
  const commitIx = await randomness.commitIx(queue.pubkey, creator.publicKey);
  const spinCommitData = Buffer.concat([ixDisc("spin_commit_dual"), u64(wager), u64(nonce)]);
  const spinCommitIx = new TransactionInstruction({ programId: PROGRAM_ID, data: spinCommitData, keys: [
    AM(dmachine, false, true), AM(dspin(creator.publicKey, nonce), false, true), AM(creator.publicKey, true, true),
    AM(randomness.pubkey), AM(CLMM_POOL), AM(OBSERVATION_STATE), AM(SystemProgram.programId),
    AM(poolSetPda), // remaining[0]: the pool set (aggregator reads member 0 from the named accounts)
  ]});
  console.log("\ncommit_dual (pool-set path) →", solscanTx(await sendV0([createIx, commitIx, spinCommitIx], creator, [creator, rngKp], "commit")));

  const s = (await conn.getAccountInfo(dspin(creator.publicKey, nonce)))!.data;
  const kBp = s.readBigUInt64LE(88) + (s.readBigUInt64LE(96) << 64n);
  const tierIsDeep = s[104] === 1;
  const priceAtCommit = s.readBigUInt64LE(105) + (s.readBigUInt64LE(113) << 64n);
  console.log(`  snapshot: price_at_commit ${(Number(priceAtCommit) / 1e12).toFixed(4)} CHIP/SOL, k ${kBp}, tier ${tierIsDeep ? "DEEP" : "SHALLOW"}`);

  // 6) reveal + settle.
  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    try { revealIx = await randomness.revealIx(creator.publicKey); break; }
    catch (e) { if (i % 5 === 0) console.log(`  reveal not ready (${i})`); }
  }
  if (!revealIx) throw new Error("oracle never revealed");
  const before = await tokBal(creatorChip);
  const settleData = Buffer.concat([ixDisc("spin_settle_dual"), u64(nonce)]);
  const spinSettleIx = new TransactionInstruction({ programId: PROGRAM_ID, data: settleData, keys: [
    AM(dmachine, false, true), AM(dspin(creator.publicKey, nonce), false, true), AM(creator.publicKey, false, true),
    AM(randomness.pubkey), AM(vault, false, true), AM(creatorChip, false, true), AM(TOKEN_PROGRAM_ID),
    AM(creator.publicKey, true, true), AM(SystemProgram.programId),
  ]});
  console.log("settle_dual →", solscanTx(await sendV0([revealIx, spinSettleIx], creator, [creator], "settle")));

  // 7) INDEPENDENT recompute.
  const value = Uint8Array.from((await randomness.loadData()).value as number[]);
  const reels = reelsFromRandomness(value);
  const tier = tierIsDeep ? DEEP : SHALLOW;
  const multBp = payoutBp(tier, reels);
  const predicted = payoutTokens(wager, multBp, kBp, priceAtCommit);
  const paid = (await tokBal(creatorChip)) - before;
  console.log(`\noutcome: ${reels.map(r => SYMBOL_NAME[r]).join(" · ")}  mult ${multBp}bp`);
  console.log(`  recompute (snapshot price + committed k): ${predicted} base units`);
  console.log(`  CHIP actually paid:                       ${paid} base units`);
  console.log(`  recompute match: ${predicted === paid ? "YES ✓" : "NO ✗"}`);

  // 8) confirm dual-chip-1 STILL reads identically (post-spin).
  const legAfter = await conn.getAccountInfo(legacyPda);
  const legLenAfter = legAfter!.data.length;
  const legPoolSetLenAfter = legAfter!.data[legLenAfter - 18];
  const unchanged = legLenAfter === 409 && legPoolSetLenAfter === 0 && Buffer.compare(legBefore.data, legAfter!.data) === 0;
  console.log(`\ndual-chip-1 after: ${legLenAfter} bytes, pool_set_len=${legPoolSetLenAfter}, byte-identical=${unchanged ? "YES ✓" : "NO ✗"}`);

  console.log("\n== SUMMARY ==");
  console.log("new vault:", dmachine.toBase58());
  console.log("pool set :", poolSetPda.toBase58());
  console.log("creator  :", creator.publicKey.toBase58(), "(non-authority)");
  console.log("recompute:", predicted === paid ? "VERIFIED" : "MISMATCH");
  console.log("dual-chip-1 unaffected:", unchanged ? "YES" : "NO");
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
