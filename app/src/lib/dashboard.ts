// Client-side aggregation for the Liquidity pools-dashboard (UI-3). Reads the
// OPTIONAL indexer's per-machine /spins and /price endpoints and folds them into
// pool-level TVL / 24h volume / 24h house-take metrics + trailing drift, entirely
// in the browser (devnet history is small, so no indexer-service change is needed
// or made). TVL is always available from the chain-read status; the 24h metrics
// and drift come only from the indexer and are marked deferred when it's unset.
import { useEffect, useRef, useState } from "react";
import { fetchSpins, fetchPriceSeries, indexerEnabled, type SpinRow, type PriceSeries, type PricePoint } from "./indexer.ts";
import { payoutValueLamports } from "./housemath.ts";
import type { FloorEntry, DualFloorEntry } from "./hooks.ts";

export interface Pt { t: number; v: number }

export interface DashRow {
  pubkey: string; name: string; kind: "single" | "dual";
  tier?: string; topMult?: number; paused?: boolean;                        // single badge
  priceKind?: "LIVE" | "UNSTABLE" | "STALE"; priceLabel?: string; priceReason?: string; // dual chip
  liqLamports: bigint | null;   // SOL-valued liquidity (single pool; dual token@TWAP when LIVE) — null when a dual is stale
  liqTokens?: bigint; liqTokenDecimals?: number;                            // dual CHIP depth
  vol24h: bigint | null;        // null ⇒ indexer off (deferred)
  take24h: bigint | null; takeGap?: boolean;
  drift7dPct: number | null;
}

export interface DashData {
  indexerOn: boolean; loading: boolean;
  tvlLamports: bigint;                                             // Σ SOL-valued liquidity (chain-read, always present)
  staleTokenDepth: { name: string; tokens: bigint; dec: number }[]; // stale duals — token depth, never SOL-faked
  vol24h: bigint | null; take24h: bigint | null; takeGap: boolean;
  tvlSpark: Pt[]; volSpark: Pt[]; takeSpark: Pt[];
  rows: DashRow[];
}

const DAY = 86400;
const num = (s: string | null): number => (s === null ? 0 : Number(s));

/** SOL-value of a spin's payout, in lamports. Single: payout is lamports. Dual:
 * payout is CHIP base units valued at the recorded price_at_commit; returns null
 * if a dual spin lacks the price (so the caller marks a gap rather than guessing). */
function payoutValue(r: SpinRow, dec: number): bigint | null {
  if (r.payout === null) return 0n;
  if (r.payoutKind === "lamports") return BigInt(r.payout);
  if (r.priceAtCommit1e12 === null) return null; // dual with no price — cannot value honestly
  return payoutValueLamports(BigInt(r.payout), BigInt(r.priceAtCommit1e12), dec);
}

/** Sum {t,v} items into n equal time buckets over [from,to); point at bucket centre. */
function buckets(items: Pt[], from: number, to: number, n = 12): Pt[] {
  const w = (to - from) / n;
  return Array.from({ length: n }, (_, i) => {
    const lo = from + i * w, hi = lo + w;
    let s = 0;
    for (const it of items) if (it.t >= lo && it.t < hi) s += it.v;
    return { t: lo + w / 2, v: s };
  });
}

/** Forward-filled TVL(t): union every machine's price samples, and at each time
 * sum the last-known SOL value per machine (single poolValue; dual tokenValueLamports
 * when the sample was LIVE — a stale dual sample contributes no SOL value). */
function tvlSeries(series: { kind: "single" | "dual"; pts: PricePoint[] }[]): Pt[] {
  const allT = [...new Set(series.flatMap((s) => s.pts.map((p) => p.t)))].sort((a, b) => a - b);
  if (allT.length < 2) return [];
  const step = Math.max(1, Math.ceil(allT.length / 40));
  const ts = allT.filter((_, i) => i % step === 0 || i === allT.length - 1);
  const vals = series.map((s) => s.pts
    .map((p) => ({ t: p.t, v: s.kind === "single" ? num(p.poolValue) : num(p.tokenValueLamports) }))
    .sort((a, b) => a.t - b.t));
  return ts.map((t) => {
    let sum = 0;
    for (const mv of vals) { let v = 0; for (const p of mv) { if (p.t <= t) v = p.v; else break; } sum += v; }
    return { t, v: sum / 1e9 };
  });
}

/** Trailing drift % over the last 7d of a machine's share-price series. */
function drift7d(series: PricePoint[], kind: "single" | "dual", now: number): number | null {
  const key = kind === "single" ? "sharePrice1e12" : "sharePriceTokens1e12";
  const pts = series.filter((p) => p[key] !== null && p.t >= now - 7 * DAY).map((p) => Number(p[key]));
  if (pts.length < 2 || pts[0] === 0) return null;
  return (pts[pts.length - 1] / pts[0] - 1) * 100;
}

export function useDashboard(singles: FloorEntry[] | null, duals: DualFloorEntry[] | null): DashData {
  const indexerOn = indexerEnabled();
  const [ind, setInd] = useState<{ spins: Record<string, SpinRow[]>; price: Record<string, PriceSeries | null> } | null>(null);
  const [loading, setLoading] = useState(indexerOn);
  const alive = useRef(true);

  // stable identity of the machine set → refetch only when it changes
  const key = [...(singles ?? []).map((e) => e.pubkey.toBase58()), ...(duals ?? []).map((e) => e.pubkey.toBase58())].sort().join(",");

  useEffect(() => {
    alive.current = true;
    if (!indexerOn || key === "") { setInd(null); setLoading(false); return () => { alive.current = false; }; }
    const pubkeys = key.split(",");
    const run = async () => {
      const [spinsArr, priceArr] = await Promise.all([
        Promise.all(pubkeys.map((pk) => fetchSpins(pk, 200))),
        Promise.all(pubkeys.map((pk) => fetchPriceSeries(pk, { resolution: 0 }))),
      ]);
      if (!alive.current) return;
      const spins: Record<string, SpinRow[]> = {}, price: Record<string, PriceSeries | null> = {};
      pubkeys.forEach((pk, i) => { spins[pk] = spinsArr[i] ?? []; price[pk] = priceArr[i]; });
      setInd({ spins, price }); setLoading(false);
    };
    run();
    const t = setInterval(run, 30000);
    return () => { alive.current = false; clearInterval(t); };
  }, [key, indexerOn]);

  const now = Math.floor(Date.now() / 1000);
  const rows: DashRow[] = [];
  let tvl = 0n;
  const staleTokenDepth: { name: string; tokens: bigint; dec: number }[] = [];

  const perMachine = (pk: string, dec: number) => {
    if (!indexerOn || !ind) return { vol: null as bigint | null, take: null as bigint | null, gap: false, drift: null as number | null };
    const spins = (ind.spins[pk] ?? []).filter((r) => r.blockTime !== null && r.blockTime >= now - DAY);
    let vol = 0n, take = 0n, gap = false;
    for (const r of spins) {
      if (r.wager !== null) vol += BigInt(r.wager);
      const pv = payoutValue(r, dec);
      if (pv === null) { gap = true; continue; }
      if (r.wager !== null) take += BigInt(r.wager) - pv;
    }
    const ser = ind.price[pk];
    const drift = ser ? drift7d(ser.series, ser.kind, now) : null;
    return { vol, take, gap, drift };
  };

  for (const e of singles ?? []) {
    const pk = e.pubkey.toBase58(); const s = e.status;
    tvl += s.poolValue;
    const mm = perMachine(pk, 9);
    rows.push({ pubkey: pk, name: s.name, kind: "single", tier: s.tier, topMult: s.topMult, paused: s.paused,
      liqLamports: s.poolValue, vol24h: mm.vol, take24h: mm.take, takeGap: mm.gap, drift7dPct: mm.drift });
  }
  for (const e of duals ?? []) {
    const pk = e.pubkey.toBase58(); const s = e.status;
    if (s.tokenValueLamports !== null) tvl += s.tokenValueLamports;
    else staleTokenDepth.push({ name: s.name, tokens: s.tokenBalance, dec: s.tokenDecimals });
    const mm = perMachine(pk, s.tokenDecimals);
    rows.push({ pubkey: pk, name: s.name, kind: "dual",
      priceKind: s.price.kind, priceLabel: s.price.label, priceReason: s.price.reason,
      liqLamports: s.tokenValueLamports, liqTokens: s.tokenBalance, liqTokenDecimals: s.tokenDecimals,
      vol24h: mm.vol, take24h: mm.take, takeGap: mm.gap, drift7dPct: mm.drift });
  }

  // top-line 24h sums + sparklines (indexer only)
  let vol24h: bigint | null = null, take24h: bigint | null = null, takeGap = false;
  let tvlSpark: Pt[] = [], volSpark: Pt[] = [], takeSpark: Pt[] = [];
  if (indexerOn && ind) {
    vol24h = 0n; take24h = 0n;
    const volItems: Pt[] = [], takeItems: Pt[] = [];
    const decOf: Record<string, number> = {};
    (duals ?? []).forEach((e) => { decOf[e.pubkey.toBase58()] = e.status.tokenDecimals; });
    for (const [pk, list] of Object.entries(ind.spins)) {
      const dec = decOf[pk] ?? 9;
      for (const r of list) {
        if (r.blockTime === null || r.blockTime < now - DAY) continue;
        if (r.wager !== null) { vol24h += BigInt(r.wager); volItems.push({ t: r.blockTime, v: Number(r.wager) / 1e9 }); }
        const pv = payoutValue(r, dec);
        if (pv === null) { takeGap = true; continue; }
        if (r.wager !== null) { const tk = BigInt(r.wager) - pv; take24h += tk; takeItems.push({ t: r.blockTime, v: Number(tk) / 1e9 }); }
      }
    }
    volSpark = buckets(volItems, now - DAY, now, 12);
    takeSpark = buckets(takeItems, now - DAY, now, 12);
    tvlSpark = tvlSeries([
      ...(singles ?? []).map((e) => ({ kind: "single" as const, pts: ind.price[e.pubkey.toBase58()]?.series ?? [] })),
      ...(duals ?? []).map((e) => ({ kind: "dual" as const, pts: ind.price[e.pubkey.toBase58()]?.series ?? [] })),
    ]);
  }

  return { indexerOn, loading, tvlLamports: tvl, staleTokenDepth, vol24h, take24h, takeGap, tvlSpark, volSpark, takeSpark, rows };
}
