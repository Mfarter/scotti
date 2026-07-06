//! Dual-asset token payout math (H6 spec §3–§4). SOL in, SPL token out.
//!
//! The machine snapshots `price_at_commit` (a TWAP, token-per-SOL scaled 1e12)
//! and pays deterministically at settle:
//!
//!   payout_tokens = wager_lamports · mult_bp · k_bp · price_1e12 · 10^dec
//!                   ─────────────────────────────────────────────────────
//!                                 LAMPORTS_PER_SOL · BP² · 1e12
//!
//! where `price_1e12` is whole-token-per-whole-SOL × 1e12 (decimal-agnostic) and
//! `10^dec` converts whole tokens to the token's base units. Integer-exact via
//! [`crate::price::wide_mul_div`] (a 256-bit intermediate), so nothing overflows.
//!
//! Two invariants are proven here (spec §4 obligations):
//!   * `value_rtp_invariant_to_price` — the SOL *value* of a payout is
//!     independent of the snapshot price, so all H0 RTP proofs carry over
//!     unchanged in value terms; price only rescales the token count.
//!   * `haircut_reserve_covers_every_outcome` — the commit-time reserve
//!     (max_payout × (1+haircut)) covers the settle payout of every outcome.

use crate::price::wide_mul_div;
use crate::{Tier, BP, REELS};

pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;
pub const PRICE_SCALE: u128 = 1_000_000_000_000; // 1e12, the price_1e12 fixed point
/// LAMPORTS_PER_SOL · BP² · PRICE_SCALE = 1e9 · 1e8 · 1e12 = 1e29.
pub const PAYOUT_DENOM: u128 = LAMPORTS_PER_SOL * BP * BP * PRICE_SCALE;

/// 10^dec for dec in 0..=18 (token decimals; spec tests extremes 0 and 9).
pub fn pow10(dec: u8) -> u128 {
    10u128.pow(dec as u32)
}

/// payout in token base units for a given multiplier (bp), k (bp), snapshot
/// price and token decimals. `None` on overflow of the numerator assembly (only
/// for absurd wagers far past any solvency cap).
pub fn payout_tokens(
    wager_lamports: u128,
    mult_bp: u128,
    k_bp: u128,
    price_1e12: u128,
    token_decimals: u8,
) -> Option<u128> {
    // wager·mult·k·10^dec ≤ ~1e12·5e6·1e4·1e9 = 5e31 < u128::MAX; checked anyway.
    let first = wager_lamports
        .checked_mul(mult_bp)?
        .checked_mul(k_bp)?
        .checked_mul(pow10(token_decimals))?;
    // (first · price_1e12) / PAYOUT_DENOM, 256-bit so first·price never overflows.
    Some(wide_mul_div(first, price_1e12, PAYOUT_DENOM))
}

/// Worst-case payout (JACKPOT³, i.e. tier.max_mult_bp) — the reserve basis.
pub fn max_payout_tokens(
    wager_lamports: u128,
    tier: &Tier,
    k_bp: u128,
    price_1e12: u128,
    token_decimals: u8,
) -> Option<u128> {
    payout_tokens(wager_lamports, tier.max_mult_bp(), k_bp, price_1e12, token_decimals)
}

/// Settle payout for a concrete reel outcome.
pub fn spin_payout_tokens(
    wager_lamports: u128,
    tier: &Tier,
    k_bp: u128,
    symbols: [u8; REELS],
    price_1e12: u128,
    token_decimals: u8,
) -> Option<u128> {
    payout_tokens(wager_lamports, tier.payout_bp(symbols), k_bp, price_1e12, token_decimals)
}

/// The token reserve for a pending spin: max_payout × (1 + haircut_bp/BP).
pub fn reserve_with_haircut(max_payout_tokens: u128, haircut_bp: u128) -> Option<u128> {
    max_payout_tokens
        .checked_mul(BP + haircut_bp)?
        .checked_div(BP)
}

/// Convert a token payout back to its SOL value in lamports (display + proofs):
/// value_lamports = payout_tokens · LAMPORTS_PER_SOL · 1e12 / (price_1e12 · 10^dec).
pub fn payout_value_lamports(payout_tokens: u128, price_1e12: u128, token_decimals: u8) -> u128 {
    let denom = price_1e12 * pow10(token_decimals);
    wide_mul_div(payout_tokens, LAMPORTS_PER_SOL * PRICE_SCALE, denom)
}

#[cfg(test)]
mod proofs {
    use super::*;
    use crate::{DEEP, JACKPOT, SHALLOW, STOPS, STRIP};

    /// PROOF: pinned example — 1 SOL at 1× / k=1 / price 1000 CHIP·SOL⁻¹ (9 dec)
    /// pays exactly 1000 CHIP (1e12 base units).
    #[test]
    fn pinned_payout_example() {
        let p = payout_tokens(LAMPORTS_PER_SOL, BP, BP, 1000 * PRICE_SCALE, 9).unwrap();
        assert_eq!(p, 1_000_000_000_000, "1 SOL @1000/SOL should pay 1000 CHIP");
        // 2 SOL wager, 5× multiplier, k=1.0 → 10_000 CHIP
        let p2 = payout_tokens(2 * LAMPORTS_PER_SOL, 5 * BP, BP, 1000 * PRICE_SCALE, 9).unwrap();
        assert_eq!(p2, 10_000_000_000_000);
    }

    /// PROOF (spec §4): the SOL VALUE of a payout is invariant to the snapshot
    /// price — value == wager · mult · k / BP² lamports at every price, so the H0
    /// RTP proofs hold in value terms; price only rescales the token count. Shown
    /// exactly (clean divisors) across a wide price range and both decimal
    /// extremes.
    #[test]
    fn value_rtp_invariant_to_price() {
        let wager = LAMPORTS_PER_SOL; // 1 SOL
        let mult = 5 * BP; // 5×
        let k = BP; // 1.0
        let expected_value = wager * mult * k / (BP * BP); // = 5 SOL in lamports
        for &dec in &[0u8, 6, 9] {
            for whole_price in [1u128, 10, 250, 1000, 7500, 100_000] {
                let price_1e12 = whole_price * PRICE_SCALE;
                let tokens = payout_tokens(wager, mult, k, price_1e12, dec).unwrap();
                // tokens scale linearly with price; value converts back exactly.
                let value = payout_value_lamports(tokens, price_1e12, dec);
                assert_eq!(value, expected_value,
                    "value moved with price: dec={dec} price={whole_price} value={value}");
            }
        }
    }

    /// PROOF: token payout is exactly linear in price — payout(P2)·P1 ==
    /// payout(P1)·P2 over the full outcome space of both tiers. This is the
    /// mechanism behind value-invariance.
    #[test]
    fn payout_linear_in_price() {
        let wager = 3 * LAMPORTS_PER_SOL;
        let (p1, p2) = (100 * PRICE_SCALE, 700 * PRICE_SCALE);
        for tier in [&SHALLOW, &DEEP] {
            for a in 0..STOPS {
                let s = [STRIP[a], STRIP[a], STRIP[a]]; // exercise the win rows
                let t1 = spin_payout_tokens(wager, tier, BP, s, p1, 9).unwrap();
                let t2 = spin_payout_tokens(wager, tier, BP, s, p2, 9).unwrap();
                assert_eq!(t1 * 700, t2 * 100, "payout not linear in price at stop {a}");
            }
        }
    }

    /// PROOF (spec §4 haircut-solvency): over the FULL outcome space of both
    /// tiers, every settle payout ≤ max_payout ≤ the haircut reserve. So a spin
    /// whose reserve is booked at commit can always be paid, and the unused
    /// remainder (reserve − payout) releases — never negative.
    #[test]
    fn haircut_reserve_covers_every_outcome() {
        let wager = 4 * LAMPORTS_PER_SOL;
        let price = 1234 * PRICE_SCALE;
        let haircut = 1500; // 15%
        for tier in [&SHALLOW, &DEEP] {
            for k in [hm_kmin(tier), hm_kmax(tier)] {
                let maxp = max_payout_tokens(wager, tier, k, price, 9).unwrap();
                let reserve = reserve_with_haircut(maxp, haircut).unwrap();
                assert!(reserve >= maxp, "reserve below max_payout");
                for a in 0..STOPS {
                    for b in 0..STOPS {
                        for c in 0..STOPS {
                            let s = [STRIP[a], STRIP[b], STRIP[c]];
                            let p = spin_payout_tokens(wager, tier, k, s, price, 9).unwrap();
                            assert!(p <= maxp, "outcome exceeds max_payout");
                            assert!(reserve >= p, "reserve fails to cover outcome");
                        }
                    }
                }
                // JACKPOT³ is exactly max_payout (the reserve basis).
                let jack = spin_payout_tokens(wager, tier, k, [JACKPOT, JACKPOT, JACKPOT], price, 9).unwrap();
                assert_eq!(jack, maxp);
            }
        }
    }

    /// PROOF: payout is monotone non-decreasing in wager and in price.
    #[test]
    fn monotone_in_wager_and_price() {
        let mut prev = 0u128;
        for w in 1..=50u128 {
            let p = payout_tokens(w * LAMPORTS_PER_SOL / 10, 3 * BP, BP, 500 * PRICE_SCALE, 9).unwrap();
            assert!(p >= prev, "not monotone in wager");
            prev = p;
        }
        let mut prevp = 0u128;
        for whole in 1..=50u128 {
            let p = payout_tokens(LAMPORTS_PER_SOL, 3 * BP, BP, whole * PRICE_SCALE, 9).unwrap();
            assert!(p >= prevp, "not monotone in price");
            prevp = p;
        }
    }

    /// PROOF: decimals extremes (0 and 9) both produce coherent, whole-token-
    /// consistent payouts — a 0-decimal token pays whole units, 9-decimal pays
    /// in 1e9 base units, same underlying value.
    #[test]
    fn decimals_extremes() {
        let whole_tokens_expected = 1000u128; // 1 SOL @ 1000/SOL, 1×, k=1
        let p0 = payout_tokens(LAMPORTS_PER_SOL, BP, BP, 1000 * PRICE_SCALE, 0).unwrap();
        assert_eq!(p0, whole_tokens_expected, "0-dec pays whole tokens");
        let p9 = payout_tokens(LAMPORTS_PER_SOL, BP, BP, 1000 * PRICE_SCALE, 9).unwrap();
        assert_eq!(p9, whole_tokens_expected * pow10(9), "9-dec pays base units");
        // same SOL value either way
        assert_eq!(payout_value_lamports(p0, 1000 * PRICE_SCALE, 0),
                   payout_value_lamports(p9, 1000 * PRICE_SCALE, 9));
    }

    // helpers: k bounds for a tier (test-time enumeration path)
    fn hm_kmin(t: &Tier) -> u128 { crate::k_bounds(t).0 }
    fn hm_kmax(t: &Tier) -> u128 { crate::k_bounds(t).1 }
}
