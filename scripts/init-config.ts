// Initialize the singleton HouseConfig (admin = deploy wallet). Idempotent.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { PROGRAM_ID, configPda, connection, ixDisc, loadWallet, sendTx, solscanTx } from "./common.ts";

const conn = connection();
const wallet = loadWallet();
const config = configPda();

const existing = await conn.getAccountInfo(config);
if (existing) {
  console.log(`HouseConfig already initialized at ${config.toBase58()} — skipping.`);
  process.exit(0);
}

const data = Buffer.concat([ixDisc("initialize_house_config"), wallet.publicKey.toBuffer()]);
const ix = new TransactionInstruction({
  programId: PROGRAM_ID,
  keys: [
    { pubkey: config, isSigner: false, isWritable: true },
    { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ],
  data,
});

const sig = await sendTx(conn, [ix], [wallet], "init-config");
console.log(`HouseConfig initialized: ${config.toBase58()}`);
console.log(`  admin = ${wallet.publicKey.toBase58()}`);
console.log(`  tx    = ${solscanTx(sig)}`);
