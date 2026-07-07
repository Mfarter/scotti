import { Outlet, Link, useLocation } from "react-router-dom";
import { Banner } from "./Banner.tsx";
import { SysBar, StatusBar } from "./os/index.ts";

// Route → background tint (pure presentation; the Remilia pink-vs-peach move, in
// palette-family tonal leans). Falls back to pink for any unmapped route.
function bgForPath(pathname: string): "pink" | "peach" | "paper" {
  if (pathname.startsWith("/lp")) return "peach";
  if (pathname.startsWith("/fair")) return "paper";
  if (pathname.startsWith("/machine") || pathname.startsWith("/dual")) return "pink";
  return "pink"; // Floor + default
}

export function Layout() {
  const { pathname } = useLocation();
  return (
    <div className="os-shell" data-bg={bgForPath(pathname)}>
      <div className="os-bg" aria-hidden />
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
