// Client for the OPTIONAL Scotti indexer (../indexer). Every call fails soft: if
// VITE_INDEXER_URL is unset or the service is unreachable, these return null/[]
// and the UI shows exactly what it shows today (the deferred marker). The indexer
// is the app's first NON-chain-read data path, so anything it returns is rendered
// with a trust disclosure and each spin keeps its recompute status.
import { INDEXER_URL } from "./constants.ts";

export const indexerEnabled = () => INDEXER_URL !== "";

export type VerifyStatus = "verified" | "partial" | "unverifiable" | "mismatch";

export interface PricePoint {
  t: number; slot: number;
  // single-asset
  sharePrice1e12: string | null; poolValue: string | null; totalShares: string | null;
  // dual PRIMARY (price-free)
  sharePriceTokens1e12: string | null; tokenBalance: string | null;
  // dual SECONDARY (price-dependent)
  divPoolSol: string | null; twap1e12: string | null; tokenValueLamports: string | null; priceKind: string | null;
}
export interface PriceSeries {
  machine: string; kind: "single" | "dual"; label: string | null; tokenDecimals: number | null;
  firstIndexedTime: number | null; series: PricePoint[];
}
export interface SpinRow {
  signature: string; machine: string; kind: "single" | "dual"; slot: number; blockTime: number | null;
  player: string | null; nonce: string | null; wager: string | null; reels: string | null;
  payout: string | null; payoutKind: "lamports" | "tokens"; commitSig: string | null;
  priceAtCommit1e12: string | null; verifyStatus: VerifyStatus; verifyDetail: string | null;
}

async function get<T>(path: string): Promise<T | null> {
  if (!indexerEnabled()) return null;
  try {
    const r = await fetch(`${INDEXER_URL}${path}`, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null; // service down / CORS / offline → graceful degradation
  }
}

export const fetchHealth = () => get<{ ok: boolean; spins: number; lastIngestTime: string | null }>("/health");
export const fetchPriceSeries = (machine: string, opts?: { from?: number; to?: number; resolution?: number }) => {
  const q = new URLSearchParams();
  if (opts?.from) q.set("from", String(opts.from));
  if (opts?.to) q.set("to", String(opts.to));
  if (opts?.resolution) q.set("resolution", String(opts.resolution));
  const qs = q.toString();
  return get<PriceSeries>(`/machines/${machine}/price${qs ? `?${qs}` : ""}`);
};
export const fetchSpins = (machine: string, limit = 25) => get<SpinRow[]>(`/machines/${machine}/spins?limit=${limit}`);
