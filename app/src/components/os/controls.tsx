import React from "react";

type GlossVariant = "pink" | "peach" | "silver";

/** Tall, rounded, vertical-gloss button with an inset top highlight, drop
 * shadow and an :active press. Ink mono text, letter-spaced. Keyboard focus
 * ring in ink. A drop-in styled <button>. */
export function GlossButton({
  variant = "silver", big, sm, className, children, ...rest
}: { variant?: GlossVariant; big?: boolean; sm?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = ["os-btn", variant, big ? "big" : "", sm ? "sm" : "", className ?? ""].filter(Boolean).join(" ");
  return <button className={cls} {...rest}>{children}</button>;
}

/** The system-bar pill. */
export function Tile({ dot, className, children, ...rest }: { dot?: "sage" | "amber" | "neutral" } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={`os-tile${className ? " " + className : ""}`} {...rest}>
      {dot && <span className={`os-dot${dot !== "neutral" ? " " + dot : ""}`} aria-hidden />}
      {children}
    </span>
  );
}

export function Tag({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span className="tag" style={style}>{children}</span>;
}

type ChipTone = "sage" | "amber" | "neutral" | "pink" | "peach";
/** sage / amber (etc.) state chip with a leading status dot. */
export function StatusChip({ tone = "neutral", dot = true, title, children }: { tone?: ChipTone; dot?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <span className={`os-chip ${tone}`} title={title}>
      {dot && <span className="os-chip-dot" aria-hidden />}
      {children}
    </span>
  );
}

/** A mini gloss stat box (label kicker + value). */
export function StatCell({ k, children, valueColor }: { k: string; children: React.ReactNode; valueColor?: string }) {
  return (
    <div className="os-statcell">
      <span className="k">{k}</span>
      <span className="v" style={valueColor ? { color: valueColor } : undefined}>{children}</span>
    </div>
  );
}

/** A horizontal row of StatCells on the responsive auto-fit grid. */
export function StatRow({ children, min = 150 }: { children: React.ReactNode; min?: number }) {
  return <div className="grid" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))` }}>{children}</div>;
}

/** Mono kicker + stamped serif H1 + mono subline. */
export function SectionHeader({ kicker, title, subline, titleSize = 34 }: { kicker?: React.ReactNode; title: React.ReactNode; subline?: React.ReactNode; titleSize?: number }) {
  return (
    <div className="os-sectionheader">
      {kicker != null && <div className="kicker">{kicker}</div>}
      <h1 style={{ fontSize: titleSize }}>{title}</h1>
      {subline != null && <div className="subline">{subline}</div>}
    </div>
  );
}
