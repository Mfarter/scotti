//! On-chain Raydium CLMM price reader (H6b-3). Parses `PoolState` (spot, via
//! sqrt_price) and `ObservationState` (cumulative-tick TWAP) straight from raw
//! account bytes using the H6a PINNED offsets — the ones the `verify-layouts.ts`
//! regression guard checks against the live devnet program, NOT the published
//! structs. Reuses [`crate::price`] and [`crate::twap`]; no math is re-derived.
//!
//! Orientation assumption (the H6a demo pool): mintA = WSOL (9 dec, quote),
//! mintB = the machine's token, so `price = mintB per mintA = token per SOL`, and
//! with 9-dec tokens the raw ratio already equals whole-token-per-whole-SOL. The
//! caller owner-checks the accounts and matches the machine's stored pubkeys.
//!
//! The TWAP reproduces `scripts/twap.ts` exactly (verified in `ground_truth`):
//! `cum(now)` extrapolates the newest observation at the current tick, and
//! `cum(now−window)` interpolates the ring — both in integer arithmetic.

use crate::price::price_1e12_from_sqrt_x64;
use crate::twap::{avg_tick, StaleReason, TwapRead};

// ---- pinned PoolState offsets (span 1544) ----
pub const POOL_SPAN: usize = 1544;
pub const POOL_MINT_A: usize = 73;
pub const POOL_MINT_B: usize = 105;
pub const POOL_OBSERVATION_ID: usize = 201;
pub const POOL_SQRT_PRICE_X64: usize = 253;
pub const POOL_TICK_CURRENT: usize = 269;
// ---- pinned ObservationState offsets (span 4483) ----
pub const OBS_SPAN: usize = 4483;
pub const OBS_INDEX: usize = 17;
pub const OBS_POOL_ID: usize = 19;
pub const OBS_OBSERVATIONS: usize = 51;
pub const OBS_ITEM_STRIDE: usize = 44;
pub const OBS_ITEM_TS: usize = 0; // u32, relative to item start
pub const OBS_ITEM_CUM: usize = 4; // i64, relative to item start
pub const OBS_COUNT: usize = 100;

#[cfg(test)]
fn u16_le(b: &[u8], o: usize) -> u16 { u16::from_le_bytes([b[o], b[o + 1]]) }
fn u32_le(b: &[u8], o: usize) -> u32 { let mut a = [0u8; 4]; a.copy_from_slice(&b[o..o + 4]); u32::from_le_bytes(a) }
fn i32_le(b: &[u8], o: usize) -> i32 { let mut a = [0u8; 4]; a.copy_from_slice(&b[o..o + 4]); i32::from_le_bytes(a) }
fn i64_le(b: &[u8], o: usize) -> i64 { let mut a = [0u8; 8]; a.copy_from_slice(&b[o..o + 8]); i64::from_le_bytes(a) }
fn u128_le(b: &[u8], o: usize) -> u128 { let mut a = [0u8; 16]; a.copy_from_slice(&b[o..o + 16]); u128::from_le_bytes(a) }

/// PoolState.sqrt_price (Q64.64), pinned offset 253.
pub fn pool_sqrt_price_x64(pool: &[u8]) -> u128 { u128_le(pool, POOL_SQRT_PRICE_X64) }
/// PoolState.tick_current (i32), pinned offset 269.
pub fn pool_tick_current(pool: &[u8]) -> i32 { i32_le(pool, POOL_TICK_CURRENT) }
/// Spot price scaled 1e12 from PoolState.sqrt_price (equal-decimals orientation).
pub fn pool_spot_1e12(pool: &[u8]) -> u128 { price_1e12_from_sqrt_x64(pool_sqrt_price_x64(pool)) }
/// PoolState.observation_id / ObservationState.pool_id — 32-byte pubkeys, for the
/// caller's cross-link checks (pool ↔ observation).
pub fn pool_observation_id(pool: &[u8]) -> [u8; 32] { let mut k = [0u8; 32]; k.copy_from_slice(&pool[POOL_OBSERVATION_ID..POOL_OBSERVATION_ID + 32]); k }
pub fn obs_pool_id(obs: &[u8]) -> [u8; 32] { let mut k = [0u8; 32]; k.copy_from_slice(&obs[OBS_POOL_ID..OBS_POOL_ID + 32]); k }

fn obs_item(obs: &[u8], i: usize) -> (u32, i64) {
    let off = OBS_OBSERVATIONS + i * OBS_ITEM_STRIDE;
    (u32_le(obs, off + OBS_ITEM_TS), i64_le(obs, off + OBS_ITEM_CUM))
}

/// The parsed CLMM price reading. `twap` is the raw TWAP outcome (staleness is
/// the caller's gate, via `newest_obs_age_secs`); `NotReady` means the ring
/// doesn't cover the window (cold-start).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClmmReading {
    pub spot_1e12: u128,
    pub twap: TwapRead,
    pub newest_obs_age_secs: u32,
    pub obs_count: u32,
    pub coverage_secs: u32,
}

/// Parse spot + TWAP from raw PoolState/ObservationState bytes. `now` is the
/// current unix time (u32, matching the observation timestamps); `window_secs`
/// is the TWAP window. Returns `None` only on a length/shape failure (the caller
/// has already owner-checked the accounts). Reproduces scripts/twap.ts exactly.
pub fn read_clmm_price(pool: &[u8], obs: &[u8], now: u32, window_secs: u32) -> Option<ClmmReading> {
    if pool.len() < POOL_SPAN || obs.len() < OBS_SPAN {
        return None;
    }
    let spot_1e12 = pool_spot_1e12(pool);
    let cur_tick = pool_tick_current(pool);
    let target = now.wrapping_sub(window_secs); // now ≫ window for real timestamps

    // one scan: newest (max ts), oldest (min ts), and the bracket a≤target≤b.
    let mut newest_ts = 0u32;
    let mut newest_cum = 0i64;
    let mut oldest_ts = u32::MAX;
    let mut count = 0u32;
    let (mut a_ts, mut a_cum, mut a_found) = (0u32, 0i64, false);
    let (mut b_ts, mut b_cum, mut b_found) = (u32::MAX, 0i64, false);
    for i in 0..OBS_COUNT {
        let (ts, cum) = obs_item(obs, i);
        if ts == 0 {
            continue; // uninitialized slot
        }
        count += 1;
        if ts > newest_ts { newest_ts = ts; newest_cum = cum; }
        if ts < oldest_ts { oldest_ts = ts; }
        if ts <= target && (!a_found || ts > a_ts) { a_ts = ts; a_cum = cum; a_found = true; }
        if ts >= target && (!b_found || ts < b_ts) { b_ts = ts; b_cum = cum; b_found = true; }
    }
    if count == 0 {
        return Some(ClmmReading { spot_1e12, twap: TwapRead::NotReady(StaleReason::WindowNotCovered), newest_obs_age_secs: u32::MAX, obs_count: 0, coverage_secs: 0 });
    }
    let age = now.wrapping_sub(newest_ts);
    let coverage = newest_ts.wrapping_sub(oldest_ts);

    // cum(now): extrapolate the newest observation at the current tick.
    let cum_now = if now >= newest_ts {
        newest_cum.wrapping_add(cur_tick as i64 * (now - newest_ts) as i64)
    } else {
        newest_cum
    };
    // cum(now − window): extrapolate if target is past the newest, else interpolate the ring.
    let cum_then: Option<i64> = if target >= newest_ts {
        Some(newest_cum.wrapping_add(cur_tick as i64 * (target - newest_ts) as i64))
    } else if !a_found {
        None // target older than the oldest observation → window not covered
    } else if !b_found || a_ts == b_ts {
        Some(a_cum)
    } else {
        // integer interpolation, matching scripts/twap.ts::cumulativeAt to the unit
        Some(a_cum + (b_cum - a_cum) * (target - a_ts) as i64 / (b_ts - a_ts) as i64)
    };

    let twap = match cum_then {
        Some(ct) => match avg_tick(ct, target, cum_now, now) {
            Some(a) => TwapRead::Live { avg_tick: a },
            None => TwapRead::NotReady(StaleReason::WindowNotCovered),
        },
        None => TwapRead::NotReady(StaleReason::WindowNotCovered),
    };
    Some(ClmmReading { spot_1e12, twap, newest_obs_age_secs: age, obs_count: count, coverage_secs: coverage })
}

#[cfg(test)]
mod proofs {
    use super::*;
    use crate::price::price_1e12_at_tick;

    const POOL_BYTES: &[u8] = include_bytes!("../fixtures/clmm_pool.bin");
    const OBS_BYTES: &[u8] = include_bytes!("../fixtures/clmm_obs.bin");

    /// PROOF (ground truth): the parser fed CAPTURED LIVE devnet bytes reads the
    /// pinned offsets correctly and reproduces the H6a twap-status computation
    /// exactly. Reference values pinned from scripts/twap.ts + layouts.ts against
    /// the same bytes (pool 9n6LAVick…, observation 7nPBDXZ…, captured 2026-07-06):
    ///   sqrt_price_x64 575415330658078091153, tick 68807, spot 973.0237 CHIP/SOL,
    ///   observation index 11, newest ts 1783301680 / cum 44286166, 12 obs, 645s
    ///   coverage; TWAP over 300s @ now=newest → avg_tick 68517.
    #[test]
    fn ground_truth_matches_h6a() {
        assert_eq!(POOL_BYTES.len(), POOL_SPAN, "pool fixture span");
        assert_eq!(OBS_BYTES.len(), OBS_SPAN, "obs fixture span");

        // spot: bit-exact against the pinned integer (== round(973.0236854537752e12)).
        assert_eq!(pool_sqrt_price_x64(POOL_BYTES), 575415330658078091153);
        assert_eq!(pool_tick_current(POOL_BYTES), 68807);
        assert_eq!(pool_spot_1e12(POOL_BYTES), 973023685453775, "spot_1e12 == H6a to the unit");

        // the observation offsets: index and the newest + a couple of ring entries
        // (from the H6a-captured cumulative-tick series).
        assert_eq!(u16_le(OBS_BYTES, OBS_INDEX), 11, "observationIndex @17");
        assert_eq!(obs_item(OBS_BYTES, 11), (1783301680, 44286166), "newest observation @ index 11");
        assert_eq!(obs_item(OBS_BYTES, 0), (1783301035, 0), "first observation (cold seed)");
        assert_eq!(obs_item(OBS_BYTES, 1), (1783301056, 1447152), "second observation");
        // the pool↔observation cross-link fields are present (32-byte pubkeys, the
        // on-chain reader require_keys_eq's them against the machine's stored ids).
        assert_ne!(pool_observation_id(POOL_BYTES), [0u8; 32], "pool stores an observation id");
        assert_ne!(obs_pool_id(OBS_BYTES), [0u8; 32], "observation stores a pool id");
    }

    /// PROOF: the TWAP over the ring reproduces H6a exactly at a fresh `now`.
    #[test]
    fn ground_truth_twap_matches_h6a() {
        // now = the newest observation's ts → fresh; window 300s (H6a demo window).
        let r = read_clmm_price(POOL_BYTES, OBS_BYTES, 1783301680, 300).unwrap();
        assert_eq!(r.obs_count, 12);
        assert_eq!(r.coverage_secs, 645);
        assert_eq!(r.newest_obs_age_secs, 0);
        match r.twap {
            TwapRead::Live { avg_tick } => {
                // integer avg_tick == scripts/twap.ts (its float 68517.70 floors here).
                assert_eq!(avg_tick, 68517, "TWAP avg_tick matches H6a");
                // and the fixed-point TWAP price is ~945 CHIP/SOL (H6a float 945.23).
                let twap_1e12 = price_1e12_at_tick(avg_tick as i32);
                assert!((945_000_000_000_000..=946_000_000_000_000).contains(&twap_1e12),
                    "twap_1e12 ~945e12: {twap_1e12}");
            }
            other => panic!("expected LIVE twap, got {other:?}"),
        }
    }

    /// PROOF: a `now` far past the newest observation (the live-STALE case: the
    /// keeper stopped) yields a huge age, which the caller's staleness gate uses
    /// to refuse — the reader itself never panics.
    #[test]
    fn stale_now_reports_large_age() {
        let r = read_clmm_price(POOL_BYTES, OBS_BYTES, 1783301680 + 20_000, 300).unwrap();
        assert!(r.newest_obs_age_secs >= 20_000, "age reflects the quiet pool");
    }

    /// PROOF: a cold ring (no initialized observations) is NotReady with a
    /// forced-huge age, so the caller refuses; spot is still readable.
    #[test]
    fn cold_ring_is_not_ready() {
        let mut obs = OBS_BYTES.to_vec();
        for i in 0..OBS_COUNT {
            let off = OBS_OBSERVATIONS + i * OBS_ITEM_STRIDE;
            for b in obs.iter_mut().skip(off).take(4) { *b = 0; } // zero every blockTimestamp
        }
        let r = read_clmm_price(POOL_BYTES, &obs, 1783301680, 300).unwrap();
        assert_eq!(r.twap, TwapRead::NotReady(StaleReason::WindowNotCovered));
        assert_eq!(r.newest_obs_age_secs, u32::MAX);
        assert_eq!(r.spot_1e12, 973023685453775, "spot still readable when cold");
    }
}
