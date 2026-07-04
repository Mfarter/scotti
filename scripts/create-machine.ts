// Create one demo machine (admin-gated). Params from HOUSE-SPEC's worked
// example; overridable by env so the depth band can be tuned to the devnet
// bankroll. Defaults span 0.5 / 2 / 10 SOL so tier transitions are reachable.
import { SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, SOL, configPda, connection, decodeMachine, ixDisc, loadWallet, machineId, machinePda, sendTx, solscanAcct, solscanTx, u64 } from "./common.ts";

const conn = connection();
const wallet = loadWallet();

const LABEL = process.env.MACHINE_LABEL ?? "house-demo-1";
const D_LOW = BigInt(process.env.D_LOW ?? (SOL / 2n).toString());   // 0.5 SOL
const D_MID = BigInt(process.env.D_MID ?? (2n * SOL).toString());   // 2 SOL
const D_HIGH = BigInt(process.env.D_HIGH ?? (10n * SOL).toString()); // 10 SOL
const MAX_EXPOSURE_BP = BigInt(process.env.MAX_EXPOSURE_BP ?? "100"); // 1%
const SMOOTH_WINDOW = BigInt(process.env.SMOOTH_WINDOW ?? "9000");
const EPOCH_LENGTH = BigInt(process.env.EPOCH_LENGTH ?? "1350"); // ~9 min on devnet

const id = machineId(LABEL);
const machine = machinePda(id);

const existing = await conn.getAccountInfo(machine);
if (existing) {
  const m = decodeMachine(existing.data);
  console.log(`Machine "${LABEL}" already exists at ${machine.toBase58()}`);
  console.log(`  d_low/mid/high = ${m.dLow} / ${m.dMid} / ${m.dHigh} lamports, exposure ${m.maxExposureBp} bp`);
  process.exit(0);
}

const data = Buffer.concat([
  ixDisc("create_machine"),
  id, // machine_id [u8;16]
  u64(D_LOW), u64(D_MID), u64(D_HIGH), u64(MAX_EXPOSURE_BP), u64(SMOOTH_WINDOW), u64(EPOCH_LENGTH),
  wallet.publicKey.toBuffer(), // curator = admin
]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: configPda(), isSigner: false, isWritable: false },
    { pubkey: machine, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});

const sig = await sendTx(conn, [ix], [wallet], "create-machine");
console.log(`Machine "${LABEL}" created: ${machine.toBase58()}`);
console.log(`  id (hex)       = ${id.toString("hex")}`);
console.log(`  d_low/mid/high = ${D_LOW} / ${D_MID} / ${D_HIGH} lamports`);
console.log(`  max_exposure   = ${MAX_EXPOSURE_BP} bp, smooth_window = ${SMOOTH_WINDOW} slots, epoch_length = ${EPOCH_LENGTH} slots`);
console.log(`  curator        = ${wallet.publicKey.toBase58()}`);
console.log(`  account        = ${solscanAcct(machine)}`);
console.log(`  tx             = ${solscanTx(sig)}`);
