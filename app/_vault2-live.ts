// DEV-ONLY (not shipped; `_`-prefixed like _dualspin-harness.ts). VAULT-2 live
// acceptance: create a vault on devnet through the WIZARD'S OWN tx builders
// (app/src/lib/poolset.ts::ixCreateVault etc. — the exact code the Launch button
// runs), then deposit + spin + recompute-verify. A browser wallet click can't be
// automated here, so this drives the wizard's literal instruction output signed by
// the local keypair. Also asserts the create tx matches scripts/vault1-live-proof.ts
// (account order + DualParams) — the VAULT-2 no-divergence check.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import { Buffer } from "buffer";
import { ixCreateVault, vaultMachineId, vaultMachinePda, poolSetPda, fetchPoolSet, spinRemaining } from "./src/lib/poolset.ts";
import { DEFAULT_PARAMS } from "./src/lib/vaultspec.ts";
import { ata, ixLpDepositToken, ixSpinCommitDual, ixSpinSettleDual, ixCreateAtaIdempotent, decodeDualPendingSpin } from "./src/lib/dual.ts";
import { DEEP, SHALLOW, reelsFromRandomness, spinPayoutTokens, payoutBp, SYMBOL_NAME } from "./src/lib/housemath.ts";

const RPC = process.env.HOUSE_RPC || readFileSync("/tmp/vault2/rpc.txt", "utf8").trim() || "https://api.devnet.solana.com";
const conn = new Connection(RPC, "confirmed");
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${homedir()}/.config/solana/id.json`, "utf8"))));
const CHIP = new PublicKey("75zyWBYdFSNNFKDaTdEu9nZWdHaZCuuCd7tgCCxi2w6p");
const POOL = new PublicKey("9n6LAVickwVAnDL4rHUZXAXkoMSG5794fKRgrXSfXn1n");
const OBS = new PublicKey("7nPBDXZVazj9w4GsuwjHx3qF5EffQCpvSKPj9p55QsgU");
const dec = 9;
const solscan = (s: string) => `https://solscan.io/tx/${s}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tokBal = (a: PublicKey) => conn.getTokenAccountBalance(a).then((r) => BigInt(r.value.amount)).catch(() => 0n);

async function sendV0(ixs: TransactionInstruction[], signers: Keypair[], label: string): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: kp.publicKey, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...ixs] }).compileToV0Message();
  const tx = new VersionedTransaction(msg); tx.sign([kp, ...signers]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 45; i++) { await sleep(1000); const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig; }
  throw new Error(`${label} confirm timeout`);
}

async function main() {
  console.log("== VAULT-2 live acceptance (wizard tx builders) ==  RPC", RPC.slice(0, 32) + "…");
  const machineId = vaultMachineId("vault-set-2");
  const machine = vaultMachinePda(machineId);
  const vault = ata(machine, CHIP);
  const creatorChip = ata(kp.publicKey, CHIP);
  console.log("creator (wallet)", kp.publicKey.toBase58(), "vault", machine.toBase58());

  // no-divergence check: the wizard's create ix has the account order + data the
  // live-proof script used (11 keys: 9 fixed + the 1-pool member; create_vault disc).
  const createIx = ixCreateVault(machineId, kp.publicKey, CHIP, { ...DEFAULT_PARAMS }, [{ pool: POOL, observation: OBS }]);
  console.log("create_vault ix: keys", createIx.keys.length, "datalen", createIx.data.length,
    "signer", createIx.keys.findIndex((k) => k.isSigner), "vault_writable", createIx.keys[3].isWritable);
  if (createIx.keys.length !== 11 || createIx.data.length !== 156) throw new Error("wizard create ix shape diverged from vault1-live-proof!");

  // 1) CREATE via the wizard builder.
  if (!(await conn.getAccountInfo(machine))) {
    console.log("create_vault →", solscan(await sendV0([createIx], [], "create")));
  } else console.log("vault exists — skipping create");
  console.log("  pool set", poolSetPda(machine).toBase58());

  // 2) DEPOSIT CHIP (wizard-adjacent lp_deposit_token builder).
  const DEPOSIT = 20_000n * 10n ** BigInt(dec);
  if ((await tokBal(vault)) < DEPOSIT) {
    console.log("lp_deposit_token →", solscan(await sendV0([ixLpDepositToken(machine, kp.publicKey, creatorChip, vault, DEPOSIT)], [], "deposit")), "(20,000 CHIP)");
  } else console.log("vault funded — skipping deposit");

  // 3) SPIN — Switchboard + spin_commit_dual with the pool-set remaining accounts
  //    (spinRemaining, the exact helper the vault page uses).
  const ps = await fetchPoolSet(conn, machine);
  const extra = spinRemaining(machine, ps);
  console.log("spin remaining accounts (pool-set):", extra.map((k) => k.toBase58().slice(0, 6)).join(",") || "(none)");

  // wait for a fresh TWAP (keeper must be up) — using the app's own clmm reader.
  const { decodePool, collectObservations, computeTwap } = await import("./src/lib/clmm.ts");
  console.log("waiting for a LIVE TWAP …");
  let ready = false;
  for (let i = 0; i < 40; i++) {
    const [pb, ob, slot] = await Promise.all([conn.getAccountInfo(POOL), conn.getAccountInfo(OBS), conn.getSlot()]);
    const now = (await conn.getBlockTime(slot))!;
    const pool = decodePool(Buffer.from(pb!.data));
    const r = computeTwap(collectObservations(Buffer.from(ob!.data)), pool.tickCurrent, now, DEFAULT_PARAMS.twapWindowSecs, DEFAULT_PARAMS.maxStalenessSecs);
    const band = r.status === "LIVE" ? Math.round(Math.abs(pool.price - r.price!) / r.price! * 10000) : null;
    console.log(`  [${i}] spot ${pool.price.toFixed(1)} twap ${r.status === "LIVE" ? r.price!.toFixed(1) : "—"} band ${band ?? "—"}bp [${r.status}]`);
    if (r.status === "LIVE" && band !== null && band <= DEFAULT_PARAMS.bandBp) { ready = true; break; }
    await sleep(8000);
  }
  if (!ready) throw new Error("TWAP never LIVE — keeper down?");

  const nonce = BigInt(Date.now());
  const queue = await getDefaultDevnetQueue(RPC);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rngKp = Keypair.generate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [randomness, rngCreate] = await Randomness.create((queue as any).program, rngKp, queue.pubkey, kp.publicKey);
  const rngCommit = await randomness.commitIx(queue.pubkey, kp.publicKey);
  const commitIx = ixSpinCommitDual(machine, kp.publicKey, randomness.pubkey, POOL, OBS, 1_000_000n, nonce, extra);
  const commitSig = await sendV0([rngCreate as TransactionInstruction, rngCommit as TransactionInstruction, ixCreateAtaIdempotent(kp.publicKey, kp.publicKey, CHIP), commitIx], [rngKp], "commit");
  console.log("spin_commit_dual (pool-set) →", solscan(commitSig));

  const { dualSpinPda } = await import("./src/lib/dual.ts");
  const snap = decodeDualPendingSpin(Buffer.from((await conn.getAccountInfo(dualSpinPda(machine, kp.publicKey, nonce)))!.data));
  console.log(`  snapshot price_at_commit ${(Number(snap.priceAtCommit1e12) / 1e12).toFixed(2)} CHIP/SOL, k ${snap.kBp}, tier ${snap.tierIsDeep ? "DEEP" : "SHALLOW"}`);

  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) { await sleep(4000); try { revealIx = (await randomness.revealIx(kp.publicKey)) as TransactionInstruction; break; } catch { /* not ready */ } }
  if (!revealIx) throw new Error("oracle never revealed");
  const before = await tokBal(creatorChip);
  const settleSig = await sendV0([revealIx, ixSpinSettleDual(machine, kp.publicKey, randomness.pubkey, vault, creatorChip, kp.publicKey, nonce)], [], "settle");
  console.log("spin_settle_dual →", solscan(settleSig));

  // 4) recompute-verify.
  const value = Uint8Array.from((await randomness.loadData()).value as number[]);
  const reels = reelsFromRandomness(value);
  const tier = snap.tierIsDeep ? DEEP : SHALLOW;
  const predicted = spinPayoutTokens(1_000_000n, tier, snap.kBp, reels, snap.priceAtCommit1e12, dec);
  const paid = (await tokBal(creatorChip)) - before;
  console.log(`\noutcome ${reels.map((r) => SYMBOL_NAME[r]).join(" · ")} mult ${payoutBp(tier, reels)}bp`);
  console.log(`  recompute ${predicted} == paid ${paid} → ${predicted === paid ? "VERIFIED ✓" : "MISMATCH ✗"}`);
  console.log("\n== SUMMARY ==");
  console.log("vault-set-2:", machine.toBase58());
  console.log("pool set   :", poolSetPda(machine).toBase58());
  console.log("recompute  :", predicted === paid ? "VERIFIED" : "MISMATCH");
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
