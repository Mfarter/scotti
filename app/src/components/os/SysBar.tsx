import { useEffect, useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { SessionWidget } from "../SessionWidget.tsx";
import { useSession } from "../SessionProvider.tsx";
import { useSlot } from "../../lib/hooks.ts";
import { shortKey, fmtSol } from "../../lib/format.ts";
import { Tile } from "./controls.tsx";

const OS_VERSION = "SCOTTI OS v0.1 · DEVNET";

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return <Tile><span className="mono">{hh}:{mm}:{ss}</span></Tile>;
}

/** Top system bar: wordmark + OS version kicker, nav, live clock, a wallet Tile
 * (connected dot + truncated address) and the existing session / wallet controls
 * — the connect + session-key flow is unchanged, only reframed. */
export function SysBar() {
  const { publicKey, connected } = useWallet();
  return (
    <header className="os-sysbar">
      <div className="wrap">
        <Link to="/" className="stack" style={{ gap: 1, textDecoration: "none" }} aria-label="Scotti home">
          <span className="os-wordmark">SCOTTI</span>
        </Link>
        <span className="os-os-kicker" aria-hidden>{OS_VERSION}</span>
        <nav className="os-navlinks">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "on" : "")}>Floor</NavLink>
          <NavLink to="/lp" className={({ isActive }) => (isActive ? "on" : "")}>Liquidity</NavLink>
          <NavLink to="/fair" className={({ isActive }) => (isActive ? "on" : "")}>Fair?</NavLink>
        </nav>
        <div className="os-grow" />
        <Clock />
        {connected && publicKey && (
          <Tile dot="sage" title="Connected wallet"><span className="mono">{shortKey(publicKey.toBase58(), 4)}</span></Tile>
        )}
        <SessionWidget />
        <WalletMultiButton />
      </div>
    </header>
  );
}

/** Bottom status bar: filled square + the non-negotiable devnet notice, with the
 * live slot and (when a session is funded) the chip balance on the right. Values
 * are read from the same connection/session the app already uses — nothing faked. */
export function StatusBar() {
  const { active, balance } = useSession();
  const slot = useSlot();   // shared slot store (one poll for the whole app)

  return (
    <footer className="os-statusbar" role="contentinfo">
      <div className="wrap">
        <span className="sq" aria-hidden />
        <span><b>DEVNET DEMONSTRATION ONLY</b> — test tokens, no real value.</span>
        <div className="os-sb-right">
          {active && balance !== null && <span className="mono">CHIPS {fmtSol(balance, 4)} SOL</span>}
          {slot !== null && <span className="mono">BLOCK {slot.toLocaleString()}</span>}
        </div>
      </div>
    </footer>
  );
}
