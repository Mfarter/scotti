// Seed the demo machine's bankroll: the deploy wallet deposits as the founding
// LP. Amount overridable via LP_AMOUNT_LAMPORTS (default ~1 SOL).
import { SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, SOL, connection, decodeMachine, ixDisc, loadWallet, lpPda, machineId, machinePda, sendTx, solscanTx, u64 } from "./common.ts";

const conn = connection();
const wallet = loadWallet();

const LABEL = process.env.MACHINE_LABEL ?? "house-demo-1";
const AMOUNT = BigInt(process.env.LP_AMOUNT_LAMPORTS ?? SOL.toString()); // ~1 SOL

const id = machineId(LABEL);
const machine = machinePda(id);
const position = lpPda(machine, wallet.publicKey);

const before = decodeMachine((await conn.getAccountInfo(machine))!.data);
console.log(`Seeding "${LABEL}" (${machine.toBase58()})`);
console.log(`  pool_value before = ${before.poolValue} lamports, total_shares = ${before.totalShares}`);

const data = Buffer.concat([ixDisc("lp_deposit"), u64(AMOUNT)]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: machine, isSigner: false, isWritable: true },
    { pubkey: position, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});

const sig = await sendTx(conn, [ix], [wallet], "seed-lp");
const after = decodeMachine((await conn.getAccountInfo(machine))!.data);
console.log(`  deposited ${AMOUNT} lamports (${Number(AMOUNT) / Number(SOL)} SOL)`);
console.log(`  pool_value after  = ${after.poolValue} lamports, total_shares = ${after.totalShares}`);
console.log(`  lp position       = ${position.toBase58()}`);
console.log(`  tx                = ${solscanTx(sig)}`);
