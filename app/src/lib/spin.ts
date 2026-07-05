// The spin experience, ported from scripts/devnet-spin.ts to a wallet-adapter
// wallet. Two prompts, honestly labelled by the caller:
//   tx 1 ("place wager")   = [SB create, SB commit, spin_commit]  (wallet + rng keypair)
//   tx 2 ("settle & reveal")= [SB reveal, spin_settle]            (wallet)
// Between them we poll the Switchboard oracle for the reveal (~2-4s).
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, Signer,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { getDefaultDevnetQueue, Randomness } from "@switchboard-xyz/on-demand";
import { Buffer } from "buffer";
import { RPC_URL } from "./constants.ts";
import { decodeMachine, decodePendingSpin, ixSpinCommit, ixSpinSettle, spinPda } from "./program.ts";
import { DEEP, SHALLOW, reelsFromRandomness, spinPayout } from "./housemath.ts";
import { confirm, sleep } from "./rpc.ts";

export type SpinStage = "committing" | "revealing" | "settling" | "done";
export type SendTx = (tx: VersionedTransaction, connection: Connection, options?: { signers?: Signer[] }) => Promise<string>;

export interface SpinResult {
  reels: number[];
  wager: bigint;
  payout: bigint;
  tierIsDeep: boolean;
  kBp: bigint;
  maxPayout: bigint;
  poolBefore: bigint;
  poolAfter: bigint;
  poolDelta: bigint;
  commitSig: string;
  settleSig: string;
  randomnessAccount: string;
  randSeedSlot: bigint;
  valueHex: string;
  nonce: bigint;
  player: string;
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

async function poolValue(conn: Connection, machine: PublicKey): Promise<bigint> {
  const info = await conn.getAccountInfo(machine);
  return decodeMachine(Buffer.from(info!.data)).poolValue;
}

export async function runSpin(opts: {
  conn: Connection;
  player: PublicKey;
  sendTransaction: SendTx;
  machine: PublicKey;
  wager: bigint;
  onStage: (s: SpinStage) => void;
}): Promise<SpinResult> {
  const { conn, player, sendTransaction, machine, wager, onStage } = opts;

  const queue = await getDefaultDevnetQueue(RPC_URL);
  const sbProgram = (queue as unknown as { program: unknown }).program;

  const nonce = BigInt(Date.now());
  const spin = spinPda(machine, player, nonce);
  const poolBefore = await poolValue(conn, machine);

  // --- tx 1: place wager (SB create + commit bundled with spin_commit) ---
  onStage("committing");
  const rngKp = Keypair.generate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [randomness, createIx] = await Randomness.create(sbProgram as any, rngKp, queue.pubkey, player);
  const commitIx = await randomness.commitIx(queue.pubkey, player);
  const spinCommitIx = ixSpinCommit(machine, player, randomness.pubkey, wager, nonce);
  const commitTx = await buildV0(conn, player, [createIx, commitIx, spinCommitIx]);
  const commitSig = await sendTransaction(commitTx, conn, { signers: [rngKp] });
  await confirm(conn, commitSig, "commit");

  // read the frozen snapshot before settle closes the PendingSpin
  const snap = decodePendingSpin(Buffer.from((await conn.getAccountInfo(spin))!.data));
  const tier = snap.tierIsDeep ? DEEP : SHALLOW;

  // --- poll the oracle for the reveal ---
  onStage("revealing");
  let revealIx: TransactionInstruction | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try { revealIx = (await randomness.revealIx(player)) as unknown as TransactionInstruction; break; }
    catch { /* not ready yet */ }
  }
  if (!revealIx) throw new Error("Switchboard oracle did not reveal in time — the wager can be refunded via spin_expire after the window.");

  // --- tx 2: settle & reveal (SB reveal bundled with spin_settle) ---
  onStage("settling");
  const spinSettleIx = ixSpinSettle(machine, player, randomness.pubkey, nonce, player);
  const settleTx = await buildV0(conn, player, [revealIx, spinSettleIx]);
  const settleSig = await sendTransaction(settleTx, conn, {});
  await confirm(conn, settleSig, "settle");

  // --- outcome ---
  const rdata = await randomness.loadData();
  const value = Uint8Array.from(rdata.value as number[]);
  const reels = reelsFromRandomness(value);
  const payout = spinPayout(wager, tier, snap.kBp, reels);
  const poolAfter = await poolValue(conn, machine);

  onStage("done");
  return {
    reels, wager, payout, tierIsDeep: snap.tierIsDeep, kBp: snap.kBp, maxPayout: snap.maxPayout,
    poolBefore, poolAfter, poolDelta: poolAfter - poolBefore,
    commitSig, settleSig, randomnessAccount: randomness.pubkey.toBase58(), randSeedSlot: snap.randSeedSlot,
    valueHex: Buffer.from(value).toString("hex"), nonce, player: player.toBase58(),
  };
}
