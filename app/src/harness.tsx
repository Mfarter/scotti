// DEV-ONLY screenshot harness (see the money pages UI-1's empty floor blocked).
// NOT part of the production build: index.html is `vite build`'s only input, and
// nothing production references this file. It injects fabricated MachineStatus /
// DualStatus / SpinResult / price / indexer objects into the REAL components —
// stubbing only at the boundary (a read-only wallet context + a fetch shim for
// the indexer), never altering component logic. Run with `vite dev` and
// VITE_INDEXER_URL set; open /harness.html?scene=<name>.
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ConnectionProvider, WalletContext } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import "@fontsource/zilla-slab/400.css";
import "@fontsource/zilla-slab/700.css";
import "@fontsource/space-mono/latin-400.css";
import "@fontsource/space-mono/latin-700.css";
import "@fontsource/pixelify-sans/600.css";
import "./theme.css";

import { RPC_URL, INDEXER_URL } from "./lib/constants.ts";
import { SessionProvider } from "./components/SessionProvider.tsx";
import { Floor } from "./pages/Floor.tsx";
import { MachinePage, Outcome } from "./pages/Machine.tsx";
import { DualMachinePage, DualOutcome } from "./pages/DualMachine.tsx";
import { Lp } from "./pages/Lp.tsx";
import { Reels } from "./components/ui.tsx";
import { Window } from "./components/os/index.ts";
import { SharePriceChart, RecentSpins } from "./components/Indexed.tsx";
import { JACKPOT, SEVEN, BELL, BAR, CHERRY, BLANK } from "./lib/housemath.ts";
import type { MachineStatus } from "./lib/status.ts";
import type { SpinResult } from "./lib/spin.ts";
import type { DualStatus } from "./lib/dualstatus.ts";
import type { DualSpinResult } from "./lib/dualspin.ts";

// ---- real devnet accounts (they still exist — see the UI-2 diagnostic) ----
const SINGLE = "9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1";
const DUAL = "6vyARZoi4Kc81ZLHYxYDhE4JGH5Db4zf1u8xvLJEvYzL";
const OWNER = new PublicKey("9Nib5TbPssDvvpuBBS8e4U7EPNoPtx5azExiUgbLPFfF"); // holds LP positions on every machine
const CHIP = "75zyWBYdFSNNFKDaTdEu9nZWdHaZCuuCd7tgCCxi2w6p";

// ---- read-only wallet stub: lets the real hooks derive/fetch a real position
// (viewing only — signing throws; the harness never clicks an action). ----
const fakeWallet = {
  autoConnect: false, wallets: [], wallet: null,
  publicKey: OWNER, connecting: false, connected: true, disconnecting: false,
  select: () => {}, connect: async () => {}, disconnect: async () => {},
  sendTransaction: async () => { throw new Error("harness is read-only"); },
  signTransaction: undefined, signAllTransactions: undefined, signMessage: undefined, signIn: undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// ---- indexer fetch shim: fabricate /price + /spins so the REAL chart/feed render. ----
const realFetch = window.fetch.bind(window);
function jsonResponse(obj: unknown) { return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } }); }
function fakePriceSeries(machine: string, dual: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const series = Array.from({ length: 34 }, (_, i) => {
    const t = now - (34 - i) * 3600;
    const drift = 1 + i * 0.0025 + Math.sin(i / 3) * 0.004;
    return {
      t, slot: 130000 + i * 40,
      sharePrice1e12: dual ? null : String(Math.round(1_000_000_000_000 * drift)),
      poolValue: dual ? null : String(5_000_000_000), totalShares: dual ? null : String(5_000_000_000_000),
      sharePriceTokens1e12: dual ? String(Math.round(1_000_000_000_000 * drift)) : null,
      tokenBalance: dual ? String(9_000_000_000_000) : null,
      divPoolSol: dual ? String(120_000_000) : null,
      twap1e12: dual ? String(180_000_000_000_000) : null,
      tokenValueLamports: dual ? String(Math.round(50_000_000 * drift)) : null,
      priceKind: dual ? "LIVE" : null,
    };
  });
  return { machine, kind: dual ? "dual" : "single", label: dual ? "dual-chip-1" : "house-demo-1", tokenDecimals: dual ? 9 : null, firstIndexedTime: series[0].t, series };
}
function fakeSpins(machine: string, dual: boolean) {
  const now = Math.floor(Date.now() / 1000);
  // [reels, single payout (lamports), dual payout (CHIP base units), verify status].
  // The single set is a jackpot day: 0.12 SOL wagered, 0.36 SOL paid → take is
  // NEGATIVE (a jackpot landed), which the dashboard shows in rose.
  const combos: Array<[number[], string, string, "verified" | "partial" | "unverifiable" | "mismatch"]> = [
    [[BELL, BELL, BELL], "0", "0", "verified"],
    [[CHERRY, BAR, BLANK], "8000000", "400000000", "verified"],
    [[SEVEN, SEVEN, SEVEN], "40000000", "1800000000", dual ? "partial" : "verified"],
    [[BAR, BAR, CHERRY], "0", "0", "unverifiable"],
    [[JACKPOT, JACKPOT, BELL], "300000000", "3600000000", "mismatch"],
    [[CHERRY, CHERRY, BLANK], "12000000", "200000000", "verified"],
  ];
  return combos.map(([reels, sp, dp, verifyStatus], i) => ({
    signature: `HARNESSsig${i}${"1".repeat(70)}`.slice(0, 88), machine, kind: dual ? "dual" : "single",
    slot: 134000 - i * 30, blockTime: now - Math.floor((i + 0.5) * 86400 / 6), player: OWNER.toBase58(), nonce: String(100 - i),
    wager: "20000000", reels: reels.join("|"), payout: dual ? dp : sp, payoutKind: dual ? "tokens" : "lamports",
    commitSig: null, priceAtCommit1e12: dual ? "180000000000000" : null, verifyStatus, verifyDetail: null,
  }));
}
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (INDEXER_URL && url.startsWith(INDEXER_URL)) {
    const dual = url.includes(DUAL);
    const machine = dual ? DUAL : SINGLE;
    if (url.includes("/price")) return Promise.resolve(jsonResponse(fakePriceSeries(machine, dual)));
    if (url.includes("/spins")) return Promise.resolve(jsonResponse(fakeSpins(machine, dual)));
    return Promise.resolve(jsonResponse({ ok: true }));
  }
  return realFetch(input, init);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

// ---- fabricated fixtures for the signer-gated outcome cards ----
const fixStatus = {
  machine: SINGLE, name: "HOUSE-DEMO-1", poolValue: 5_000_000_000n, reservedExposure: 200_000_000n,
  freeLiquidity: 4_800_000_000n, smoothedDepth: 5_000_000_000n, isDeep: false, tier: "shallow", topMult: 120,
  kBp: 9550n, realizedRtpBp: 9620n, maxBet: 50_000_000n, totalShares: 5_000_000_000_000n, sharePrice1e12: 1_020_000_000_000n,
  paused: false, epochLength: 1350n, epochNow: 100n, nextBoundarySlot: 136500n, dLow: 0n, dMid: 0n, dHigh: 0n,
  maxExposureBp: 500n, slot: 135000n,
} as MachineStatus;
const spinWin: SpinResult = {
  reels: [BELL, BELL, BELL], wager: 20_000_000n, payout: 240_000_000n, tierIsDeep: false, kBp: 9550n,
  maxPayout: 1_000_000_000n, poolBefore: 5_000_000_000n, poolAfter: 4_780_000_000n, poolDelta: -220_000_000n,
  commitSig: "HARNESScommitWIN" + "1".repeat(70), settleSig: "HARNESSsettleWIN" + "1".repeat(70),
  randomnessAccount: "HARNESSrandWIN" + "1".repeat(30), randSeedSlot: 134990n, valueHex: "0a1b2c", nonce: 7n, player: OWNER.toBase58(),
};
const spinLoss: SpinResult = { ...spinWin, reels: [CHERRY, BAR, BLANK], payout: 0n, poolDelta: 20_000_000n,
  commitSig: "HARNESScommitLOSS" + "1".repeat(70), settleSig: "HARNESSsettleLOSS" + "1".repeat(70) };

const fixDual = {
  machine: DUAL, name: "DUAL-CHIP-1", tokenMint: CHIP, tokenDecimals: 9, twapWindowSecs: 60, maxStalenessSecs: 120,
  price: { kind: "LIVE", label: "LIVE", reason: "fresh & in-band", spot: 182.4, twap: 180.0, twap1e12: 180_000_000_000_000n,
    bandBp: 130, staleSecs: 4, commitAllowed: true },
  realizedRtpBp: 9500n, rtpFloorBp: 9200n, rtpMaxBp: 9700n, effectiveRtpAtSpotBp: 9626,
} as unknown as DualStatus;
const dualWin: DualSpinResult = {
  reels: [SEVEN, SEVEN, SEVEN], wager: 20_000_000n, payoutTokens: 3_600_000_000n, paidTokens: 3_600_000_000n,
  tierIsDeep: false, kBp: 9550n, priceAtCommit1e12: 180_000_000_000_000n, tokenDecimals: 9,
  commitSig: "HARNESSdcommit" + "1".repeat(70), settleSig: "HARNESSdsettle" + "1".repeat(70),
  commitBlockTime: Math.floor(Date.now() / 1000) - 8, commitSlot: 134990n,
  randomnessAccount: "HARNESSdrand" + "1".repeat(30), randSeedSlot: 134990n, valueHex: "0a1b2c", nonce: 7n,
  player: OWNER.toBase58(), playerChip: "HARNESSchip" + "1".repeat(30), machine: DUAL, pool: "HARNESSpool" + "1".repeat(30), observation: "HARNESSobs" + "1".repeat(30),
};

// ---- scenes ----
function MidSpinConsole() {
  return (
    <div className="stack" style={{ gap: 22 }}>
      <h1 style={{ fontSize: 30 }}>Single machine — mid-spin</h1>
      <Window icon="◇" title="Spin" bodyStyle={{ display: "flex", flexDirection: "column", gap: 20, alignItems: "center" }}>
        <Reels symbols={null} spinning glow="var(--pink)" />
        <div className="stack" style={{ gap: 14, width: "min(460px, 100%)" }}>
          <div className="spread"><span className="tag">wager</span><span className="mono">0.020000 SOL <span className="faint">· 20 000 000 lamports</span></span></div>
          <input className="input" type="range" min={1} max={100} value={40} readOnly style={{ padding: 0, accentColor: "var(--gold)" }} />
          <button className="btn gold big" disabled>Spinning…</button>
          <div className="note warn spin-anim">Waiting for the Switchboard oracle to reveal (~2–4s)…</div>
        </div>
      </Window>
    </div>
  );
}

const SCENES: Record<string, { path: string; el: React.ReactNode }> = {
  floor: { path: "/", el: <Routes><Route path="/" element={<Floor />} /></Routes> },
  machine: { path: `/machine/${SINGLE}`, el: <Routes><Route path="/machine/:pubkey" element={<MachinePage />} /></Routes> },
  dual: { path: `/dual/${DUAL}`, el: <Routes><Route path="/dual/:pubkey" element={<DualMachinePage />} /></Routes> },
  lp: { path: "/lp", el: <Routes><Route path="/lp" element={<Lp />} /></Routes> },
  "machine-spin": { path: "/", el: <MidSpinConsole /> },
  "machine-outcome": { path: "/", el: (
    <div className="stack" style={{ gap: 22 }}>
      <h1 style={{ fontSize: 30 }}>Single machine — outcome cards</h1>
      <Outcome r={spinWin} status={fixStatus} />
      <Outcome r={spinLoss} status={fixStatus} />
    </div>
  ) },
  "dual-outcome": { path: "/", el: (
    <div className="stack" style={{ gap: 22 }}>
      <h1 style={{ fontSize: 30 }}>Dual machine — outcome card</h1>
      <DualOutcome r={dualWin} status={fixDual} />
    </div>
  ) },
  indexer: { path: "/", el: (
    <div className="stack" style={{ gap: 24 }}>
      <h1 style={{ fontSize: 30 }}>Indexer — chart + recent-spins feed</h1>
      <Window icon="◇" title="Share price" bodyStyle={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <SharePriceChart machine={SINGLE} kind="single" />
      </Window>
      <RecentSpins machine={SINGLE} kind="single" />
      <RecentSpins machine={DUAL} kind="dual" tokenDecimals={9} />
    </div>
  ) },
};

function App() {
  const scene = new URLSearchParams(location.search).get("scene") ?? "floor";
  const s = SCENES[scene] ?? SCENES.floor;
  const bg = scene === "lp" ? "peach" : "pink";
  return (
    <ConnectionProvider endpoint={RPC_URL} config={{ commitment: "confirmed" }}>
      <WalletContext.Provider value={fakeWallet}>
        <SessionProvider>
          <MemoryRouter initialEntries={[s.path]}>
            <div className="os-shell" data-bg={bg}>
              <div className="os-bg" aria-hidden />
              <main className="wrap page">{s.el}</main>
            </div>
          </MemoryRouter>
        </SessionProvider>
      </WalletContext.Provider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
