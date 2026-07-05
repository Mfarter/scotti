import { NavLink, Outlet, Link } from "react-router-dom";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Banner } from "./Banner.tsx";

export function Layout() {
  return (
    <>
      <Banner />
      <header className="nav">
        <div className="wrap">
          <Link to="/" className="brand" aria-label="Scotti home">
            <span className="chip">SCOTTI</span>
            <span style={{ color: "var(--ink-dim)", fontWeight: 600, fontSize: 13, letterSpacing: 0 }}>the floor</span>
          </Link>
          <nav className="navlinks">
            <NavLink to="/" end className={({ isActive }) => (isActive ? "on" : "")}>Floor</NavLink>
            <NavLink to="/lp" className={({ isActive }) => (isActive ? "on" : "")}>Liquidity</NavLink>
            <NavLink to="/fair" className={({ isActive }) => (isActive ? "on" : "")}>Fair?</NavLink>
          </nav>
          <div className="grow" />
          <WalletMultiButton />
        </div>
      </header>
      <main className="wrap page">
        <Outlet />
      </main>
      <footer className="wrap" style={{ padding: "26px 22px 48px", color: "var(--ink-faint)", fontSize: 12.5, borderTop: "1px solid var(--line)" }}>
        <div className="spread" style={{ flexWrap: "wrap", gap: 8 }}>
          <span>Scotti — a devnet demonstration of verifiable, state-dependent house games. Not a licensed gambling product.</span>
          <Link className="link" to="/fair">How it works →</Link>
        </div>
      </footer>
    </>
  );
}
