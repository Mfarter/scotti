// H6a — TWAP-from-cumulative-ticks, the off-chain twin of the house-math Rust
// helper. Raydium observations store CUMULATIVE tick (tick_cumulative accrues
// prior_tick × elapsed). TWAP over window W:
//     avg_tick = (cum(now) − cum(now−W)) / W ;  price = 1.0001^avg_tick
// where cum(t) is reconstructed from the ring by interpolation, and cum(now) is
// EXTRAPOLATED from the newest observation using the pool's current tick — the
// same "observe()" trick the on-chain oracle uses.
import { OBS, decodeObs } from "./layouts.ts";

export const TWAP_WINDOW_SECS = 300; // 5-minute demo window (spec default 30 min)
export const MAX_STALENESS_SECS = 90; // newest obs must be fresher than this
export const BAND_BP = 300; // 3% spot-vs-TWAP gate

export interface Obs { ts: number; tickCum: bigint; }

/** All initialized observations (ts>0), de-duplicated, sorted ascending by ts. */
export function collectObservations(obsBuf: Buffer): Obs[] {
  const view = decodeObs(obsBuf);
  const seen = new Map<number, bigint>();
  for (let i = 0; i < OBS.COUNT; i++) {
    const o = view.at(i);
    if (o.blockTimestamp > 0) seen.set(o.blockTimestamp, o.tickCumulative);
  }
  return [...seen.entries()].map(([ts, tickCum]) => ({ ts, tickCum })).sort((a, b) => a.ts - b.ts);
}

/** Cumulative tick at time `t`. Extrapolates past the newest obs using currentTick.
 *  Returns null if `t` is older than the oldest observation (no coverage). */
export function cumulativeAt(obs: Obs[], currentTick: number, t: number): bigint | null {
  if (obs.length === 0) return null;
  const newest = obs[obs.length - 1];
  if (t >= newest.ts) return newest.tickCum + BigInt(currentTick) * BigInt(t - newest.ts);
  const oldest = obs[0];
  if (t < oldest.ts) return null;
  for (let i = obs.length - 1; i > 0; i--) {
    const b = obs[i], a = obs[i - 1];
    if (t >= a.ts && t <= b.ts) {
      if (b.ts === a.ts) return a.tickCum;
      // rate = (b.cum-a.cum)/(b.ts-a.ts); interpolate. Use integer-ish float; ticks large.
      const rate = Number(b.tickCum - a.tickCum) / (b.ts - a.ts);
      return a.tickCum + BigInt(Math.round(rate * (t - a.ts)));
    }
  }
  return null;
}

export type TwapStatus = "LIVE" | "STALE";
export interface TwapResult {
  status: TwapStatus;
  reason: string;
  avgTick: number | null;
  price: number | null; // token per SOL (CHIP/SOL) — the numeraire the machine snapshots
  windowSecs: number;
  coverageSecs: number; // how much history the ring actually holds
  staleSecs: number; // age of the newest observation
  obsCount: number;
}

export function computeTwap(
  obs: Obs[], currentTick: number, now: number,
  windowSecs = TWAP_WINDOW_SECS, maxStaleness = MAX_STALENESS_SECS,
): TwapResult {
  const base = { windowSecs, obsCount: obs.length };
  if (obs.length === 0)
    return { status: "STALE", reason: "cold-start: no observations yet", avgTick: null, price: null, coverageSecs: 0, staleSecs: Infinity, ...base };

  const newest = obs[obs.length - 1], oldest = obs[0];
  const staleSecs = now - newest.ts;
  const coverageSecs = newest.ts - oldest.ts;

  const cumNow = cumulativeAt(obs, currentTick, now)!;
  const cumThen = cumulativeAt(obs, currentTick, now - windowSecs);
  if (cumThen === null)
    return { status: "STALE", reason: `cold-start: history ${coverageSecs}s < window ${windowSecs}s`, avgTick: null, price: null, coverageSecs, staleSecs, ...base };
  if (staleSecs > maxStaleness)
    return { status: "STALE", reason: `stale: newest obs ${staleSecs}s old > max ${maxStaleness}s`, avgTick: null, price: null, coverageSecs, staleSecs, ...base };

  const avgTick = Number(cumNow - cumThen) / windowSecs;
  return { status: "LIVE", reason: "ok", avgTick, price: Math.pow(1.0001, avgTick), coverageSecs, staleSecs, ...base };
}
