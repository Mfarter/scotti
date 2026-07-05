import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useSession } from "./SessionProvider.tsx";
import { SOL } from "../lib/constants.ts";
import { fmtSol, shortKey } from "../lib/format.ts";

const parseSol = (s: string): bigint | null => {
  const n = Number(s);
  return isFinite(n) && n > 0 ? BigInt(Math.round(n * Number(SOL))) : null;
};

export function SessionWidget() {
  const { active, balance } = useSession();
  const [modal, setModal] = useState<null | "buy" | "cash">(null);
  return (
    <>
      {active ? (
        <button className="chips" onClick={() => setModal("cash")} title="Manage chips">
          <span className="chips-dot" aria-hidden />
          <span className="mono">{balance !== null ? fmtSol(balance, 4) : "…"}</span>
          <span className="faint" style={{ fontSize: 11 }}>chips</span>
        </button>
      ) : (
        <button className="btn sm gold" onClick={() => setModal("buy")}>Buy chips</button>
      )}
      {modal === "buy" && <BuyInModal onClose={() => setModal(null)} />}
      {modal === "cash" && <CashOutModal onClose={() => setModal(null)} onBuy={() => setModal("buy")} />}
    </>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return <div className="modal-backdrop" onClick={onClose}><div className="modal" onClick={(e) => e.stopPropagation()}>{children}</div></div>;
}

function BuyInModal({ onClose }: { onClose: () => void }) {
  const { connected } = useWallet();
  const { active, buyIn } = useSession();
  const [amt, setAmt] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lamports = parseSol(amt);
  const tooLow = lamports !== null && lamports < SOL / 20n;

  async function go() {
    if (!lamports) return;
    setBusy(true); setErr(null);
    try { await buyIn(lamports); onClose(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3 style={{ fontSize: 22 }}>{active ? "Top up chips" : "Buy chips"}</h3>
      <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
        One wallet confirmation funds a browser session key. After that, spins and settles need
        <b> no prompts</b> until you cash out.
      </p>
      <div className="note warn" style={{ marginTop: 12, fontSize: 12.5 }}>
        <b>How chips work:</b> they're held by a key stored in <b>this browser</b>. Anyone with
        access to this browser profile can spend them. Clearing site data without cashing out
        <b> loses the chips</b>. Your loss is bounded by what you buy in. Devnet test tokens only.
      </div>
      {!connected ? (
        <div className="stack" style={{ gap: 10, marginTop: 12 }}>
          <div className="muted">Connect a devnet wallet first.</div>
          <WalletMultiButton />
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 8, marginTop: 14 }}>
            <input className="input" value={amt} onChange={(e) => setAmt(e.target.value)} inputMode="decimal" style={{ maxWidth: 140 }} />
            <span className="faint">SOL</span>
            <div className="row" style={{ gap: 6 }}>
              {["0.05", "0.1", "0.25"].map((v) => <button key={v} className="btn sm ghost" onClick={() => setAmt(v)}>{v}</button>)}
            </div>
          </div>
          {tooLow && <div className="note bad" style={{ marginTop: 10 }}>Minimum buy-in is 0.05 SOL.</div>}
          {err && <div className="note bad" style={{ marginTop: 10 }}>{err}</div>}
          <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
            <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn gold" onClick={go} disabled={busy || !lamports || tooLow}>{busy ? "Confirming…" : active ? "Top up" : "Buy in"}</button>
          </div>
        </>
      )}
    </Backdrop>
  );
}

function CashOutModal({ onClose, onBuy }: { onClose: () => void; onBuy: () => void }) {
  const { publicKey, connected } = useWallet();
  const { session, balance, cashOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ amount: bigint; dust: boolean } | null>(null);
  const [dest, setDest] = useState<"original" | "current">("original");

  if (!session) return null;
  const fundedFrom = session.fundedFrom;
  const sameWallet = connected && publicKey?.equals(fundedFrom);
  const destKey = dest === "current" && publicKey ? publicKey : fundedFrom;

  async function go() {
    setBusy(true); setErr(null);
    try { setDone(await cashOut(destKey)); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Backdrop onClose={onClose}>
      <h3 style={{ fontSize: 22 }}>Your chips</h3>
      <div className="stat" style={{ marginTop: 10 }}>
        <span className="k">balance</span>
        <span className="v mono">{balance !== null ? fmtSol(balance, 6) : "…"} SOL</span>
      </div>
      <div className="faint mono" style={{ fontSize: 12, marginTop: 6 }}>session key {shortKey(session.keypair.publicKey.toBase58(), 5)} · funded from {shortKey(fundedFrom.toBase58(), 5)}</div>

      {done ? (
        <div className="note good" style={{ marginTop: 14 }}>
          {done.dust ? "Session closed (balance was dust). Storage cleared." : <>Cashed out {fmtSol(done.amount, 6)} SOL to {shortKey(destKey.toBase58(), 5)}. Session cleared.</>}
        </div>
      ) : (
        <>
          {!sameWallet && (
            <div className="note warn stack" style={{ gap: 6, marginTop: 12, fontSize: 12.5 }}>
              <span>The connected wallet differs from the one these chips were funded from. Choose where to sweep — no silent redirection.</span>
              <div className="row" style={{ gap: 8 }}>
                <button className={`btn sm ${dest === "original" ? "gold" : "ghost"}`} onClick={() => setDest("original")}>Original ({shortKey(fundedFrom.toBase58(), 4)})</button>
                {connected && <button className={`btn sm ${dest === "current" ? "gold" : "ghost"}`} onClick={() => setDest("current")}>Current ({shortKey(publicKey!.toBase58(), 4)})</button>}
              </div>
            </div>
          )}
          {err && <div className="note bad" style={{ marginTop: 10 }}>{err}</div>}
          <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: "space-between", flexWrap: "wrap" }}>
            <button className="btn ghost sm" onClick={() => { onClose(); onBuy(); }} disabled={busy}>Top up instead</button>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn ghost" onClick={onClose} disabled={busy}>Close</button>
              <button className="btn neon" onClick={go} disabled={busy}>{busy ? "Sweeping…" : `Cash out → ${shortKey(destKey.toBase58(), 4)}`}</button>
            </div>
          </div>
        </>
      )}
    </Backdrop>
  );
}
