// The dual-asset spin experience: SOL wager in, CHIP prize out, priced by the
// pool's on-chain TWAP. Ported from scripts/devnet-dual-spin.ts to a wallet-
// adapter / session-key wallet. Two prompts (or promptless with chips):
//   tx 1 ("place wager")    = [SB create, SB commit, create CHIP ATA, spin_commit_dual]
//   tx 2 ("settle & reveal") = [SB reveal, spin_settle_dual]
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import { Buffer } from "buffer";
import { RPC_URL } from "./constants.ts";
import { DEEP, SHALLOW, reelsFromRandomness, spinPayoutTokens } from "./housemath.ts";
import { ata, decodeDualPendingSpin, dualSpinPda, ixCreateAtaIdempotent, ixSpinCommitDual, ixSpinSettleDual } from "./dual.ts";
import { confirm, sleep } from "./rpc.ts";
import { type SpinStage, type SendTx } from "./spin.ts";

export interface DualSpinResult {
  reels: number[];
  wager: bigint;
  payoutTokens: bigint;      // recomputed from snapshot + randomness
  paidTokens: bigint;        // from the settle tx's CHIP balance delta
  tierIsDeep: boolean;
  kBp: bigint;
  priceAtCommit1e12: bigint;
  tokenDecimals: number;
  commitSig: string; settleSig: string;
  commitBlockTime: number;   // cluster time at commit — for the verifier's price recompute
  commitSlot: bigint;
  randomnessAccount: string; randSeedSlot: bigint; valueHex: string;
  nonce: bigint; player: string; playerChip: string;
  machine: string; pool: string; observation: string;
}

async function buildV0(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[]): Promise<VersionedTransaction> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ...ixs,
  ];
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
  return new VersionedTransaction(msg);
}

export async function runDualSpin(opts: {
  conn: Connection;
  player: PublicKey;
  sendTransaction: SendTx;
  machine: PublicKey;
  pool: PublicKey; observation: PublicKey; vault: PublicKey; tokenMint: PublicKey; tokenDecimals: number;
  wager: bigint;
  onStage: (s: SpinStage) => void;
}): Promise<DualSpinResult> {
  const { conn, player, sendTransaction, machine, pool, observation, vault, tokenMint, tokenDecimals, wager, onStage } = opts;
  const playerChip = ata(player, tokenMint);

  const queue = await getDefaultDevnetQueue(RPC_URL);
  const sbProgram = (queue as unknown as { program: unknown }).program;

  const nonce = BigInt(Date.now());
  const spin = dualSpinPda(machine, player, nonce);

  // --- tx 1: place wager (create randomness + commit + ensure CHIP ATA + spin_commit_dual) ---
  onStage("committing");
  const rngKp = Keypair.generate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [randomness, createIx] = await Randomness.create(sbProgram as any, rngKp, queue.pubkey, player);
  const commitIx = await randomness.commitIx(queue.pubkey, player);
  const spinCommitIx = ixSpinCommitDual(machine, player, randomness.pubkey, pool, observation, wager, nonce);
  const commitTx = await buildV0(conn, player, [createIx, commitIx, ixCreateAtaIdempotent(player, player, tokenMint), spinCommitIx]);
  const commitSig = await sendTransaction(commitTx, conn, { signers: [rngKp] });
  await confirm(conn, commitSig, "commit");

  // read the frozen snapshot (closed at settle) + the commit cluster time.
  const snap = decodeDualPendingSpin(Buffer.from((await conn.getAccountInfo(spin))!.data));
  const commitTxData = await conn.getTransaction(commitSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const commitBlockTime = commitTxData?.blockTime ?? Math.floor(Date.now() / 1000);
  const tier = snap.tierIsDeep ? DEEP : SHALLOW;

  // --- poll the oracle for the reveal ---
  onStage("revealing");
  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try { revealIx = (await randomness.revealIx(player)) as unknown as TransactionInstruction; break; }
    catch { /* not ready yet */ }
  }
  if (!revealIx) throw new Error("Switchboard oracle did not reveal in time — the wager can be refunded via spin_expire_dual after the window.");

  // --- tx 2: settle & reveal ---
  onStage("settling");
  const settleTx = await buildV0(conn, player, [revealIx, ixSpinSettleDual(machine, player, randomness.pubkey, vault, playerChip, player, nonce)]);
  const settleSig = await sendTransaction(settleTx, conn, {});
  await confirm(conn, settleSig, "settle");

  // --- outcome ---
  const rdata = await randomness.loadData();
  const value = Uint8Array.from(rdata.value as number[]);
  const reels = reelsFromRandomness(value);
  const payoutTokens = spinPayoutTokens(wager, tier, snap.kBp, reels, snap.priceAtCommit1e12, tokenDecimals);

  // CHIP actually paid, from the settle tx's token-balance delta on the player ATA.
  let paidTokens = 0n;
  const st = await conn.getTransaction(settleSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (st?.meta) {
    const mintB58 = tokenMint.toBase58(), owner = player.toBase58();
    const pre = st.meta.preTokenBalances?.find((b) => b.owner === owner && b.mint === mintB58);
    const post = st.meta.postTokenBalances?.find((b) => b.owner === owner && b.mint === mintB58);
    paidTokens = BigInt(post?.uiTokenAmount.amount ?? "0") - BigInt(pre?.uiTokenAmount.amount ?? "0");
  }

  onStage("done");
  return {
    reels, wager, payoutTokens, paidTokens, tierIsDeep: snap.tierIsDeep, kBp: snap.kBp,
    priceAtCommit1e12: snap.priceAtCommit1e12, tokenDecimals,
    commitSig, settleSig, commitBlockTime, commitSlot: snap.commitSlot,
    randomnessAccount: randomness.pubkey.toBase58(), randSeedSlot: snap.randSeedSlot,
    valueHex: Buffer.from(value).toString("hex"), nonce, player: player.toBase58(), playerChip: playerChip.toBase58(),
    machine: machine.toBase58(), pool: pool.toBase58(), observation: observation.toBase58(),
  };
}
