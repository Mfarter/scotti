import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { RPC_URL, PROGRAM_ID } from "./constants.ts";
import { acctDisc, decodeMachine, Machine } from "./program.ts";
import { Buffer } from "buffer";

let _conn: Connection | null = null;
export function connection(): Connection {
  if (!_conn) _conn = new Connection(RPC_URL, "confirmed");
  return _conn;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function retry<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; await sleep(800 * (i + 1)); }
  }
  throw new Error(`${label}: ${(last as Error)?.message ?? last}`);
}

/** Poll a signature to confirmation, paced (no websocket) to stay under the
 * public devnet RPC's rate limit — the pattern from scripts/common.ts. */
export async function confirm(conn: Connection, sig: string, label = "tx"): Promise<string> {
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const st = (await conn.getSignatureStatus(sig)).value;
    if (st?.err) throw new Error(`${label} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`${label} confirmation timed out`);
}

export async function sendRaw(conn: Connection, tx: Transaction | VersionedTransaction, label = "tx"): Promise<string> {
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  return confirm(conn, sig, label);
}

export interface MachineEntry { pubkey: PublicKey; machine: Machine; }

/** Enumerate every Machine account owned by the program (getProgramAccounts on
 * the Anchor account discriminator). */
export async function listMachines(conn: Connection): Promise<MachineEntry[]> {
  const disc = acctDisc("Machine");
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(disc) } }],
  });
  return accts.map((a) => ({ pubkey: a.pubkey, machine: decodeMachine(Buffer.from(a.account.data)) }));
}
