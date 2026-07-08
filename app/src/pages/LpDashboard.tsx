// The pools-dashboard header of the Liquidity page (UI-3): three stat Windows
// with sparklines + a search box + a machine table (single and dual in one list).
// Pure presentation over useDashboard's client-side aggregation; row selection
// drives the existing per-machine detail below, and each row's Deposit button opens
// the machine's deposit modal (the transaction/validation logic lives unchanged in
// Lp/DualLpPanel). The APR column is trailing REALIZED share-price drift annualized
// from the measured window — qualified as such and never a promised rate.
import { useState } from "react";
import { FloorEntry, DualFloorEntry } from "../lib/hooks.ts";
import { useDashboard, DashRow, Pt } from "../lib/dashboard.ts";
import { fmtSol, fmtTokens } from "../lib/format.ts";
import { TierBadge, PriceChip } from "../components/ui.tsx";
import { Window, StatusChip, GlossButton } from "../components/os/index.ts";
import { Sparkline } from "../components/Indexed.tsx";

const signedColor = (x: number | bigint): string =>
  x < 0 ? "var(--rose-ink)" : x > 0 ? "var(--sage-ink)" : "var(--ink)";
const signedSol = (x: bigint): string => `${x > 0n ? "+" : ""}${fmtSol(x, 4)}`;
const signedApr = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(1)}%`;

/** deferred marker — the honest "needs the indexer" placeholder (never faked). */
function Deferred({ compact }: { compact?: boolean }) {
  return <span className="faint" title="needs the Scotti indexer — not shown rather than faked" style={{ fontSize: compact ? 12 : 12.5 }}>—{compact ? "" : " deferred"}</span>;
}

function StatCard({ title, icon, big, bigColor, sub, spark, sparkStroke, indexerOn }: {
  title: string; icon: string; big: React.ReactNode; bigColor?: string; sub?: React.ReactNode;
  spark: Pt[]; sparkStroke: string; indexerOn: boolean;
}) {
  return (
    <Window icon={icon} title={title} bodyStyle={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div className="num" style={{ fontFamily: "var(--serif)", fontWeight: 700, fontSize: 30, lineHeight: 1.05, color: bigColor ?? "var(--ink)" }}>{big}</div>
      {sub != null && <div style={{ minHeight: 16 }}>{sub}</div>}
      <div style={{ marginTop: 2 }}>{indexerOn ? <Sparkline pts={spark} stroke={sparkStroke} /> : <span className="faint" style={{ fontSize: 11 }}>sparkline needs the indexer</span>}</div>
    </Window>
  );
}

const GRID = "minmax(180px, 2.1fr) 1.2fr 0.9fr 0.9fr 1fr 108px 22px";

function Cell({ children, align = "left", style }: { children: React.ReactNode; align?: "left" | "right"; style?: React.CSSProperties }) {
  return <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: align === "right" ? "flex-end" : "flex-start", gap: 3, textAlign: align, ...style }}>{children}</div>;
}

function Row({ r, active, onSelect, onDeposit }: { r: DashRow; active: boolean; onSelect: () => void; onDeposit: () => void }) {
  const dec = r.liqTokenDecimals ?? 9;
  return (
    <div role="button" tabIndex={0} onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      className="os-row" data-active={active ? "1" : undefined}
      style={{ display: "grid", gridTemplateColumns: GRID, gap: 12, alignItems: "center", padding: "12px 14px", cursor: "pointer", borderTop: "1px solid var(--line)" }}>
      <Cell>
        <span className="mono" style={{ fontWeight: 700, color: "var(--ink)" }}>{r.name}</span>
        <span>
          {r.kind === "single"
            ? <TierBadge tier={r.tier!} topMult={r.topMult!} paused={r.paused} />
            : <span className="row" style={{ gap: 6, flexWrap: "wrap" }}><StatusChip tone="peach" dot={false}>{r.poolSetLen && r.poolSetLen >= 1 ? `${r.poolSetLen}-pool set` : "dual"}</StatusChip>{r.poolSetLen && r.poolSetLen >= 1 ? <span className="faint mono" style={{ fontSize: 11 }}>{r.eligiblePools}/{r.poolSetLen}</span> : null}<PriceChip kind={r.priceKind!} label={r.priceLabel!} title={r.priceReason} /></span>}
        </span>
      </Cell>
      <Cell align="right">
        {r.kind === "single"
          ? <span className="mono">{fmtSol(r.liqLamports!, 3)} <span className="faint">SOL</span></span>
          : <>
              <span className="mono">{fmtTokens(r.liqTokens!, dec, 0)} <span className="faint">CHIP</span></span>
              {r.liqLamports !== null
                ? <span className="faint mono" style={{ fontSize: 11.5 }}>≈ {fmtSol(r.liqLamports, 3)} SOL</span>
                : <span className="faint" style={{ fontSize: 11.5 }}>token depth</span>}
            </>}
      </Cell>
      <Cell align="right">{r.vol24h !== null ? <span className="mono">{fmtSol(r.vol24h, 3)}</span> : <Deferred compact />}</Cell>
      <Cell align="right">{r.take24h !== null
        ? <span className="mono" style={{ color: signedColor(r.take24h) }}>{signedSol(r.take24h)}{r.takeGap ? <span className="faint" title="a dual spin lacked a recorded price; excluded from take">*</span> : null}</span>
        : <Deferred compact />}</Cell>
      <Cell align="right">{r.aprPct !== null
        ? <span className="mono" style={{ color: signedColor(r.aprPct) }}>{signedApr(r.aprPct)}{r.windowDays !== null && r.windowDays < 3
            ? <span title="short window — treat as noise" style={{ color: "var(--amber-ink)", cursor: "help", marginLeft: 2 }}>*</span> : null}</span>
        : <Deferred compact />}</Cell>
      <Cell align="right">
        <GlossButton sm variant={r.kind === "single" ? "pink" : "peach"} onClick={(e) => { e.stopPropagation(); onDeposit(); }}>Deposit</GlossButton>
      </Cell>
      <Cell align="right"><span className="faint" style={{ fontSize: 16 }}>›</span></Cell>
    </div>
  );
}

export function LpDashboard({ singles, duals, activePk, onSelect, onDeposit }: {
  singles: FloorEntry[] | null; duals: DualFloorEntry[] | null;
  activePk: string | null; onSelect: (pk: string, kind: "single" | "dual") => void;
  onDeposit: (pk: string, kind: "single" | "dual") => void;
}) {
  const d = useDashboard(singles, duals);
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const rows = query ? d.rows.filter((r) => r.name.toLowerCase().includes(query) || r.pubkey.toLowerCase().includes(query)) : d.rows;

  const tvlSub = d.staleTokenDepth.length > 0
    ? <span className="faint mono" style={{ fontSize: 11.5 }}>+ {d.staleTokenDepth.map((s) => `${fmtTokens(s.tokens, s.dec, 0)} CHIP`).join(" · ")} token depth (stale)</span>
    : <span className="faint" style={{ fontSize: 11.5 }}>SOL-valued pool liquidity</span>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
        <StatCard icon="◈" title="TVL" indexerOn={d.indexerOn} spark={d.tvlSpark} sparkStroke="var(--gold)"
          big={<>{fmtSol(d.tvlLamports, 2)} <span className="faint" style={{ fontSize: 15 }}>SOL</span></>} sub={tvlSub} />
        <StatCard icon="◇" title="24h volume" indexerOn={d.indexerOn} spark={d.volSpark} sparkStroke="var(--gold)"
          big={d.vol24h !== null ? <>{fmtSol(d.vol24h, 3)} <span className="faint" style={{ fontSize: 15 }}>SOL</span></> : <Deferred />}
          sub={<span className="faint" style={{ fontSize: 11.5 }}>wagers, trailing 24h</span>} />
        <StatCard icon="◇" title="24h house take" indexerOn={d.indexerOn} spark={d.takeSpark} sparkStroke="var(--ink2)"
          big={d.take24h !== null ? <span style={{ color: signedColor(d.take24h) }}>{signedSol(d.take24h)} <span className="faint" style={{ fontSize: 15 }}>SOL</span></span> : <Deferred />}
          bigColor="var(--ink)"
          sub={<span className="faint" style={{ fontSize: 11.5 }}>realized edge{d.takeGap ? " · *some dual spins unpriced" : " (may be negative)"}</span>} />
      </div>

      <input className="input mono" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter machines by name or address…" style={{ fontSize: 13 }} />

      <Window icon="◇" title="Pools" bodyStyle={{ padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 640 }}>
            <div style={{ display: "grid", gridTemplateColumns: GRID, gap: 12, padding: "10px 14px" }}>
              <span className="tag">machine</span>
              <span className="tag" style={{ textAlign: "right" }}>liquidity</span>
              <span className="tag" style={{ textAlign: "right" }}>24h vol</span>
              <span className="tag" style={{ textAlign: "right" }}>24h take</span>
              <span className="tag" title="annualized from measured share-price history — not a promised rate" style={{ textAlign: "right", cursor: "help" }}>apr <span className="faint" style={{ textTransform: "none", letterSpacing: 0 }}>(trailing, realized)</span></span>
              <span className="tag" style={{ textAlign: "right" }}>deposit</span>
              <span />
            </div>
            {!singles && !duals && <div className="muted spin-anim" style={{ padding: "14px" }}>Reading the floor…</div>}
            {rows.map((r) => <Row key={r.pubkey} r={r} active={r.pubkey === activePk} onSelect={() => onSelect(r.pubkey, r.kind)} onDeposit={() => onDeposit(r.pubkey, r.kind)} />)}
            {(singles || duals) && rows.length === 0 && <div className="muted" style={{ padding: "14px" }}>No machines match “{q}”.</div>}
          </div>
        </div>
      </Window>
    </div>
  );
}
