import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Connection, Keypair, PublicKey, Signer, Transaction, VersionedTransaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { buildSweep, clearSession, fundIx, loadSession, pendingSpinCount, saveSession, Session, sessionSender } from "../lib/session.ts";
import { confirm } from "../lib/rpc.ts";

interface SessionCtx {
  session: Session | null;
  balance: bigint | null;
  active: boolean;
  buyIn: (lamports: bigint) => Promise<void>;          // fund (or top up) from main wallet
  cashOut: (dest: PublicKey) => Promise<{ amount: bigint; dust: boolean }>;
  sessionSend: (tx: VersionedTransaction, conn: Connection, options?: { signers?: Signer[] }) => Promise<string>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);
export const useSession = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSession outside provider");
  return c;
};

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [session, setSession] = useState<Session | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const alive = useRef(true);

  useEffect(() => { setSession(loadSession()); }, []);

  const refresh = useCallback(async () => {
    if (!session) { setBalance(null); return; }
    try { const b = await connection.getBalance(session.keypair.publicKey); if (alive.current) setBalance(BigInt(b)); } catch { /* transient */ }
  }, [connection, session]);

  useEffect(() => {
    alive.current = true;
    refresh();
    const t = setInterval(refresh, 5000);
    return () => { alive.current = false; clearInterval(t); };
  }, [refresh]);

  const buyIn = useCallback(async (lamports: bigint) => {
    if (!publicKey) throw new Error("connect a wallet first");
    const existing = session;
    const kp = existing?.keypair ?? Keypair.generate();
    const sig = await sendTransaction(new Transaction().add(fundIx(publicKey, kp.publicKey, lamports)), connection);
    await confirm(connection, sig, "buy-in");
    const s: Session = existing ?? { keypair: kp, fundedFrom: publicKey, createdAt: Date.now() };
    saveSession(s.keypair, s.fundedFrom, s.createdAt);
    setSession(s);
    await new Promise((r) => setTimeout(r, 400));
    const b = await connection.getBalance(kp.publicKey);
    setBalance(BigInt(b));
  }, [publicKey, sendTransaction, connection, session]);

  const cashOut = useCallback(async (dest: PublicKey) => {
    if (!session) throw new Error("no session");
    const pending = await pendingSpinCount(connection, session.keypair.publicKey);
    if (pending > 0) throw new Error(`You have ${pending} unsettled spin(s). Settle or let them expire before cashing out — a pending wager must never be stranded.`);
    const built = await buildSweep(connection, session.keypair, dest);
    if (!built) { clearSession(); setSession(null); setBalance(null); return { amount: 0n, dust: true }; }
    const sig = await connection.sendRawTransaction(built.tx.serialize(), { skipPreflight: false });
    await confirm(connection, sig, "cash-out");
    clearSession(); setSession(null); setBalance(null);
    return { amount: built.amount, dust: false };
  }, [connection, session]);

  const sessionSend = useCallback(async (tx: VersionedTransaction, conn: Connection, options?: { signers?: Signer[] }) => {
    if (!session) throw new Error("no session");
    return sessionSender(session.keypair)(tx, conn, options);
  }, [session]);

  return (
    <Ctx.Provider value={{ session, balance, active: !!session, buyIn, cashOut, sessionSend, refresh }}>
      {children}
    </Ctx.Provider>
  );
}
