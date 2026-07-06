//! tick → price fixed-point, Uniswap/Raydium TickMath-style per-bit multipliers.
//!
//! The machine snapshots `price_at_commit` from a TWAP tick (§3). This module
//! turns a tick into `sqrt_price_x64` (Q64.64, bit-identical to the deployed
//! Raydium CLMM `get_sqrt_price_at_tick`) and into a 1e12-scaled price. Pinned
//! vectors are cross-checked two independent ways by
//! `proofs/tick_price_crosscheck.py` (the H0 Python discipline): the per-bit
//! integer algorithm here vs. `floor(sqrt(1.0001^tick) * 2^64)` at 120-digit
//! precision. Boundary ticks match Raydium's published MIN/MAX_SQRT_PRICE_X64
//! exactly, and tick 69081 brackets the live devnet pool's sqrt_price.
//!
//! Integer-exact throughout: `sqrt_price_x64_at_tick` stays in u128 (each
//! intermediate < 2^128 because the multipliers are all < 1.0 in Q64.64);
//! `price_1e12_at_tick` uses a 128×128→256-bit `full_mul` so squaring and
//! scaling never lose bits, with an explicit overflow guard.

pub const MIN_TICK: i32 = -443636;
pub const MAX_TICK: i32 = 443636;
/// get_sqrt_price_at_tick(MIN_TICK) / (MAX_TICK) — Raydium's published anchors.
pub const MIN_SQRT_PRICE_X64: u128 = 4295048016;
pub const MAX_SQRT_PRICE_X64: u128 = 79226673521066979257578248091;

/// Per-bit magic multipliers (Q64.64) for bits 2^0..2^18, verbatim from
/// raydium-clmm `libraries/tick_math.rs::get_sqrt_price_at_tick`.
const MAGIC: [u64; 19] = [
    0xfffcb933bd6fb800, 0xfff97272373d4000, 0xfff2e50f5f657000, 0xffe5caca7e10f000,
    0xffcb9843d60f7000, 0xff973b41fa98e800, 0xff2ea16466c9b000, 0xfe5dee046a9a3800,
    0xfcbe86c7900bb000, 0xf987a7253ac65800, 0xf3392b0822bb6000, 0xe7159475a2caf000,
    0xd097f3bdfd2f2000, 0xa9f746462d9f8000, 0x70d869a156f31c00, 0x31be135f97ed3200,
    0x09aa508b5b85a500, 0x005d6af8dedc582c, 0x00002216e584f5fa,
];

/// sqrt(1.0001^tick) in Q64.64. Bit-identical to the deployed CLMM program.
pub fn sqrt_price_x64_at_tick(tick: i32) -> u128 {
    assert!(tick >= MIN_TICK && tick <= MAX_TICK, "tick out of range");
    let abs = tick.unsigned_abs();
    let mut ratio: u128 = if abs & 0x1 != 0 { MAGIC[0] as u128 } else { 1u128 << 64 };
    let mut bit: u32 = 0x2;
    let mut i = 1usize;
    while i < 19 {
        if abs & bit != 0 {
            ratio = (ratio * MAGIC[i] as u128) >> 64;
        }
        bit <<= 1;
        i += 1;
    }
    if tick > 0 {
        ratio = u128::MAX / ratio;
    }
    ratio
}

/// 128×128 → 256-bit product, returned as (hi, lo). Exact, no external deps.
pub fn full_mul(x: u128, y: u128) -> (u128, u128) {
    let m: u128 = u64::MAX as u128;
    let (xl, xh) = (x & m, x >> 64);
    let (yl, yh) = (y & m, y >> 64);
    let ll = xl * yl;
    let lh = xl * yh;
    let hl = xh * yl;
    let hh = xh * yh;
    let mid = (ll >> 64) + (lh & m) + (hl & m); // < 3·2^64, fits u128
    let lo = (ll & m) | ((mid & m) << 64);
    let hi = hh + (lh >> 64) + (hl >> 64) + (mid >> 64); // math: < 2^128
    (hi, lo)
}

/// price (mintB per mintA, equal decimals) scaled by 1e12, from a tick.
/// price_1e12 = (sqrt_price_x64^2 · 1e12) >> 128, computed in 256-bit so the
/// square and the scale never truncate. Panics (overflow guard) for ticks whose
/// price would exceed u128 at 1e12 scale — far outside any machine's operating
/// range (|tick| well under ~207k, price under ~1e26).
pub fn price_1e12_at_tick(tick: i32) -> u128 {
    let s = sqrt_price_x64_at_tick(tick);
    let (phi, plo) = full_mul(s, s); // s^2 as a 256-bit (hi, lo)
    let (qhi, _qlo) = full_mul(plo, 1_000_000_000_000); // plo·1e12
    let (rhi, rlo) = full_mul(phi, 1_000_000_000_000); // phi·1e12  (aligned +128 bits)
    let (res, carry) = qhi.overflowing_add(rlo); // bits[128..256) of P·1e12
    assert!(rhi == 0 && !carry, "price_1e12 overflow: tick {tick} out of supported range");
    res
}

#[cfg(test)]
mod proofs {
    use super::*;

    /// (tick, sqrt_price_x64, price_1e12) — pinned from the per-bit algorithm and
    /// cross-verified against a 120-digit independent computation by
    /// proofs/tick_price_crosscheck.py (agreement asserted there; drift here means
    /// the magic table or the mul path changed).
    const PINNED: &[(i32, u128, u128)] = &[
        (-443636, 4295048016, 0),
        (-100000, 124324258983086206, 45422633),
        (-69081, 583337459652412570, 1000000660),
        (-10, 18437523468038803493, 999000549780),
        (-1, 18445821805675395072, 999900009999),
        (0, 18446744073709551616, 1000000000000),
        (1, 18447666387855957090, 1000099999999),
        (10, 18455969290605287889, 1001000450120),
        (69081, 583337074090354317156, 999999339041146),
        (69082, 583366240214924045618, 1000099338975051),
        (100000, 2737055259402209284734, 22015456048481850),
        (443636, 79226673521066979257578248091, 18446050713735950759526560806235),
    ];

    /// PROOF: pinned tick→sqrt and tick→price vectors reproduce exactly.
    #[test]
    fn pinned_vectors_reproduce() {
        for &(tick, sqrt, price) in PINNED {
            assert_eq!(sqrt_price_x64_at_tick(tick), sqrt, "sqrt drift at tick {tick}");
            assert_eq!(price_1e12_at_tick(tick), price, "price drift at tick {tick}");
        }
    }

    /// PROOF: boundary ticks equal Raydium's published MIN/MAX_SQRT_PRICE_X64,
    /// and tick 0 is exactly 1.0 (2^64) at par price 1e12. These exact-equality
    /// anchors validate the whole 19-multiplier chain.
    #[test]
    fn boundary_and_par_exact() {
        assert_eq!(sqrt_price_x64_at_tick(MIN_TICK), MIN_SQRT_PRICE_X64);
        assert_eq!(sqrt_price_x64_at_tick(MAX_TICK), MAX_SQRT_PRICE_X64);
        assert_eq!(sqrt_price_x64_at_tick(0), 1u128 << 64);
        assert_eq!(price_1e12_at_tick(0), 1_000_000_000_000);
    }

    /// PROOF: sqrt_price is strictly increasing in tick across a wide sweep —
    /// the property the on-chain get_tick_at_sqrt_price inversion relies on.
    #[test]
    fn strictly_monotone() {
        let mut prev = sqrt_price_x64_at_tick(-200_000);
        let mut t = -199_999;
        while t <= 200_000 {
            let cur = sqrt_price_x64_at_tick(t);
            assert!(cur > prev, "not increasing at tick {t}: {cur} <= {prev}");
            prev = cur;
            t += 337; // stride to keep the sweep fast but dense
        }
    }

    /// PROOF: reciprocal symmetry — sqrt(t)·sqrt(-t) ≈ 2^128 (since
    /// 1.0001^t · 1.0001^-t = 1). Holds to a tiny relative tolerance (the per-bit
    /// truncation), confirming negative ticks invert positive ones correctly.
    #[test]
    fn reciprocal_symmetry() {
        for &t in &[1i32, 10, 1000, 69081, 100_000, 200_000] {
            let (hi, lo) = full_mul(sqrt_price_x64_at_tick(t), sqrt_price_x64_at_tick(-t));
            // product ≈ 2^128 → hi == 1 and lo is a tiny epsilon below 2^128, or hi==0 & lo near max.
            let one = hi == 1 && lo < (1u128 << 96); // within ~2^-32 relative of 2^128
            let just_under = hi == 0 && lo > u128::MAX - (1u128 << 96);
            assert!(one || just_under, "symmetry broke at tick {t}: hi={hi} lo={lo}");
        }
    }

    /// PROOF (live cross-check): the devnet pool reported tickCurrent 69081 at
    /// sqrt_price 583337266871351588490 at init. That sqrt must sit in
    /// [sqrt(69081), sqrt(69082)) — i.e. 69081 = floor(get_tick_at_sqrt_price).
    #[test]
    fn brackets_live_devnet_pool() {
        let live: u128 = 583337266871351588490;
        assert!(sqrt_price_x64_at_tick(69081) <= live);
        assert!(live < sqrt_price_x64_at_tick(69082));
    }

    /// PROOF: full_mul matches native u128 multiply whenever the product fits.
    #[test]
    fn full_mul_matches_native() {
        for &(a, b) in &[(0u128, 0u128), (1, 1), (u64::MAX as u128, u64::MAX as u128),
            (12_345_678_901234, 98_765_432_1), (1u128 << 100, 7), (3, 1u128 << 120)] {
            let (hi, lo) = full_mul(a, b);
            if let Some(p) = a.checked_mul(b) {
                assert_eq!(hi, 0, "hi nonzero for fitting product {a}·{b}");
                assert_eq!(lo, p, "lo mismatch for {a}·{b}");
            }
        }
        // a case that overflows u128 but not 256: (2^80)·(2^80) = 2^160
        let (hi, lo) = full_mul(1u128 << 80, 1u128 << 80);
        assert_eq!(lo, 0);
        assert_eq!(hi, 1u128 << 32);
    }
}
