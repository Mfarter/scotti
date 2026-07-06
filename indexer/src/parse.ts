// Transaction parsing. web3's getTransaction result is normalized once into a
// flat, JSON-serializable RawTx (account indexes resolved to base58, incl. address
// lookups) so the parsers below are pure functions — the same code runs over a live
// response and over a captured fixture, which is how the tests exercise it.
import type { VersionedTransactionResponse, PublicKey } from "@solana/web3.js";
import { ixDisc } from "./reuse.ts";

export interface TokenBal { owner?: string; mint: string; amount: string }
export interface RawIx { programId: string; accounts: string[]; dataB64: string }
export interface RawTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  accountKeys: string[];
  ixs: RawIx[];
  preBalances: number[];
  postBalances: number[];
  preTokenBalances: TokenBal[];
  postTokenBalances: TokenBal[];
}

/** web3 getTransaction response → flat RawTx (indexes resolved to base58). */
export function normalizeTx(tx: VersionedTransactionResponse): RawTx {
  const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const keyList: string[] = [];
  for (let i = 0; i < keys.length; i++) keyList.push(keys.get(i)!.toBase58());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cis: any[] = (tx.transaction.message as any).compiledInstructions
    ?? (tx.transaction.message as any).instructions ?? [];
  const ixs: RawIx[] = cis.map((ci) => {
    const idxs: number[] = ci.accountKeyIndexes ?? ci.accounts;
    return {
      programId: keys.get(ci.programIdIndex)!.toBase58(),
      accounts: idxs.map((i) => keys.get(i)!.toBase58()),
      dataB64: Buffer.from(ci.data).toString("base64"),
    };
  });
  const tb = (b: readonly unknown[] | null | undefined): TokenBal[] =>
    (b ?? []).map((x) => {
      const y = x as { owner?: string; mint: string; uiTokenAmount: { amount: string } };
      return { owner: y.owner, mint: y.mint, amount: y.uiTokenAmount.amount };
    });
  return {
    signature: tx.transaction.signatures[0] ?? "",
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    accountKeys: keyList,
    ixs,
    preBalances: tx.meta?.preBalances ?? [],
    postBalances: tx.meta?.postBalances ?? [],
    preTokenBalances: tb(tx.meta?.preTokenBalances),
    postTokenBalances: tb(tx.meta?.postTokenBalances),
  };
}

/** Locate a House instruction in a tx by its anchor discriminator name. */
export function houseIx(raw: RawTx, program: string, name: string): RawIx | null {
  const want = ixDisc(name);
  return raw.ixs.find((ix) => ix.programId === program && Buffer.from(ix.dataB64, "base64").subarray(0, 8).equals(want)) ?? null;
}

export interface SettleParse {
  kind: "single" | "dual";
  machine: string; spin: string; player: string; randomness: string; nonce: bigint;
}
/** Parse a settle instruction (single or dual). Account orders mirror
 * app/src/lib/program.ts (ixSpinSettle) and dual.ts (ixSpinSettleDual). */
export function parseSettle(raw: RawTx, program: string): SettleParse | null {
  const dual = houseIx(raw, program, "spin_settle_dual");
  if (dual) {
    const [machine, spin, player, randomness] = dual.accounts;
    return { kind: "dual", machine, spin, player, randomness, nonce: readU64(dual.dataB64, 8) };
  }
  const single = houseIx(raw, program, "spin_settle");
  if (single) {
    const [machine, spin, player, randomness] = single.accounts;
    return { kind: "single", machine, spin, player, randomness, nonce: readU64(single.dataB64, 8) };
  }
  return null;
}

/** Wager from a commit instruction (single: spin_commit, dual: spin_commit_dual). */
export function parseCommitWager(raw: RawTx, program: string, kind: "single" | "dual"): bigint | null {
  const ix = houseIx(raw, program, kind === "dual" ? "spin_commit_dual" : "spin_commit");
  return ix ? readU64(ix.dataB64, 8) : null;
}

/** Single-asset payout = the Machine vault's lamport decrease in the settle tx. */
export function singlePayoutLamports(raw: RawTx, machine: string): bigint | null {
  const i = raw.accountKeys.indexOf(machine);
  if (i < 0) return null;
  const delta = BigInt(raw.postBalances[i]) - BigInt(raw.preBalances[i]);
  return -delta; // paid out of the vault
}

/** Dual payout = the player's token-balance increase for the machine's mint. */
export function dualPayoutTokens(raw: RawTx, player: string, mint: string): bigint | null {
  const post = raw.postTokenBalances.find((b) => b.owner === player && b.mint === mint);
  if (!post) return null;
  const pre = raw.preTokenBalances.find((b) => b.owner === player && b.mint === mint);
  return BigInt(post.amount) - BigInt(pre?.amount ?? "0");
}

function readU64(dataB64: string, off: number): bigint {
  return Buffer.from(dataB64, "base64").readBigUInt64LE(off);
}

export type { PublicKey };
