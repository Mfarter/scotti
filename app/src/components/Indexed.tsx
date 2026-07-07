// UI for data served by the OPTIONAL off-chain indexer. Every surface here carries
// a trust disclosure: this is NOT a chain read — it is convenient, recompute-checked
// data served by an operator. Each spin row shows its recompute status; when the
// indexer is unset/unreachable these components render the honest fallback and the
// callers keep their existing "deferred" markers.
import { useEffect, useState } from "react";
import { fetchPriceSeries, fetchSpins, indexerEnabled, type PriceSeries, type SpinRow, type VerifyStatus } from "../lib/indexer.ts";
import { solscanTx } from "../lib/constants.ts";
import { fmtLamports, fmtTokens, shortKey } from "../lib/format.ts";

/** The standing disclosure. Rendered anywhere indexed data appears. */
export function IndexerNote({ compact }: { compact?: boolean }) {
  return (
    <div className="faint" style={{ fontSize: compact ? 11.5 : 12.5, lineHeight: 1.5 }}>
      <span style={{ color: "var(--gold)" }}>◆ from the Scotti indexer</span> — an off-chain service, the
      one non-chain-read data path in this app. Every spin row carries its recompute status, and you can
      verify any spin yourself in-browser. Convenient, checked, but served by an operator — not the chain.
    </div>
  );
}

const VERIFY_STYLE: Record<VerifyStatus, { color: string; label: string; title: string }> = {
  verified: { color: "var(--sage-ink)", label: "✓ verified", title: "recompute from chain matched the paid amount" },
  partial: { color: "var(--amber-ink)", label: "~ partial", title: "reels + payout verified from chain; a dual price aged out of the observation ring" },
  unverifiable: { color: "var(--ink-faint)", label: "? unverifiable", title: "randomness account closed or commit aged out of RPC history — stored honestly as such" },
  mismatch: { color: "var(--rose-ink)", label: "✗ mismatch", title: "paid amount did NOT recompute — investigate" },
};
export function VerifyBadge({ status, title }: { status: VerifyStatus; title?: string }) {
  const s = VERIFY_STYLE[status];
  return (
    <span className="badge mono" title={title ?? s.title} style={{ color: s.color, borderColor: s.color, background: "var(--paper)", fontSize: 11.5 }}>
      {s.label}
    </span>
  );
}

// -------------------- inline SVG line chart (no chart lib) --------------------

interface Pt { t: number; v: number }
function MiniChart({ pts, stroke, height = 90 }: { pts: Pt[]; stroke: string; height?: number }) {
  const W = 320, H = height, pad = 6;
  if (pts.length < 2) return <div className="faint" style={{ fontSize: 12 }}>collecting samples… ({pts.length} so far — needs at least two)</div>;
  const xs = pts.map((p) => p.t), vs = pts.map((p) => p.v);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const vMin = Math.min(...vs), vMax = Math.max(...vs);
  const spanX = xMax - xMin || 1, spanV = vMax - vMin || 1;
  const X = (t: number) => pad + ((t - xMin) / spanX) * (W - 2 * pad);
  const Y = (v: number) => pad + (1 - (v - vMin) / spanV) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H, display: "block" }}>
      <line x1={pad} y1={Y(vs[0])} x2={W - pad} y2={Y(vs[0])} stroke="var(--ink-faint)" strokeOpacity={0.3} strokeDasharray="3 4" />
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.75} vectorEffect="non-scaling-stroke" />
      <circle cx={X(last.t)} cy={Y(last.v)} r={2.6} fill={stroke} />
    </svg>
  );
}

/** Normalize a series to its first point = 100 (share-price DRIFT — the honest
 * trailing view; absolute per-share prices are tiny and scale-free). */
function drift(pts: Pt[]): { norm: Pt[]; changePct: number } {
  if (pts.length === 0) return { norm: [], changePct: 0 };
  const base = pts[0].v || 1;
  const norm = pts.map((p) => ({ t: p.t, v: (p.v / base) * 100 }));
  const changePct = ((pts[pts.length - 1].v / base) - 1) * 100;
  return { norm, changePct };
}

function num(s: string | null): number { return s === null ? 0 : Number(s); }
const fmtChange = (pct: number) => `${pct >= 0 ? "+" : ""}${pct.toFixed(3)}%`;

export function SharePriceChart({ machine, kind }: { machine: string; kind: "single" | "dual" }) {
  const [data, setData] = useState<PriceSeries | null | undefined>(undefined); // undefined = loading

  useEffect(() => {
    let alive = true;
    setData(undefined);
    fetchPriceSeries(machine, { resolution: 0 }).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [machine]);

  if (!indexerEnabled()) return null;         // caller keeps its deferred marker
  if (data === undefined) return <div className="faint" style={{ fontSize: 12 }}>loading share-price history…</div>;
  if (!data || data.series.length === 0) return <div className="faint" style={{ fontSize: 12 }}>indexer reachable, but no samples yet for this machine.</div>;

  const since = data.firstIndexedTime ? new Date(data.firstIndexedTime * 1000).toLocaleDateString() : "—";

  if (kind === "single") {
    const pts: Pt[] = data.series.filter((p) => p.sharePrice1e12 !== null).map((p) => ({ t: p.t, v: num(p.sharePrice1e12) / 1e12 }));
    const { norm, changePct } = drift(pts);
    return (
      <div className="stack" style={{ gap: 8 }}>
        <div className="spread"><span className="tag">share price · trailing drift</span><span className="mono" style={{ color: changePct >= 0 ? "var(--sage-ink)" : "var(--amber-ink)" }}>{fmtChange(changePct)}</span></div>
        <MiniChart pts={norm} stroke="var(--gold)" />
        <div className="faint" style={{ fontSize: 11.5 }}>history begins {since} · {pts.length} samples · lamports per share, indexed to 100 at the first sample</div>
        <IndexerNote compact />
      </div>
    );
  }

  // dual: PRIMARY (price-free) + SECONDARY (price-dependent), never blended.
  const prim: Pt[] = data.series.filter((p) => p.sharePriceTokens1e12 !== null).map((p) => ({ t: p.t, v: num(p.sharePriceTokens1e12) / 1e12 }));
  const sec: Pt[] = data.series.filter((p) => p.tokenValueLamports !== null).map((p) => ({ t: p.t, v: num(p.tokenValueLamports) }));
  const p1 = drift(prim), p2 = drift(sec);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="spread"><span className="tag">token per share · price-free (primary)</span><span className="mono" style={{ color: p1.changePct >= 0 ? "var(--sage-ink)" : "var(--amber-ink)" }}>{fmtChange(p1.changePct)}</span></div>
        <MiniChart pts={p1.norm} stroke="var(--gold)" />
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <div className="spread">
          <span className="tag" style={{ color: "var(--ink-faint)" }}>SOL value at TWAP · price-dependent (secondary)</span>
          <span className="mono faint">{sec.length >= 2 ? fmtChange(p2.changePct) : "—"}</span>
        </div>
        {sec.length >= 2
          ? <MiniChart pts={p2.norm} stroke="var(--ink2)" height={70} />
          : <div className="faint" style={{ fontSize: 11.5 }}>needs LIVE-price samples (keeper up) — the price-dependent series is withheld while the pool is stale.</div>}
        <div className="faint" style={{ fontSize: 11.5 }}>the primary series is manipulation-immune; this one moves with the AMM price and is shown only when the CLMM TWAP was LIVE.</div>
      </div>
      <div className="faint" style={{ fontSize: 11.5 }}>history begins {since} · {prim.length} samples</div>
      <IndexerNote compact />
    </div>
  );
}

// -------------------- recent spins feed --------------------

export function RecentSpins({ machine, kind, tokenDecimals }: { machine: string; kind: "single" | "dual"; tokenDecimals?: number | null }) {
  const [rows, setRows] = useState<SpinRow[] | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setRows(undefined);
    fetchSpins(machine, 25).then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [machine]);

  if (!indexerEnabled()) return null;
  if (rows === undefined) return null;
  if (!rows || rows.length === 0) return null;

  const dec = tokenDecimals ?? 9;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="spread" style={{ flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ fontSize: 20 }}>Recent spins</h3>
        <VerifyBadgeLegend />
      </div>
      <div className="stack" style={{ gap: 8 }}>
        {rows.map((r) => {
          const reels = r.reels ? r.reels.split("|").join(" · ") : "—";
          const payout = r.payout === null ? "—"
            : kind === "dual" ? `${fmtTokens(BigInt(r.payout), dec)} CHIP` : `${fmtLamports(BigInt(r.payout))} lamports`;
          return (
            <div key={r.signature} className="panel pad spread" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <div className="mono" style={{ fontSize: 13.5 }}>{reels} &nbsp; <span className="muted">payout {payout}</span></div>
              <div className="row" style={{ gap: 10, alignItems: "center" }}>
                <VerifyBadge status={r.verifyStatus} title={r.verifyDetail ?? undefined} />
                <a className="link mono" href={solscanTx(r.signature)} target="_blank" rel="noreferrer" style={{ fontSize: 12.5 }}>{shortKey(r.signature)} ↗</a>
              </div>
            </div>
          );
        })}
      </div>
      <IndexerNote />
    </div>
  );
}

function VerifyBadgeLegend() {
  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
      <VerifyBadge status="verified" />
      <VerifyBadge status="partial" />
      <VerifyBadge status="unverifiable" />
    </div>
  );
}
