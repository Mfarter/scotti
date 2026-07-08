import { Outlet, useLocation } from "react-router-dom";
import { Banner } from "./Banner.tsx";
import { SysBar, StatusBar } from "./os/index.ts";
import { FrescoBg } from "./FrescoBg.tsx";

// Route → background tint (pure presentation; the Remilia pink-vs-peach move, in
// palette-family tonal leans). UI-5: the dithered "Last Judgment" fresco —
// NATURAL (the fresco's own colours) on the Floor, luminance duotones on the tinted
// routes. Falls back to a tint for any unmapped route. The picks are one-line CSS
// swaps in theme.css (each data-bg → a bg-*.png), so a reviewer can re-map freely.
function bgForPath(pathname: string): "natural" | "pink" | "peach" | "paper" {
  if (pathname.startsWith("/lp")) return "peach";
  if (pathname.startsWith("/fair")) return "paper";
  if (pathname.startsWith("/docs")) return "paper";
  if (pathname.startsWith("/machine") || pathname.startsWith("/dual") || pathname.startsWith("/launch")) return "pink";
  return "natural"; // Floor + default → the natural fresco
}

export function Layout() {
  const { pathname } = useLocation();
  const treat = bgForPath(pathname);
  return (
    <div className="os-shell" data-bg={treat}>
      <FrescoBg treat={treat} />
      <Banner />
      <SysBar />
      <main className="wrap page">
        <Outlet />
      </main>
      {/* UI-7: footer removed. The devnet / "not a licensed gambling product"
          disclosure remains on every route via the Banner (top) and the StatusBar
          "DEVNET DEMONSTRATION ONLY" line (bottom). */}
      <StatusBar />
    </div>
  );
}
