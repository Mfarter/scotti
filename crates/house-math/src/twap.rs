//! TWAP from Raydium cumulative-tick observations.
//!
//! Observations store `tick_cumulative` (accrues prior_tick × elapsed) against a
//! u32 `block_timestamp`. The time-weighted average tick over a window is
//! `(cum_now − cum_then) / (t_now − t_then)`, and the machine turns that into a
//! price via [`crate::price::price_1e12_at_tick`]. This is the on-chain twin of
//! scripts/twap.ts, ground-truthed against the live pool in H6a.
//!
//! Discipline: u32 timestamps and i64 cumulatives are read straight from account
//! bytes, so both can wrap. All deltas use wrapping arithmetic and are correct
//! across a wrap as long as the true interval is < 2^31 s (~68 years) — always
//! true for a TWAP window. Staleness and an uncovered window are explicit STALE
//! states, never panics.

use crate::price::price_1e12_at_tick;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaleReason {
    /// Newest observation older than `max_staleness` — the pool went quiet.
    Stale,
    /// The two samples don't span at least `min_window` (cold-start / one obs).
    WindowNotCovered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TwapRead {
    Live { avg_tick: i64 },
    NotReady(StaleReason),
}

/// Signed seconds elapsed from `t_old` to `t_now`, correct across a u32 wrap
/// (true interval assumed < 2^31 s). Returns the elapsed as u32 magnitude.
#[inline]
pub fn elapsed_secs(t_old: u32, t_now: u32) -> u32 {
    t_now.wrapping_sub(t_old)
}

/// Time-weighted average tick between two cumulative-tick samples.
/// Returns `None` for a zero-length window (single observation / equal stamps).
/// Wrapping subtraction makes both the u32 timestamp and i64 cumulative wrap-safe.
pub fn avg_tick(cum_old: i64, t_old: u32, cum_now: i64, t_now: u32) -> Option<i64> {
    let dt = elapsed_secs(t_old, t_now);
    if dt == 0 {
        return None;
    }
    let dcum = cum_now.wrapping_sub(cum_old);
    Some(dcum / dt as i64)
}

/// Full TWAP gate: apply the staleness and window-coverage rules, then average.
/// `now` is the current (cluster) time; `t_now`/`cum_now` are the newest sample.
pub fn twap_read(
    cum_old: i64,
    t_old: u32,
    cum_now: i64,
    t_now: u32,
    now: u32,
    min_window: u32,
    max_staleness: u32,
) -> TwapRead {
    // staleness gate: refuse if the freshest observation is too old (spec §2.2).
    if elapsed_secs(t_now, now) > max_staleness {
        return TwapRead::NotReady(StaleReason::Stale);
    }
    // coverage gate: the samples must span the window (cold-start otherwise).
    if elapsed_secs(t_old, t_now) < min_window {
        return TwapRead::NotReady(StaleReason::WindowNotCovered);
    }
    match avg_tick(cum_old, t_old, cum_now, t_now) {
        Some(avg_tick) => TwapRead::Live { avg_tick },
        None => TwapRead::NotReady(StaleReason::WindowNotCovered),
    }
}

/// Convenience: a LIVE TWAP read as a 1e12-scaled price (token per SOL).
pub fn twap_price_1e12(read: TwapRead) -> Option<u128> {
    match read {
        TwapRead::Live { avg_tick } => Some(price_1e12_at_tick(avg_tick as i32)),
        TwapRead::NotReady(_) => None,
    }
}

#[cfg(test)]
mod proofs {
    use super::*;

    /// PROOF: a constant tick over the window averages back to exactly that tick,
    /// i.e. the cumulative-accrual model (cum += tick·Δt) inverts cleanly. This is
    /// the identity the H6a swap ground-truth confirmed on-chain (ΔtickCum/Δt =
    /// prior tick).
    #[test]
    fn constant_tick_recovers() {
        let tick = 69081i64;
        let (t_old, t_now) = (1_000u32, 1_300u32); // 300s window
        let cum_old = 5_000_000i64;
        let cum_now = cum_old + tick * (t_now - t_old) as i64;
        assert_eq!(avg_tick(cum_old, t_old, cum_now, t_now), Some(tick));
        assert_eq!(
            twap_read(cum_old, t_old, cum_now, t_now, t_now, 300, 90),
            TwapRead::Live { avg_tick: tick }
        );
    }

    /// PROOF: negative average from a falling cumulative (price dropping).
    #[test]
    fn negative_avg_tick() {
        let tick = -50i64;
        let cum_old = 1_000i64;
        let cum_now = cum_old + tick * 20; // over 20s
        assert_eq!(avg_tick(cum_old, 0, cum_now, 20), Some(-50));
    }

    /// PROOF (edge: single observation): a zero-length window is None / STALE,
    /// never a divide-by-zero.
    #[test]
    fn single_observation_is_not_ready() {
        assert_eq!(avg_tick(123, 500, 999, 500), None);
        assert_eq!(
            twap_read(123, 500, 999, 500, 500, 300, 90),
            TwapRead::NotReady(StaleReason::WindowNotCovered)
        );
    }

    /// PROOF (edge: cold-start): samples that don't span the window are STALE
    /// with WindowNotCovered, matching the twap-status cold-start state.
    #[test]
    fn cold_start_window_not_covered() {
        // only 42s of history vs a 300s window (the exact H6a cold-start case)
        let r = twap_read(0, 1000, 68912 * 42, 1042, 1042, 300, 90);
        assert_eq!(r, TwapRead::NotReady(StaleReason::WindowNotCovered));
    }

    /// PROOF (edge: staleness gate): a fully-covered window still refuses if the
    /// newest observation is older than max_staleness (quiet pool).
    #[test]
    fn staleness_gate_fires() {
        let cum_old = 0i64;
        let cum_now = 69000 * 300;
        // window covered (300s) but newest sample is 200s old vs 90s max
        let r = twap_read(cum_old, 1000, cum_now, 1300, 1500, 300, 90);
        assert_eq!(r, TwapRead::NotReady(StaleReason::Stale));
    }

    /// PROOF (edge: u32 timestamp wraparound): an interval straddling the u32
    /// epoch rollover computes the correct elapsed time and average.
    #[test]
    fn timestamp_wraparound() {
        let t_old = u32::MAX - 5; // 6s before rollover
        let t_now = 10u32; // 10s after → true interval 16s
        assert_eq!(elapsed_secs(t_old, t_now), 16);
        let tick = 42i64;
        let cum_old = 100i64;
        let cum_now = cum_old + tick * 16;
        assert_eq!(avg_tick(cum_old, t_old, cum_now, t_now), Some(42));
    }

    /// PROOF (edge: i64 cumulative wraparound): tick_cumulative overflowing i64
    /// still yields the right delta via wrapping subtraction.
    #[test]
    fn cumulative_wraparound() {
        let dt = 100u32;
        let tick = 1_000i64;
        let cum_old = i64::MAX - 20_000; // near the top
        let cum_now = cum_old.wrapping_add(tick * dt as i64); // wraps negative
        assert!(cum_now < 0, "test setup should wrap");
        assert_eq!(avg_tick(cum_old, 0, cum_now, dt), Some(tick));
    }

    /// PROOF: a LIVE read maps to a sane 1e12 price; NotReady maps to None.
    #[test]
    fn live_read_prices() {
        let live = TwapRead::Live { avg_tick: 0 };
        assert_eq!(twap_price_1e12(live), Some(1_000_000_000_000));
        assert_eq!(twap_price_1e12(TwapRead::NotReady(StaleReason::Stale)), None);
    }
}
