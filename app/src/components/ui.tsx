import { useEffect, useRef, useState } from "react";
import { fmtLamports, fmtSol, shortKey } from "../lib/format.ts";
import { solscanAcct, solscanTx } from "../lib/constants.ts";
import { JACKPOT, SEVEN, BELL, BAR, CHERRY, BLANK, SYMBOL_NAME } from "../lib/housemath.ts";

// Typographic reel glyphs — the machine's character comes from its numbers, not
// stock clip-art, so the symbols are restrained coloured marks.
const GLYPH: Record<number, string> = { [JACKPOT]: "◆", [SEVEN]: "7", [BELL]: "✦", [BAR]: "▬", [CHERRY]: "●", [BLANK]: "·" };
const GCOLOR: Record<number, string> = {
  [JACKPOT]: "var(--gold)", [SEVEN]: "var(--neon)", [BELL]: "#7aa2ff",
  [BAR]: "#e0b866", [CHERRY]: "#ff5a6e", [BLANK]: "var(--ink-faint)",
};

export function Sol({ lamports, dp = 4, unit = true }: { lamports: bigint; dp?: number; unit?: boolean }) {
  return <span className="mono">{fmtSol(lamports, dp)}{unit ? <span className="faint" style={{ fontSize: "0.8em" }}> SOL</span> : null}</span>;
}
export function Lam({ v }: { v: bigint }) {
  return <span className="mono">{fmtLamports(v)}<span className="faint" style={{ fontSize: "0.8em" }}> lamports</span></span>;
}

export function Stat({ k, children, color }: { k: string; children: React.ReactNode; color?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" style={color ? { color } : undefined}>{children}</div>
    </div>
  );
}

export function TierBadge({ tier, topMult, paused }: { tier: string; topMult: number; paused?: boolean }) {
  if (paused) return <span className="badge paused">Paused</span>;
  return <span className={`badge ${tier}`}>{tier} · {topMult}× top</span>;
}

/** The client-side price-status of a dual machine's pool: the SAME gate the
 * on-chain spin_commit_dual applies (staleness → STALE, band → PRICE UNSTABLE). */
export function PriceChip({ kind, label, title }: { kind: "LIVE" | "UNSTABLE" | "STALE"; label: string; title?: string }) {
  const color = kind === "LIVE" ? "var(--good, #57d9a3)" : kind === "UNSTABLE" ? "var(--gold)" : "var(--ink-faint)";
  const bg = kind === "LIVE" ? "rgba(87,217,163,0.10)" : kind === "UNSTABLE" ? "rgba(245,196,81,0.10)" : "rgba(255,255,255,0.05)";
  return (
    <span title={title} className="badge" style={{ color, borderColor: color, background: bg, display: "inline-flex", gap: 6, alignItems: "center" }}>
      <span aria-hidden style={{ width: 7, height: 7, borderRadius: 99, background: color, boxShadow: kind === "LIVE" ? `0 0 8px ${color}` : "none" }} />
      {label}
    </span>
  );
}

export function Solscan({ tx, acct, children }: { tx?: string; acct?: string; children?: React.ReactNode }) {
  const href = tx ? solscanTx(tx) : solscanAcct(acct!);
  const label = children ?? shortKey(tx ?? acct ?? "");
  return <a className="link mono" href={href} target="_blank" rel="noreferrer">{label} ↗</a>;
}

/** Three reels. Idle spins a blur of glyphs; settled shows the symbols. */
export function Reels({ symbols, spinning, glow }: { symbols: number[] | null; spinning: boolean; glow?: string }) {
  const [tick, setTick] = useState(0);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (spinning) {
      timer.current = window.setInterval(() => setTick((t) => t + 1), 90);
      return () => { if (timer.current) window.clearInterval(timer.current); };
    }
  }, [spinning]);
  const shown = (i: number): number => {
    if (spinning) return [JACKPOT, SEVEN, BELL, BAR, CHERRY, BLANK][(tick + i) % 6];
    return symbols ? symbols[i] : BLANK;
  };
  return (
    <div className="reels">
      {[0, 1, 2].map((i) => {
        const s = shown(i);
        return (
          <div key={i} className={`reel${spinning ? " spinning" : ""}`} style={glow && !spinning && symbols ? { borderColor: glow, boxShadow: `0 0 26px -6px ${glow}, inset 0 0 30px rgba(0,0,0,0.6)` } : undefined}>
            <span className="sym" style={{ color: GCOLOR[s] }} title={SYMBOL_NAME[s]}>{GLYPH[s]}</span>
          </div>
        );
      })}
    </div>
  );
}
