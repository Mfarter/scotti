//! Margin-floor invariant — the solvency link between the price-band gate and
//! the RTP band for dual-asset machines (H6 spec §3, §4).
//!
//! At commit the machine snapshots a TWAP price but pays deterministically; the
//! band gate refuses the spin unless spot is within `band_bp` of TWAP. The worst
//! case an attacker can force is realized value edge scaled by `(1 + band)`. So
//! even at the maximum RTP the house must still keep a margin floor `m`:
//! `RTP_MAX * (BP + band_bp) <= (BP - m_bp) * BP`.
//!
//! At the spec's dual-asset parameters — RTP band [92%, 95%], 300bp band gate,
//! 200bp floor — this is 95% × 1.03 = 97.85% ≤ 98%. The band gate is thus tight
//! enough that no accepted configuration can cross the floor.

use crate::BP;

/// Dual-asset RTP ceiling — tighter than the single-asset 97% (RTP_MAX_BP),
/// because the price wedge eats headroom the single-asset machine doesn't spend.
pub const DUAL_RTP_MIN_BP: u128 = 9_200; // 92%
pub const DUAL_RTP_MAX_BP: u128 = 9_500; // 95%
/// Price-band gate cap (spot vs TWAP), basis points.
pub const BAND_CAP_BP: u128 = 300; // 3%
/// Minimum house margin floor, basis points.
pub const MARGIN_FLOOR_BP: u128 = 200; // 2%

/// The invariant itself: worst-case effective payout ≤ BP − margin floor.
pub const fn margin_floor_holds(rtp_max_bp: u128, band_bp: u128, margin_floor_bp: u128) -> bool {
    // both sides ≤ ~9500·10400 ≈ 9.9e7, far under u128 — no overflow.
    rtp_max_bp * (BP + band_bp) <= (BP - margin_floor_bp) * BP
}

/// Validation the H6b `create_machine` applies to dual-asset parameters. Range
/// caps AND the solvency invariant — so a config that would cross the floor is
/// rejected at creation, not discovered at settle.
pub const fn validate_dual_params(rtp_max_bp: u128, band_bp: u128, margin_floor_bp: u128) -> bool {
    rtp_max_bp >= DUAL_RTP_MIN_BP
        && rtp_max_bp <= DUAL_RTP_MAX_BP
        && band_bp <= BAND_CAP_BP
        && margin_floor_bp >= MARGIN_FLOOR_BP
        && margin_floor_bp < BP
        && margin_floor_holds(rtp_max_bp, band_bp, margin_floor_bp)
}

#[cfg(test)]
mod proofs {
    use super::*;

    /// PROOF: the spec's dual-asset defaults satisfy the floor with 150,000
    /// (BP²-scaled) headroom — 95% × 1.03 = 97.85% ≤ 98%.
    #[test]
    fn spec_defaults_hold() {
        assert_eq!(DUAL_RTP_MAX_BP * (BP + BAND_CAP_BP), 97_850_000);
        assert_eq!((BP - MARGIN_FLOOR_BP) * BP, 98_000_000);
        assert!(margin_floor_holds(DUAL_RTP_MAX_BP, BAND_CAP_BP, MARGIN_FLOOR_BP));
        let headroom = (BP - MARGIN_FLOOR_BP) * BP - DUAL_RTP_MAX_BP * (BP + BAND_CAP_BP);
        assert_eq!(headroom, 150_000, "spec headroom drifted");
        assert!(validate_dual_params(9_500, 300, 200));
    }

    /// PROOF (tightness): at max RTP and the 200bp floor, the invariant holds up
    /// to a 315bp band and breaks at 316 — so the 300bp cap sits 15bp inside the
    /// true boundary. This is *why* the band cap can't be raised freely.
    #[test]
    fn band_headroom_is_tight() {
        assert!(margin_floor_holds(9_500, 315, 200));
        assert!(!margin_floor_holds(9_500, 316, 200));
        // and validate's own cap is conservative: it rejects even the safe 301..315
        assert!(!validate_dual_params(9_500, 310, 200));
    }

    /// PROOF: the invariant check bites — a config asking for MORE margin (250bp)
    /// than the RTP/band budget allows is correctly rejected, even though its
    /// range caps are all in-bounds. Removing `margin_floor_holds` from
    /// `validate_dual_params` would wrongly accept it.
    #[test]
    fn validation_rejects_infeasible_floor() {
        // 9500·10300 = 97_850_000 > (10000-250)·10000 = 97_500_000 → crosses.
        assert!(!margin_floor_holds(9_500, 300, 250));
        assert!(!validate_dual_params(9_500, 300, 250));
        // range caps alone would have passed it:
        let range_ok = 9_500 >= DUAL_RTP_MIN_BP && 9_500 <= DUAL_RTP_MAX_BP
            && 300 <= BAND_CAP_BP && 250 >= MARGIN_FLOOR_BP && 250 < BP;
        assert!(range_ok, "the rejection is the invariant's doing, not a range cap");
    }

    /// PROOF (proptest-style sweep): over a broad grid that deliberately reaches
    /// past every cap, NO combination the validation accepts can cross the floor.
    /// Exhaustive: ~301 × 401 × 121 ≈ 14.6M configs.
    #[test]
    fn no_accepted_combo_crosses_the_floor() {
        let mut accepted = 0u64;
        let mut rtp = DUAL_RTP_MIN_BP; // 9200
        while rtp <= 9_600 {
            // sweep past the 9500 cap
            let mut band = 0u128;
            while band <= 400 {
                // past the 300 cap
                let mut floor = 150u128;
                while floor <= 270 {
                    // straddle the 200 floor
                    if validate_dual_params(rtp, band, floor) {
                        accepted += 1;
                        assert!(
                            margin_floor_holds(rtp, band, floor),
                            "accepted config crosses floor: rtp={rtp} band={band} floor={floor}"
                        );
                        // and every accepted config is inside the declared caps
                        assert!(rtp <= DUAL_RTP_MAX_BP && band <= BAND_CAP_BP && floor >= MARGIN_FLOOR_BP);
                    }
                    floor += 1;
                }
                band += 1;
            }
            rtp += 1;
        }
        // the accepted set is non-empty (the machine is actually usable)
        assert!(accepted > 0, "validation accepted nothing");
    }
}
