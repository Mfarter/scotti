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
import { Lp, SingleVarianceNote } from "./pages/Lp.tsx";
import { PriceFreeNote, TokenRiskNote } from "./pages/DualLpPanel.tsx";
import { LpDashboard } from "./pages/LpDashboard.tsx";
import { Reels, TierBadge, PriceChip } from "./components/ui.tsx";
import { Window } from "./components/os/index.ts";
import { SharePriceChart, RecentSpins } from "./components/Indexed.tsx";
import { JACKPOT, SEVEN, BELL, BAR, CHERRY, BLANK } from "./lib/housemath.ts";
import type { MachineStatus } from "./lib/status.ts";
import type { SpinResult } from "./lib/spin.ts";
import type { DualStatus } from "./lib/dualstatus.ts";
import type { DualSpinResult } from "./lib/dualspin.ts";
import { floorStore } from "./lib/hooks.ts";
import type { FloorEntry, DualFloorEntry } from "./lib/hooks.ts";
import { LaunchWizard, type Member, type TokenInfo } from "./pages/Launch.tsx";
import { Docs } from "./pages/Docs.tsx";
import { DEFAULT_PARAMS } from "./lib/vaultspec.ts";
import type { PriceStatus } from "./lib/clmm.ts";

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
// Per-machine share-price profile so the APR column shows a positive, a negative,
// and a short-window (annualizes to noise) case across the real devnet machines.
function profile(pk: string): { dir: number; hours: number } {
  if (pk.startsWith("4Tb4")) return { dir: -1, hours: 160 };  // negative APR, ~6.6d window
  if (pk.startsWith("6zsj")) return { dir: +1, hours: 20 };   // short window (<3d) → APR is noise
  return { dir: +1, hours: 170 };                             // positive APR, ~7d window (9Ns1 + dual)
}
function fakePriceSeries(machine: string, dual: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const { dir, hours } = profile(machine);
  const series = Array.from({ length: hours }, (_, i) => {
    const t = now - (hours - 1 - i) * 3600;
    const drift = 1 + dir * (i * 0.0022) + Math.sin(i / 4) * 0.003;
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
const SCENE = new URLSearchParams(location.search).get("scene") ?? "floor";
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (INDEXER_URL && url.startsWith(INDEXER_URL)) {
    const pk = url.match(/\/machines\/([^/?]+)/)?.[1] ?? SINGLE;
    const dual = pk === DUAL;
    if (url.includes("/price")) return Promise.resolve(jsonResponse(fakePriceSeries(pk, dual)));
    if (url.includes("/spins")) return Promise.resolve(jsonResponse(fakeSpins(pk, dual)));
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

// ---- fabricated floor for the dashboard scene (keeps capture off the flaky
// public RPC; the mock indexer keys APR profiles by these real pubkeys). ----
const SINGLE2 = "4Tb4cW8vn4P1aR4Wwnfd1pLZ7hF942FmrLaKWPogzmeD"; // negative-APR profile
const SINGLE3 = "6zsjba9sbx7v8fPrnvyrUDoL1dDaaWcXaigq9swsF2uC"; // short-window profile
const mkSingle = (pk: string, name: string, tier: string, topMult: number, poolValue: bigint): FloorEntry =>
  ({ pubkey: new PublicKey(pk), status: { ...fixStatus, machine: pk, name, tier, topMult, poolValue } as MachineStatus });
const FIX_SINGLES: FloorEntry[] = [
  mkSingle(SINGLE, "house-demo-1", "shallow", 50, 999_000_000n),
  mkSingle(SINGLE2, "Cold Comfort", "shallow", 50, 300_000_000n),
  mkSingle(SINGLE3, "Leviathan", "deep", 500, 1_200_000_000n),
];
const FIX_DUALS: DualFloorEntry[] = [{
  pubkey: new PublicKey(DUAL),
  status: { machine: DUAL, name: "dual-chip-1", tokenBalance: 17_997_000_000_000n, tokenDecimals: 9, tokenValueLamports: null,
    price: { kind: "STALE", label: "STALE", reason: "the price feed went quiet" }, tier: "—", topMult: 0 } as unknown as DualStatus,
}];
const statusOf = (pk: string) => FIX_SINGLES.find((e) => e.pubkey.toBase58() === pk)?.status;
const dualOf = (pk: string) => FIX_DUALS.find((e) => e.pubkey.toBase58() === pk)?.status;

// ---- VAULT-2 fixtures: launch-wizard state + a pool-set (3-of-5 quorum) floor card ----
const uniqKey = () => PublicKey.unique();
const livePS = (twap: number, spot: number): PriceStatus => ({ kind: "LIVE", label: "LIVE", reason: "fresh & in band", spot, twap, twap1e12: BigInt(Math.round(twap * 1e12)), bandBp: Math.round(Math.abs(spot - twap) / twap * 10000), staleSecs: 3, coverageSecs: 620, obsCount: 42, commitAllowed: true });
const stalePS = (): PriceStatus => ({ kind: "STALE", label: "STALE", reason: "newest obs 9001s old > max 180s", spot: 970, twap: null, twap1e12: null, bandBp: null, staleSecs: 9001, coverageSecs: 300, obsCount: 12, commitAllowed: false });
const CHIP_TOKEN: TokenInfo = { mint: CHIP, decimals: 9, supply: 10_000_000_000_000_000n, ok: true, error: null };
const okMember = (twap: number): Member => ({ poolKey: uniqKey(), obsKey: uniqKey(), loading: false, status: livePS(twap, twap * 1.002),
  check: { ok: true, clmmOwned: true, pairsMint: true, crossLinked: true, distinct: true, mintA: new PublicKey("So11111111111111111111111111111111111111112"), mintB: new PublicKey(CHIP), observation: uniqKey(), reasons: [] } });
const badMember: Member = { poolKey: uniqKey(), obsKey: uniqKey(), loading: false, status: null,
  check: { ok: false, clmmOwned: true, pairsMint: false, crossLinked: true, distinct: true, mintA: new PublicKey("So11111111111111111111111111111111111111112"), mintB: uniqKey(), observation: uniqKey(), reasons: ["pool does not pair the payout mint (one side must equal it)"] } };
const setPools = (kinds: ("live" | "stale")[]): PriceStatus[] => kinds.map((k, i) => k === "live" ? livePS(972 + i * 0.6, 972 + i * 0.6) : stalePS());
// a 3-of-5 LIVE set and a 2-of-5 QUORUM-NOT-MET set, as floor DualFloorEntries.
const mkSetStatus = (name: string, live: number): DualStatus => ({
  machine: uniqKey().toBase58(), name, tokenMint: CHIP, tokenVault: uniqKey().toBase58(), pool: uniqKey().toBase58(), observation: uniqKey().toBase58(),
  tokenDecimals: 9, poolSetLen: 5, eligiblePools: live, quorum: 3,
  perPoolPrice: setPools(Array.from({ length: 5 }, (_, i) => (i < live ? "live" : "stale"))),
  price: live >= 3 ? livePS(972.2, 972.9) : { kind: "QUORUM", label: "QUORUM NOT MET", reason: `only ${live}/5 pools eligible — need 3 (a majority) to price`, spot: null, twap: null, twap1e12: null, bandBp: null, staleSecs: 0, coverageSecs: 0, obsCount: 5, commitAllowed: false },
  rtpFloorBp: 9200n, rtpMaxBp: 9500n, bandBp: 300, twapWindowSecs: 60, maxStalenessSecs: 180,
  tier: "shallow", topMult: 50, isDeep: false, kBp: live >= 3 ? 10337n : null, realizedRtpBp: live >= 3 ? 9500n : null, effectiveRtpAtSpotBp: null,
  depthLamports: 20_000_000_000n, smoothedDepthLamports: 20_000_000_000n, valueMaxBetLamports: 40_000_000n, maxBetLamports: live >= 3 ? 40_000_000n : null,
  tokenBalance: 20_000_000_000_000n, reservedTokens: 0n, freeTokens: 20_000_000_000_000n, tokenValueLamports: live >= 3 ? 20_570_000_000n : null,
  totalShares: 20_000_000_000_000_000n, sharePriceTokens: 1_000_000, divPoolSol: 0n, earmarkedSol: 0n, paused: false,
  epochLength: 1350n, epochNow: 100n, nextBoundarySlot: 136500n, slot: 135000n,
} as unknown as DualStatus);
const FIX_SET_DUALS: DualFloorEntry[] = [
  { pubkey: new PublicKey(mkSetStatus("chip-set-3of5", 3).machine), status: mkSetStatus("chip-set-3of5", 3) },
  { pubkey: new PublicKey(mkSetStatus("chip-set-2of5", 2).machine), status: mkSetStatus("chip-set-2of5", 2) },
];

// Drive the floor store into the degraded states deterministically (the store's
// own poll is frozen so it can't overwrite these). "stale" seeds last-good pools
// then marks a failure → amber chip over intact pools. "cold" only marks the
// error with no data → the full-panel cold-start error.
if (SCENE === "floor-stale") { floorStore.seed({ singles: FIX_SINGLES, duals: [] }); floorStore.markError("429 Too Many Requests"); floorStore.freeze(); }
if (SCENE === "floor-cold") { floorStore.markError("429 Too Many Requests"); floorStore.freeze(); }
// pool-set quorum chips (3-of-5 LIVE + 2-of-5 QUORUM NOT MET), from fixtures.
if (SCENE === "quorum") { floorStore.seed({ singles: [], duals: FIX_SET_DUALS }); floorStore.freeze(); }

/** Mirrors the deposit modal Lp/DualLpPanel render, using the REAL exported
 * disclosure components (the modal's tx logic lives in those files, verified by
 * diff — this only reproduces the modal visual off-RPC for the screenshot). */
function HarnessDepositModal({ target, onClose }: { target: { pk: string; kind: "single" | "dual" }; onClose: () => void }) {
  const single = target.kind === "single";
  const s = single ? statusOf(target.pk) : undefined;
  const d = single ? undefined : dualOf(target.pk);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ marginBottom: 10 }}>
          <h3 style={{ fontSize: 20 }}>{single ? `Deposit — ${s?.name}` : `Deposit CHIP — ${d?.name}`}</h3>
          {single && s ? <TierBadge tier={s.tier} topMult={s.topMult} paused={s.paused} />
            : d ? <PriceChip kind={d.price.kind} label={d.price.label} title={d.price.reason} /> : null}
        </div>
        <div className="stack" style={{ gap: 12 }}>
          <div className="stack" style={{ gap: single ? 8 : 6 }}>
            <span className="tag">{single ? "deposit" : <>deposit CHIP <span className="faint">· price-free</span></>}</span>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" defaultValue={single ? "0.05" : "100"} style={{ maxWidth: single ? 160 : 150 }} />
              <span className="faint">{single ? "SOL" : "CHIP"}</span>
              <button className="btn gold">Deposit</button>
            </div>
            {!single && <PriceFreeNote />}
          </div>
          {single && s ? <SingleVarianceNote status={s} /> : <TokenRiskNote />}
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function DashboardScene() {
  const [modal, setModal] = React.useState<{ pk: string; kind: "single" | "dual" } | null>(null);
  const [active, setActive] = React.useState<string>(SINGLE);
  return (
    <div className="stack" style={{ gap: 22 }}>
      <h1 style={{ fontSize: 30 }}>Liquidity — pools dashboard</h1>
      <LpDashboard singles={FIX_SINGLES} duals={FIX_DUALS} activePk={active}
        onSelect={(pk) => setActive(pk)} onDeposit={(pk, kind) => setModal({ pk, kind })} />
      {modal && <HarnessDepositModal target={modal} onClose={() => setModal(null)} />}
    </div>
  );
}

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
  dashboard: { path: "/", el: <DashboardScene /> },
  "floor-stale": { path: "/", el: <Routes><Route path="/" element={<Floor />} /></Routes> },
  "floor-cold": { path: "/", el: <Routes><Route path="/" element={<Floor />} /></Routes> },
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
  quorum: { path: "/", el: <Routes><Route path="/" element={<Floor />} /></Routes> },
  docs: { path: "/docs", el: <Routes><Route path="/docs" element={<Docs />} /></Routes> },
  "launch-token": { path: "/launch", el: <Routes><Route path="/launch" element={<LaunchWizard initial={{ step: 0, token: CHIP_TOKEN }} />} /></Routes> },
  "launch-taken": { path: "/launch", el: <Routes><Route path="/launch" element={<LaunchWizard initial={{ step: 0, token: CHIP_TOKEN, takenBy: DUAL }} />} /></Routes> },
  "launch-pools": { path: "/launch", el: <Routes><Route path="/launch" element={<LaunchWizard initial={{ step: 1, token: CHIP_TOKEN, members: [okMember(972.2), okMember(971.8), okMember(972.6)] }} />} /></Routes> },
  "launch-pools-invalid": { path: "/launch", el: <Routes><Route path="/launch" element={<LaunchWizard initial={{ step: 1, token: CHIP_TOKEN, members: [okMember(972.2), okMember(971.8), badMember] }} />} /></Routes> },
  "launch-params": { path: "/launch", el: <Routes><Route path="/launch" element={<LaunchWizard initial={{ step: 2, token: CHIP_TOKEN, members: [okMember(972.2), okMember(971.8), okMember(972.6)], label: "my-vault", params: { ...DEFAULT_PARAMS, mBp: 250 } }} />} /></Routes> },
  "launch-review": { path: "/launch", el: <Routes><Route path="/launch" element={<LaunchWizard initial={{ step: 3, token: CHIP_TOKEN, members: [okMember(972.2), okMember(971.8), okMember(972.6)], label: "my-vault" }} />} /></Routes> },
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
  const bg = scene === "lp" || scene === "dashboard" ? "peach" : "pink";
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
