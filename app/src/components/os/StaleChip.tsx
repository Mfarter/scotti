import { useEffect, useState } from "react";
import { StatusChip } from "./controls.tsx";

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** The amber "stale, retrying" chip shown in a section header while the RPC is
 * rate-limiting reads but last-good data is still on screen. Mono, with a live
 * last-updated age. Never replaces the data — it annotates it. */
export function StaleChip({ lastUpdated, label = "RPC rate-limited — retrying" }: { lastUpdated: number | null; label?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return (
    <StatusChip tone="amber" title="the RPC is rate-limiting reads — showing the last-good data and retrying with backoff">
      {label}{lastUpdated ? ` · updated ${ago(lastUpdated)}` : ""}
    </StatusChip>
  );
}
