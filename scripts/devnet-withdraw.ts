// Live H3 verification on the demo machine: a throwaway LP deposits, requests a
// full withdrawal, waits a real epoch boundary, and a permissionless crank
// processes it — printing exact lamports received vs the share-price prediction.
import { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import {
  PROGRAM_ID, SOL, connection, decodeMachine, ixDisc, loadWallet, lpPda, lpStatus,
  machineId, machinePda, sendTx, sleep, solscanTx, u64, u128,
} from "./common.ts";

const conn = connection();
const wallet = loadWallet();
const LABEL = process.env.MACHINE_LABEL ?? "house-demo-1";
const machine = machinePda(machineId(LABEL));
const DEPOSIT = BigInt(process.env.WITHDRAW_DEPOSIT ?? (SOL / 20n).toString()); // 0.05 SOL
const lamports = async (k: PublicKey) => (await conn.getAccountInfo(k))?.lamports ?? 0;

// mirror of the program's process_withdrawals math (test oracle, in TS)
function expectedProcess(pool: bigint, reserved: bigint, total: bigint, pending: bigint): bigint {
  const free = pool > reserved ? pool - reserved : 0n;
  const freeShares = (free * total) / pool;
  const fill = pending < freeShares ? pending : freeShares;
  return (fill * pool) / total;
}

const ixDeposit = (owner: PublicKey, amount: bigint) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: machine, isSigner: false, isWritable: true },
    { pubkey: lpPda(machine, owner), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: Buffer.concat([ixDisc("lp_deposit"), u64(amount)]),
});
const ixRequest = (owner: PublicKey, shares: bigint) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: machine, isSigner: false, isWritable: false },
    { pubkey: lpPda(machine, owner), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: true, isWritable: false },
  ],
  data: Buffer.concat([ixDisc("request_withdraw"), u128(shares)]),
});
const ixProcess = (owner: PublicKey, cranker: PublicKey) => new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: machine, isSigner: false, isWritable: true },
    { pubkey: lpPda(machine, owner), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: true },
    { pubkey: cranker, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data: ixDisc("process_withdrawals"),
});

console.log(`=== live withdrawal on "${LABEL}" (${machine.toBase58()}) ===`);

// throwaway LP, funded from the deploy wallet
const lp = Keypair.generate();
console.log(`throwaway LP: ${lp.publicKey.toBase58()}`);
{
  const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: lp.publicKey, lamports: Number(DEPOSIT + SOL / 50n) }));
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  t.recentBlockhash = blockhash; t.feePayer = wallet.publicKey; t.sign(wallet);
  const s = await conn.sendRawTransaction(t.serialize());
  for (let i = 0; i < 40; i++) { await sleep(1000); if ((await conn.getSignatureStatus(s)).value?.confirmationStatus) break; }
}

// deposit
const dSig = await sendTx(conn, [ixDeposit(lp.publicKey, DEPOSIT)], [lp], "deposit");
const afterDep = await lpStatus(conn, machine, lp.publicKey);
console.log(`deposited ${DEPOSIT} lamports → ${afterDep.shares} shares (worth ${afterDep.valueLamports})`);
console.log(`  deposit tx: ${solscanTx(dSig)}`);

// request full withdrawal
const rSig = await sendTx(conn, [ixRequest(lp.publicKey, afterDep.shares)], [lp], "request");
const afterReq = await lpStatus(conn, machine, lp.publicKey);
console.log(`requested ${afterReq.pendingShares} shares, pending_epoch ${afterReq.pendingEpoch}`);
console.log(`  request tx: ${solscanTx(rSig)}`);

// wait for the epoch boundary
console.log(`waiting for the epoch boundary (processable when epoch > ${afterReq.pendingEpoch})...`);
for (let i = 0; i < 120; i++) {
  const st = await lpStatus(conn, machine, lp.publicKey);
  if (st.processableNow) { console.log(`  boundary crossed`); break; }
  await sleep(15_000);
}

// predict, then process (permissionless crank = deploy wallet)
const m = decodeMachine((await conn.getAccountInfo(machine))!.data);
const pending = (await lpStatus(conn, machine, lp.publicKey)).pendingShares;
const expected = expectedProcess(m.poolValue, m.reservedExposure, m.totalShares, pending);
const vaultBefore = await lamports(machine);
const lpBefore = await lamports(lp.publicKey);
const pSig = await sendTx(conn, [ixProcess(lp.publicKey, wallet.publicKey)], [wallet], "process");
const vaultAfter = await lamports(machine);
const lpAfter = await lamports(lp.publicKey);

console.log(`\nprocessed:`);
console.log(`  predicted payout (share price at processing) = ${expected} lamports`);
console.log(`  vault debited                                = ${vaultBefore - vaultAfter} lamports`);
console.log(`  LP received (payout + reclaimed rent)        = ${lpAfter - lpBefore} lamports`);
console.log(`  match: ${BigInt(vaultBefore - vaultAfter) === expected ? "✓ exact" : "✗ MISMATCH"}`);
console.log(`  process tx: ${solscanTx(pSig)}`);
const done = await lpStatus(conn, machine, lp.publicKey);
console.log(`  position now: ${done.exists ? `${done.shares} shares / ${done.pendingShares} pending` : "closed (rent reclaimed)"}`);
