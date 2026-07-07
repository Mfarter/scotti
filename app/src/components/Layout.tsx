import { Outlet, Link } from "react-router-dom";
import { Banner } from "./Banner.tsx";
import { SysBar, StatusBar } from "./os/index.ts";

export function Layout() {
  return (
    <div className="os-shell">
      <Banner />
      <SysBar />
      <main className="wrap page">
        <Outlet />
      </main>
      <footer className="wrap" style={{ padding: "22px 22px 30px", color: "var(--ink2)", fontSize: 12, borderTop: "1px solid var(--line)" }}>
        <div className="spread" style={{ flexWrap: "wrap", gap: 8 }}>
          <span>Scotti — a devnet demonstration of verifiable, state-dependent house games. Not a licensed gambling product.</span>
          <Link className="link" to="/fair">How it works →</Link>
        </div>
      </footer>
      <StatusBar />
    </div>
  );
}
