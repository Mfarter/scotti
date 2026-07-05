// Create + seed every machine in the manifest (idempotent): skips creation if
// the machine exists and skips seeding if it already has a bankroll. Replaces
// the per-machine env juggling of create-machine.ts / seed-lp.ts.
import { SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  PROGRAM_ID, SOL, configPda, connection, decodeMachine, ixDisc, loadWallet,
  lpPda, machineId, machinePda, sendTx, solscanAcct, u64,
} from "./common.ts";
import { MACHINES, type MachineSpec } from "./machines.ts";

const conn = connection();
const wallet = loadWallet();

async function ensureConfig() {
  if (await conn.getAccountInfo(configPda())) return;
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: configPda(), isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ixDisc("initialize_house_config"), wallet.publicKey.toBuffer()]),
  });
  await sendTx(conn, [ix], [wallet], "init-config");
  console.log("initialized HouseConfig");
}

async function ensureMachine(spec: MachineSpec) {
  const id = machineId(spec.label);
  const machine = machinePda(id);
  const existing = await conn.getAccountInfo(machine);
  if (!existing) {
    const data = Buffer.concat([
      ixDisc("create_machine"), id,
      u64(spec.dLow), u64(spec.dMid), u64(spec.dHigh), u64(spec.maxExposureBp), u64(spec.smoothWindow), u64(spec.epochLength),
      wallet.publicKey.toBuffer(),
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
    await sendTx(conn, [ix], [wallet], `create ${spec.label}`);
    console.log(`created "${spec.label}" (${spec.placement})`);
  } else {
    console.log(`"${spec.label}" exists`);
  }

  const m = decodeMachine((await conn.getAccountInfo(machine))!.data);
  if (m.poolValue === 0n && spec.seedLamports > 0n) {
    const ix = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: machine, isSigner: false, isWritable: true },
        { pubkey: lpPda(machine, wallet.publicKey), isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([ixDisc("lp_deposit"), u64(spec.seedLamports)]),
    });
    await sendTx(conn, [ix], [wallet], `seed ${spec.label}`);
    console.log(`  seeded ${Number(spec.seedLamports) / Number(SOL)} SOL`);
  } else {
    console.log(`  pool_value = ${Number(m.poolValue) / Number(SOL)} SOL (already seeded)`);
  }
  console.log(`  ${machine.toBase58()} — ${solscanAcct(machine)}`);
}

console.log(`bootstrapping ${MACHINES.length} machines as ${wallet.publicKey.toBase58()}`);
await ensureConfig();
for (const spec of MACHINES) await ensureMachine(spec);
console.log("done");
