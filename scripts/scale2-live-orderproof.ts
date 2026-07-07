// SCALE-2 live proof: withdrawal crank ordering is now price-identical. Two LPs
// with IDENTICAL queued withdrawals on house-demo-1; a real Switchboard spin
// SETTLES between their two cranks (moving the pool); both are paid IDENTICAL
// amounts — the unfairness SCALE-1 demonstrated (scale_a) is now impossible, live.
//
//   node scale2-live-orderproof.ts            # full run (setup → epoch wait → cranks)
//   node scale2-live-orderproof.ts process    # resume: crank1 → spin → crank2 → verify
import { PublicKey, TransactionInstruction, SystemProgram, Keypair } from "@solana/web3.js";
import { asV0Tx, getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import {
  PROGRAM_ID, RPC, connection, loadWallet, ixDisc, u64, u128, sleep, solscanTx,
  machineId, machinePda, lpPda, spinPda,
} from "./common.ts";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const conn = connection();
const admin = loadWallet(); // funder + cranker + spin player
const LABEL = "house-demo-1";
const machine = machinePda(machineId(LABEL));
const SCALE = 1_000_000_000_000_000_000n; // SNAPSHOT_SCALE (1e18)
const STATE = "/tmp/scale2-orderproof.json";
const AM = (pubkey: PublicKey, s = false, w = false) => ({ pubkey, isSigner: s, isWritable: w });

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<string> {
  const tx = await asV0Tx({ connection: conn, ixs, payer: admin.publicKey, signers, computeUnitPrice: 50_000, computeUnitLimitMultiple: 1.3 });
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${label} confirmation timed out`);
}

const u128at = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
async function readMachine() {
  const d = (await conn.getAccountInfo(machine))!.data;
  return {
    pool_value: d.readBigUInt64LE(96), reserved_exposure: d.readBigUInt64LE(104), total_shares: u128at(d, 112),
    epoch_length: d.readBigUInt64LE(154) === 0n ? 1350n : d.readBigUInt64LE(154),
    snap_price: u128at(d, 162), snap_epoch: d.readBigUInt64LE(178),
  };
}
const lamports = async (pk: PublicKey) => BigInt(await conn.getBalance(pk));
const shares = async (owner: PublicKey) => u128at((await conn.getAccountInfo(lpPda(machine, owner)))!.data, 72);

const ixDeposit = (owner: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: PROGRAM_ID, data: Buffer.concat([ixDisc("lp_deposit"), u64(amount)]),
  keys: [AM(machine, false, true), AM(lpPda(machine, owner), false, true), AM(owner, true, true), AM(SystemProgram.programId)],
});
const ixRequest = (owner: PublicKey, sh: bigint) => new TransactionInstruction({
  programId: PROGRAM_ID, data: Buffer.concat([ixDisc("request_withdraw"), u128(sh)]),
  keys: [AM(machine, false, false), AM(lpPda(machine, owner), false, true), AM(owner, true, false)],
});
const ixProcess = (owner: PublicKey, cranker: PublicKey) => new TransactionInstruction({
  programId: PROGRAM_ID, data: ixDisc("process_withdrawals"),
  keys: [AM(machine, false, true), AM(lpPda(machine, owner), false, true), AM(owner, false, true), AM(cranker, true, true), AM(SystemProgram.programId)],
});

/** one full Switchboard spin (commit→reveal→settle), player = cranker = admin. */
async function runSpin(nonce: bigint) {
  const spin = spinPda(machine, admin.publicKey, nonce);
  const queue = await getDefaultDevnetQueue(RPC);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = (queue as any).program;
  const rngKp = Keypair.generate();
  const [randomness, createIx] = await Randomness.create(sb, rngKp, queue.pubkey, admin.publicKey);
  const commitIx = await randomness.commitIx(queue.pubkey, admin.publicKey);
  const wager = 50_000n; // 0.00005 SOL (house-demo-1 max_bet is tiny)
  const commit = new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.concat([ixDisc("spin_commit"), u64(wager), u64(nonce)]),
    keys: [AM(machine, false, true), AM(spin, false, true), AM(admin.publicKey, true, true), AM(randomness.pubkey), AM(SystemProgram.programId)],
  });
  console.log("  spin commit →", solscanTx(await sendV0([createIx, commitIx, commit], [admin, rngKp], "commit")));
  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) { await sleep(3000); try { revealIx = await randomness.revealIx(admin.publicKey); break; } catch { /* not ready */ } }
  if (!revealIx) throw new Error("oracle never revealed");
  const settle = new TransactionInstruction({
    programId: PROGRAM_ID, data: Buffer.concat([ixDisc("spin_settle"), u64(nonce)]),
    keys: [AM(machine, false, true), AM(spin, false, true), AM(admin.publicKey, false, true), AM(randomness.pubkey), AM(admin.publicKey, true, true), AM(SystemProgram.programId)],
  });
  console.log("  spin settle →", solscanTx(await sendV0([revealIx, settle], [admin], "settle")));
}

async function setup() {
  const lp1 = Keypair.generate(), lp2 = Keypair.generate();
  console.log("funding two throwaway LPs from the deploy wallet …");
  const fund = (to: PublicKey) => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: to, lamports: 60_000_000 });
  await sendV0([fund(lp1.publicKey), fund(lp2.publicKey)], [admin], "fund");
  const DEP = 20_000_000n; // 0.02 SOL each, back-to-back → identical shares
  console.log("both LPs deposit 0.02 SOL (no spin between → identical shares) …");
  await sendV0([ixDeposit(lp1.publicKey, DEP)], [admin, lp1], "deposit1");
  await sendV0([ixDeposit(lp2.publicKey, DEP)], [admin, lp2], "deposit2");
  const s1 = await shares(lp1.publicKey), s2 = await shares(lp2.publicKey);
  console.log(`  lp1 shares ${s1}\n  lp2 shares ${s2}  ${s1 === s2 ? "IDENTICAL ✓" : "DIFFER ✗"}`);
  if (s1 !== s2) throw new Error("shares differ — cannot prove order-independence");
  console.log("both request full withdrawal …");
  await sendV0([ixRequest(lp1.publicKey, s1)], [admin, lp1], "request1");
  await sendV0([ixRequest(lp2.publicKey, s2)], [admin, lp2], "request2");
  const m = await readMachine();
  const st = { lp1: [...lp1.secretKey], lp2: [...lp2.secretKey], s1: s1.toString(), s2: s2.toString(), requestEpoch: (BigInt(await conn.getSlot("confirmed")) / m.epoch_length).toString(), epochLength: m.epoch_length.toString() };
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`state saved. request epoch ${st.requestEpoch}, epoch_length ${st.epochLength} slots (~9 min). run \`node scale2-live-orderproof.ts process\` after the boundary.`);
}

async function runProcess() {
  const st = JSON.parse(readFileSync(STATE, "utf8"));
  const lp1 = Keypair.fromSecretKey(Uint8Array.from(st.lp1)), lp2 = Keypair.fromSecretKey(Uint8Array.from(st.lp2));
  const s1 = BigInt(st.s1), s2 = BigInt(st.s2);
  const requestEpoch = BigInt(st.requestEpoch), epochLen = BigInt(st.epochLength);

  console.log("waiting for the epoch boundary …");
  for (;;) {
    const ep = BigInt(await conn.getSlot("confirmed")) / epochLen;
    if (ep > requestEpoch) { console.log(`  epoch ${ep} > ${requestEpoch} — processable`); break; }
    await sleep(20000);
  }

  // crank #1: lp1 (skip if already withdrawn on a resume — its payout is the frozen
  // snapshot × its shares, by construction).
  const lp1Live = (await conn.getAccountInfo(lpPda(machine, lp1.publicKey))) !== null;
  let pay1: bigint;
  if (lp1Live) {
    const v0 = await lamports(machine);
    console.log("\ncrank #1 (lp1) →", solscanTx(await sendV0([ixProcess(lp1.publicKey, admin.publicKey)], [admin], "process1")));
    pay1 = v0 - await lamports(machine);
  } else {
    pay1 = (s1 * (await readMachine()).snap_price) / SCALE;
    console.log(`\ncrank #1 (lp1) already done on a prior run — payout was ${pay1} (frozen snapshot × shares)`);
  }
  const m1 = await readMachine();
  console.log(`  lp1 payout ${pay1}  frozen snapshot_price ${m1.snap_price} (epoch ${m1.snap_epoch})`);

  // a REAL spin settles BETWEEN the cranks — the pool moves.
  console.log("\nrunning a spin that settles BETWEEN the two cranks (pool will move) …");
  const poolMid0 = (await readMachine()).pool_value;
  await runSpin(BigInt(Date.now() % 1_000_000));
  const poolMid1 = (await readMachine()).pool_value;
  console.log(`  pool moved ${poolMid0} → ${poolMid1} between the cranks`);

  // crank #2: lp2, SAME epoch → SAME frozen snapshot.
  const v1 = await lamports(machine);
  console.log("\ncrank #2 (lp2) →", solscanTx(await sendV0([ixProcess(lp2.publicKey, admin.publicKey)], [admin], "process2")));
  const pay2 = v1 - await lamports(machine);
  const m2 = await readMachine();

  // recompute: payout == shares × snapshot_price / SCALE (floored).
  const expect = (sh: bigint) => (sh * m1.snap_price) / SCALE;
  console.log("\n=== RECOMPUTE / ORDER-INDEPENDENCE ===");
  console.log(`  lp1 payout ${pay1}   expected ${expect(s1)}   ${pay1 === expect(s1) ? "✓" : "✗"}`);
  console.log(`  lp2 payout ${pay2}   expected ${expect(s2)}   ${pay2 === expect(s2) ? "✓" : "✗"}`);
  console.log(`  same frozen snapshot across the epoch: ${m1.snap_price === m2.snap_price ? "✓" : "✗"}`);
  console.log(`  IDENTICAL payouts despite the interleaved spin: ${pay1} == ${pay2}  ${pay1 === pay2 ? "✓" : "✗"}`);
  const ok = pay1 === pay2 && pay1 === expect(s1) && pay2 === expect(s2) && m1.snap_price === m2.snap_price;
  console.log(ok ? "\nVERIFIED ✓  withdrawal crank ordering is price-identical, live — SCALE.md §1b MITIGATED" : "\nMISMATCH ✗");
  if (!ok) process.exit(1);
}

const mode = existsSync(STATE) && process.argv[2] === "process" ? "process" : process.argv[2];
if (mode === "process") await runProcess(); else await setup();
