// Session "chips": an ephemeral Keypair, funded once from the main wallet, that
// stands in as player + payer so spins and settles need no wallet prompt.
// CLIENT-SIDE ONLY and devnet-only. The secret key lives in localStorage —
// anyone with this browser profile can spend the chips; clearing site data
// without cashing out loses them; losses are bounded by the buy-in. The UI says
// this plainly (buy-in modal + Fair page).
import { Connection, Keypair, PublicKey, Signer, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { PROGRAM_ID } from "./constants.ts";
import { acctDisc } from "./program.ts";

const STORAGE_KEY = "scotti.session.v1";

/** Base network fee for a single-signature transfer (no priority) — the sweep
 * uses exactly this so the session account drains cleanly to zero. */
export const SWEEP_FEE = 5_000n;

export interface Session {
  keypair: Keypair;
  fundedFrom: PublicKey; // the main wallet at buy-in time (provenance)
  createdAt: number;
}

interface Stored { sk: string; fundedFrom: string; createdAt: number }

export function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Stored;
    return { keypair: Keypair.fromSecretKey(bs58.decode(s.sk)), fundedFrom: new PublicKey(s.fundedFrom), createdAt: s.createdAt };
  } catch { return null; }
}
export function saveSession(keypair: Keypair, fundedFrom: PublicKey, createdAt: number) {
  const s: Stored = { sk: bs58.encode(keypair.secretKey), fundedFrom: fundedFrom.toBase58(), createdAt };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}
export function clearSession() { localStorage.removeItem(STORAGE_KEY); }

/** A legacy transfer from the main wallet into the session key (buy-in / top-up).
 * The main wallet signs it (its one confirmation per sitting). */
export function fundIx(from: PublicKey, session: PublicKey, lamports: bigint) {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: session, lamports: Number(lamports) });
}

/** Sweep the whole session balance minus the base fee back to `dest`, signed by
 * the session key. Leaves the session account at exactly zero lamports (a
 * 0-data system account needs no rent-exemption, so it simply ceases to exist).
 * Returns null if there's nothing above the fee to sweep (dust). */
export async function buildSweep(conn: Connection, session: Keypair, dest: PublicKey): Promise<{ tx: Transaction; amount: bigint } | null> {
  const bal = BigInt(await conn.getBalance(session.publicKey));
  if (bal <= SWEEP_FEE) return null;
  const amount = bal - SWEEP_FEE;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: session.publicKey, toPubkey: dest, lamports: Number(amount) }));
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash; tx.feePayer = session.publicKey; tx.sign(session);
  return { tx, amount };
}

/** How many committed-but-unsettled spins the session key owns — never strand a
 * PendingSpin: a non-empty result blocks cash-out. */
export async function pendingSpinCount(conn: Connection, player: PublicKey): Promise<number> {
  const disc = acctDisc("PendingSpin");
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    dataSlice: { offset: 0, length: 0 },
    filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(disc) } },
      { memcmp: { offset: 8 + 32, bytes: player.toBase58() } }, // player field
    ],
  });
  return accts.length;
}

/** Sign a (versioned) transaction with the session key plus any extra signers
 * (the Switchboard randomness keypair) and send it — the promptless send used by
 * the spin flow when chips are active. */
export function sessionSender(session: Keypair) {
  return async (tx: VersionedTransaction, conn: Connection, options?: { signers?: Signer[] }): Promise<string> => {
    tx.sign([session, ...(options?.signers ?? [])]);
    return conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  };
}

/** A generous per-spin overhead estimate so we can refuse a wager the session
 * can't actually cover. Dominated by the Switchboard randomness-account rent
 * (~0.0083 SOL, non-refundable) plus the temporarily-held PendingSpin rent
 * (~0.0023, refunded at settle) plus fees. Measured against a live spin. */
export const SPIN_OVERHEAD = 12_000_000n; // 0.012 SOL
