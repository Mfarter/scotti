// Thin RPC layer. Enumerates machines (both kinds), reads accounts, pages the
// program's signature history, and normalizes settle/commit txs into RawTx.
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, RPC_URL, MAX_SIG_PAGES } from "./config.ts";
import { decodeMachine, base58, type Machine } from "./reuse.ts";
import { decodeDualMachine, acctDisc, type DualMachine } from "./dual-decode.ts";
import { normalizeTx, houseIx, type RawTx } from "./parse.ts";

export const conn = () => new Connection(RPC_URL, "confirmed");

// Public devnet RPC rate-limits aggressively. Serialize calls with a minimum gap
// and retry on 429/transient errors — the same posture as scripts/common.ts.
const MIN_GAP_MS = Number(process.env.RPC_MIN_INTERVAL_MS ?? "250");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let chain: Promise<unknown> = Promise.resolve();
let lastAt = 0;
export async function rpc<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  const run = async (): Promise<T> => {
    for (let i = 0; i < tries; i++) {
      const wait = MIN_GAP_MS - (Date.now() - lastAt);
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      try { return await fn(); }
      catch (e) {
        if (i === tries - 1) throw e;
        await sleep(500 * 2 ** i);
      }
    }
    throw new Error("unreachable");
  };
  const prev = chain.catch(() => {});
  const next = prev.then(run);
  chain = next.catch(() => {});
  return next;
}

/** Current slot + its block time (throttled). */
export async function slotAndTime(c: Connection): Promise<{ slot: number; time: number }> {
  const slot = await rpc(() => c.getSlot("confirmed"));
  const time = (await rpc(() => c.getBlockTime(slot))) ?? Math.floor(Date.now() / 1000);
  return { slot, time };
}

export interface SingleEntry { pubkey: string; machine: Machine; }
export interface DualEntry { pubkey: string; machine: DualMachine; }

export async function listSingleMachines(c: Connection): Promise<SingleEntry[]> {
  const accts = await rpc(() => c.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: base58(acctDisc("Machine")) } }],
  }));
  return accts.map((a) => ({ pubkey: a.pubkey.toBase58(), machine: decodeMachine(Buffer.from(a.account.data)) }));
}
export async function listDualMachines(c: Connection): Promise<DualEntry[]> {
  const accts = await rpc(() => c.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: base58(acctDisc("DualMachine")) } }],
  }));
  return accts.map((a) => ({ pubkey: a.pubkey.toBase58(), machine: decodeDualMachine(Buffer.from(a.account.data)) }));
}

export async function accountData(c: Connection, pk: string): Promise<Buffer | null> {
  const info = await rpc(() => c.getAccountInfo(new PublicKey(pk)));
  return info ? Buffer.from(info.data) : null;
}

export interface SigInfo { signature: string; slot: number; blockTime: number | null; err: unknown; }
/** Page the whole program signature history (newest → oldest), bounded. */
export async function programSignatures(c: Connection): Promise<SigInfo[]> {
  const out: SigInfo[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_SIG_PAGES; page++) {
    const sigs = await rpc(() => c.getSignaturesForAddress(PROGRAM_ID, { limit: 1000, before }, "confirmed"));
    if (sigs.length === 0) break;
    for (const s of sigs) out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, err: s.err });
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < 1000) break;
  }
  return out;
}

export async function getTx(c: Connection, sig: string): Promise<RawTx | null> {
  const tx = await rpc(() => c.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }));
  return tx ? normalizeTx(tx) : null;
}

/** Find the commit tx for a spin by scanning the spin PDA's signature history. */
export async function findCommit(c: Connection, spinPda: string, kind: "single" | "dual", settleSig: string): Promise<RawTx | null> {
  const name = kind === "dual" ? "spin_commit_dual" : "spin_commit";
  const sigs = await rpc(() => c.getSignaturesForAddress(new PublicKey(spinPda), { limit: 20 }, "confirmed"));
  for (const s of sigs) {
    if (s.signature === settleSig || s.err) continue;
    const raw = await getTx(c, s.signature);
    if (raw && houseIx(raw, PROGRAM_ID.toBase58(), name)) return raw;
  }
  return null;
}
