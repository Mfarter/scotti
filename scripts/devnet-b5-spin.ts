// KEEP-0 live proof: ONE dual spin on the USER-LAUNCHED B5 vault (created via the
// launch wizard as a 1-pool-set vault), priced by the REAL Raydium CLMM TWAP of
// the B5/WSOL pool the wizard registered. SOL wager in, B5 paid out, settled with
// real Switchboard On-Demand randomness, and the payout INDEPENDENTLY recomputed.
//
// This is the acceptance artifact for KEEP-0: it proves a user vault kept fresh by
// `keeper.ts --pool <its pool>` reaches a LIVE aggregated price and settles. The
// vault is a 1-pool set, so the aggregate median == that single pool's TWAP; the
// commit passes the pool-set PDA as the sole remaining account.
//
// Unlike devnet-dual-spin.ts this creates NOTHING — the machine/vault already
// exist on-chain (the user launched them). It reads the machine and its params
// straight from chain and errors loudly if anything is missing.
import { PublicKey, TransactionInstruction, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { asV0Tx, getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import { Keypair } from "@solana/web3.js";
import {
  PROGRAM_ID, RPC, connection, loadWallet, ixDisc, u64, sleep, solscanTx, solscanAcct,
  reelsFromRandomness, SYMBOL_NAME, SHALLOW, DEEP, payoutBp,
} from "./common.ts";
import { decodePool } from "./layouts.ts";
import { collectObservations, computeTwap } from "./twap.ts";

const conn = connection();
const admin = loadWallet(); // wizard-launcher = payer = player = cranker (demo)
const BP = 10_000n, TOTAL = 32768n, DENOM = 100_000_000_000_000_000_000_000_000_000n; // 1e29
const B5_MINT = new PublicKey("B5tR8TzoeWoXzYWEgtCq73PFQWV4dvRfhTVVzmwWqJDw");

const mintRegistryPda = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("mint-vault"), mint.toBuffer()], PROGRAM_ID)[0];
const poolSetPda = (machine: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("pool-set"), machine.toBuffer()], PROGRAM_ID)[0];
const dspin = (machine: PublicKey, player: PublicKey, nonce: bigint) => PublicKey.findProgramAddressSync([Buffer.from("dual-spin"), machine.toBuffer(), player.toBuffer(), u64(nonce)], PROGRAM_ID)[0];
const AM = (pubkey: PublicKey, s = false, w = false) => ({ pubkey, isSigner: s, isWritable: w });

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<string> {
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
const tokBal = (addr: PublicKey) => conn.getTokenAccountBalance(addr).then(r => BigInt(r.value.amount)).catch(() => 0n);

function payoutTokens(wager: bigint, multBp: bigint, kBp: bigint, price1e12: bigint, dec: number): bigint {
  const first = wager * multBp * kBp * (10n ** BigInt(dec));
  return (first * price1e12) / DENOM;
}

async function main() {
  // 0) resolve the user's B5 vault from the one-vault-per-mint registry.
  const reg = await conn.getAccountInfo(mintRegistryPda(B5_MINT));
  if (!reg) throw new Error("no B5 mint registry — the user vault was never created on-chain");
  const machine = new PublicKey(Buffer.from(reg.data).subarray(40, 72));
  const mi = await conn.getAccountInfo(machine);
  if (!mi) throw new Error(`machine ${machine.toBase58()} not found`);
  const d = Buffer.from(mi.data);
  const pool = new PublicKey(d.subarray(88, 120));
  const obs = new PublicKey(d.subarray(120, 152));
  const dec = d[184];
  const twapWindow = d.readUInt32LE(233), maxStale = d.readUInt32LE(237), bandBp = d.readUInt16LE(241);
  const psLen = d[391];
  const vault = getAssociatedTokenAddressSync(B5_MINT, machine, true);
  const playerB5 = getAssociatedTokenAddressSync(B5_MINT, admin.publicKey, true);

  console.log("== KEEP-0 live B5 vault spin ==");
  console.log("  machine   ", machine.toBase58(), "(pool-set len", psLen + ")");
  console.log("  pool      ", pool.toBase58());
  console.log("  observation", obs.toBase58());
  console.log("  gate      ", `window ${twapWindow}s, max_staleness ${maxStale}s, band ${bandBp}bp`);
  console.log("  player    ", admin.publicKey.toBase58(), "SOL", (await conn.getBalance(admin.publicKey)) / 1e9);
  console.log("  vault B5  ", Number(await tokBal(vault)) / 10 ** dec, "  player B5", Number(await tokBal(playerB5)) / 10 ** dec);
  if (psLen < 1) throw new Error("machine has no pool-set (legacy single-pool) — not a wizard vault");

  const psPda = poolSetPda(machine);
  // spin_commit_dual remaining accounts for a 1-pool set: just [pool_set_pda].
  const extra = [psPda];

  // 1) wait for the keeper-freshened aggregated TWAP to pass the machine's gate.
  console.log(`\nwaiting for a LIVE + in-band CLMM TWAP (is a keeper running on ${pool.toBase58().slice(0, 8)}…?) …`);
  let ready = false;
  for (let i = 0; i < 45; i++) {
    const [pb, ob, slot] = await Promise.all([conn.getAccountInfo(pool), conn.getAccountInfo(obs), conn.getSlot()]);
    const now = (await conn.getBlockTime(slot))!;
    const p = decodePool(pb!.data);
    const os = collectObservations(ob!.data);
    const r = computeTwap(os, p.tickCurrent, now, twapWindow, maxStale);
    const bp = r.status === "LIVE" ? Math.round(Math.abs(p.price - r.price!) / r.price! * 10000) : null;
    console.log(`  [${i}] spot ${p.price.toFixed(2)} twap ${r.status === "LIVE" ? r.price!.toFixed(2) : "—"} cov ${r.coverageSecs}s fresh ${r.staleSecs}s band ${bp ?? "—"}bp [${r.status}]`);
    if (r.status === "LIVE" && bp !== null && bp <= bandBp) { ready = true; break; }
    await sleep(8000);
  }
  if (!ready) throw new Error("aggregated TWAP never became LIVE+in-band — start `keeper.ts --pool " + pool.toBase58() + "`");

  // 2) commit: [createRandomness, commit, spin_commit_dual(+pool_set_pda)] in one tx.
  const nonce = BigInt(Date.now() % 1_000_000);
  const wager = 1_000_000n; // 0.001 SOL
  const queue = await getDefaultDevnetQueue(RPC);
  const sbProgram = (queue as any).program;
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(sbProgram, rngKp, queue.pubkey, admin.publicKey);
  const commitIx = await randomness.commitIx(queue.pubkey, admin.publicKey);
  const spinCommitIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([ixDisc("spin_commit_dual"), u64(wager), u64(nonce)]),
    keys: [
      AM(machine, false, true), AM(dspin(machine, admin.publicKey, nonce), false, true), AM(admin.publicKey, true, true),
      AM(randomness.pubkey), AM(pool), AM(obs), AM(SystemProgram.programId),
      ...extra.map((k) => AM(k)),
    ],
  });
  const commitSig = await sendV0([createIx, commitIx, spinCommitIx], [admin, rngKp], "commit");
  console.log("\ncommit_dual →", solscanTx(commitSig));

  // read the snapshot the program stored (DualPendingSpin).
  const s = (await conn.getAccountInfo(dspin(machine, admin.publicKey, nonce)))!.data;
  const kBp = s.readBigUInt64LE(88) + (s.readBigUInt64LE(96) << 64n);
  const tierIsDeep = s[104] === 1;
  const priceAtCommit = s.readBigUInt64LE(105) + (s.readBigUInt64LE(113) << 64n);
  console.log(`  snapshot: price_at_commit ${(Number(priceAtCommit) / 1e12).toFixed(4)} B5/SOL, k ${kBp}, tier ${tierIsDeep ? "DEEP" : "SHALLOW"}`);

  // 3) reveal + settle: [reveal, spin_settle_dual] in one tx.
  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    try { revealIx = await randomness.revealIx(admin.publicKey); break; }
    catch (e) { if (i % 5 === 0) console.log(`  reveal not ready (${i}) — ${(e as Error).message.slice(0, 60)}`); }
  }
  if (!revealIx) throw new Error("oracle never revealed");
  const b5Before = await tokBal(playerB5);
  const spinSettleIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    data: Buffer.concat([ixDisc("spin_settle_dual"), u64(nonce)]),
    keys: [
      AM(machine, false, true), AM(dspin(machine, admin.publicKey, nonce), false, true), AM(admin.publicKey, false, true),
      AM(randomness.pubkey), AM(vault, false, true), AM(playerB5, false, true), AM(TOKEN_PROGRAM_ID),
      AM(admin.publicKey, true, true), AM(SystemProgram.programId),
    ],
  });
  const settleSig = await sendV0([revealIx, spinSettleIx], [admin], "settle");
  console.log("settle_dual →", solscanTx(settleSig));

  // 4) outcome + INDEPENDENT recompute (aggregate == member-0 TWAP for a 1-pool set).
  const rdata = await randomness.loadData();
  const reels = reelsFromRandomness(Uint8Array.from(rdata.value as number[]));
  const tier = tierIsDeep ? DEEP : SHALLOW;
  const multBp = payoutBp(tier, reels);
  const predicted = payoutTokens(wager, multBp, kBp, priceAtCommit, dec);
  const paid = (await tokBal(playerB5)) - b5Before;
  console.log(`\noutcome: ${reels.map(r => SYMBOL_NAME[r]).join(" · ")}  mult ${multBp}bp`);
  console.log(`  recompute payout (snapshot price + committed k): ${predicted} base units`);
  console.log(`  B5 actually paid to player:                      ${paid} base units`);
  console.log(`  match: ${predicted === paid ? "YES ✓" : "NO ✗"}`);
  console.log("\nmachine", solscanAcct(machine));
  console.log(`RESULT ${predicted === paid ? "VERIFIED" : "MISMATCH"} commit=${commitSig} settle=${settleSig} nonce=${nonce} reels=${reels.join(",")} mult=${multBp} k=${kBp} price=${priceAtCommit} paid=${paid}`);
}
main().catch(e => { console.error("FAILED:", e); process.exit(1); });
