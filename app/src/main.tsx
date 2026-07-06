import React, { lazy, Suspense, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Routes, Route } from "react-router-dom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./theme.css";

import { RPC_URL } from "./lib/constants.ts";
import { SessionProvider } from "./components/SessionProvider.tsx";
import { Layout } from "./components/Layout.tsx";
import { Floor } from "./pages/Floor.tsx";

// Machine page pulls in the (heavy) Switchboard SDK for the spin flow — lazy so
// the Floor/Liquidity/Fair pages don't pay for it up front.
const MachinePage = lazy(() => import("./pages/Machine.tsx").then((m) => ({ default: m.MachinePage })));
const DualMachinePage = lazy(() => import("./pages/DualMachine.tsx").then((m) => ({ default: m.DualMachinePage })));
const Lp = lazy(() => import("./pages/Lp.tsx").then((m) => ({ default: m.Lp })));
const Fair = lazy(() => import("./pages/Fair.tsx").then((m) => ({ default: m.Fair })));

const Loading = () => <div className="muted spin-anim" style={{ padding: 20 }}>Loading…</div>;

function Root() {
  // Empty wallet list: Phantom / Solflare / Backpack register via the Wallet
  // Standard and appear automatically. Devnet only.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <SessionProvider>
          <HashRouter>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Floor />} />
                <Route path="machine/:pubkey" element={<Suspense fallback={<Loading />}><MachinePage /></Suspense>} />
                <Route path="dual/:pubkey" element={<Suspense fallback={<Loading />}><DualMachinePage /></Suspense>} />
                <Route path="lp" element={<Suspense fallback={<Loading />}><Lp /></Suspense>} />
                <Route path="fair" element={<Suspense fallback={<Loading />}><Fair /></Suspense>} />
              </Route>
            </Routes>
          </HashRouter>
          </SessionProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
