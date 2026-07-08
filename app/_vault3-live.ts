// DEV-ONLY (not shipped). VAULT-3 live proof on devnet: grandfather CHIP to
// dual-chip-1 via register_legacy_mint, then prove a NEW create_vault for CHIP
// FAILS on-chain (the one-vault-per-mint rule), and confirm the existing vaults
// still read. Uses the app's own builders (poolset.ts). Signed by the local keypair.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { Buffer } from "buffer";
import { ixRegisterLegacyMint, ixCreateVault, mintRegistryPda, fetchMintRegistry, vaultMachineId, vaultMachinePda } from "./src/lib/poolset.ts";
import { DEFAULT_PARAMS } from "./src/lib/vaultspec.ts";
import { dualMachineId, dualMachinePda, decodeDualMachine } from "./src/lib/dual.ts";

const RPC = process.env.HOUSE_RPC || readFileSync("/tmp/vault2/rpc.txt", "utf8").trim() || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const CHIP = new PublicKey("75zyWBYdFSNNFKDaTdEu9nZWdHaZCuuCd7tgCCxi2w6p");
const POOL = new PublicKey("9n6LAVickwVAnDL4rHUZXAXkoMSG5794fKRgrXSfXn1n");
const OBS = new PublicKey("7nPBDXZVazj9w4GsuwjHx3qF5EffQCpvSKPj9p55QsgU");
const solscan = (s: string) => `https://solscan.io/tx/${s}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function send(ixs: any[], label: string, skipPreflight = false): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs] }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([kp]);
  const sig = await conn.sendTransaction(tx, { skipPreflight, maxRetries: 5 });
  for (let i = 0; i < 40; i++) { await sleep(1000); const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw Object.assign(new Error(`${label} on-chain error: ${JSON.stringify(st.err)}`), { sig });
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig; }
  throw new Error(`${label} timeout`);
}

async function main() {
  console.log("== VAULT-3 live proof (one vault per mint) ==");
  const chip1Id = dualMachineId("dual-chip-1");
  const chip1 = dualMachinePda(chip1Id);
  console.log("dual-chip-1", chip1.toBase58(), "mint CHIP", CHIP.toBase58());

  // 1) grandfather CHIP → dual-chip-1 (skip if already claimed).
  const before = await fetchMintRegistry(conn, CHIP);
  if (before) {
    console.log(`CHIP registry already exists → machine ${before.machine.toBase58()} (skipping register)`);
  } else {
    const sig = await send([ixRegisterLegacyMint(chip1, CHIP, kp.publicKey)], "register_legacy_mint");
    console.log("register_legacy_mint (CHIP → dual-chip-1) →", solscan(sig));
  }
  const reg = await fetchMintRegistry(conn, CHIP);
  console.log("  CHIP registry PDA", mintRegistryPda(CHIP).toBase58(), "→ machine", reg?.machine.toBase58());
  if (!reg || reg.machine.toBase58() !== chip1.toBase58()) throw new Error("CHIP registry does not point at dual-chip-1!");

  // 2) THE PROOF: a NEW create_vault for CHIP must now FAIL (registry init collides).
  const squatId = vaultMachineId("chip-squat-x");
  const ix = ixCreateVault(squatId, kp.publicKey, CHIP, { ...DEFAULT_PARAMS }, [{ pool: POOL, observation: OBS }]);
  let failed = false, failSig = "", failErr = "";
  try {
    // skipPreflight so the doomed tx LANDS as a failed tx with a reportable txid.
    failSig = await send([ix], "create_vault(CHIP)", true);
    console.log("!! create_vault for CHIP unexpectedly SUCCEEDED:", solscan(failSig));
  } catch (e: any) { failed = true; failSig = e.sig ?? ""; failErr = e.message; }
  console.log("\ncreate_vault for CHIP (squat attempt) →", failed ? "FAILED as required ✓" : "SUCCEEDED ✗");
  console.log("  failing txid:", failSig ? solscan(failSig) : "(rejected pre-submit)");
  console.log("  error:", failErr);
  if (!failed) throw new Error("one-vault-per-mint rule did NOT hold!");
  console.log("  vault-chip-squat-x PDA that was refused:", vaultMachinePda(squatId).toBase58());

  // 3) existing vaults still read (one read each).
  console.log("\nexisting vaults still read:");
  for (const [name, pk] of [["dual-chip-1", chip1.toBase58()], ["vault-set-1", "86JGeQXykW69jydjUXxWfUBk6KpgHSm8sVvE1fKfrxPE"], ["vault-set-2", "2gbmYLi8WgWemeg8n2Q1B9voscKFFaje45M7V6XuzBK6"]] as const) {
    const info = await conn.getAccountInfo(new PublicKey(pk));
    const m = decodeDualMachine(Buffer.from(info!.data));
    console.log(`  ${name.padEnd(12)} ✓  len=${info!.data.length} pool_set_len=${m.poolSetLen} token_balance=${m.tokenBalance} paused=${m.paused}`);
  }
  console.log("\n== SUMMARY ==");
  console.log("CHIP claimed by dual-chip-1; a CHIP create_vault is now refused on-chain.");
  console.log("failing create txid:", failSig);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
