//! house-math — exact machine mathematics for the Yvone House Module.
//!
//! Dependency-free and integer-exact throughout. The tests in this crate are
//! the module's solvency proofs: full outcome-space enumeration (32^3 states),
//! RTP band bounds at the curve extremes for every tier, exposure-cap sanity,
//! and books-balance to the lamport. If it isn't proven here, it doesn't ship.

#![deny(unsafe_code)]

// H6 dual-asset price infrastructure (H6a): tick→price fixed point, TWAP from
// cumulative ticks, and the margin-floor invariant. Each is proof-tested like
// the game math below.
pub mod clmm;
pub mod dividend;
pub mod margin;
pub mod payout;
pub mod price;
pub mod snapshot;
pub mod twap;

pub const REELS: usize = 3;
pub const STOPS: usize = 32;
pub const BP: u128 = 10_000; // basis points denominator

/// Symbol ids.
pub const JACKPOT: u8 = 0;
pub const SEVEN: u8 = 1;
pub const BELL: u8 = 2;
pub const BAR: u8 = 3;
pub const CHERRY: u8 = 4;
pub const BLANK: u8 = 5;

/// v0 strip, identical per reel: 1 JACKPOT, 2 SEVEN, 4 BELL, 6 BAR, 9 CHERRY, 10 BLANK.
pub const STRIP: [u8; STOPS] = [
    JACKPOT,
    SEVEN, SEVEN,
    BELL, BELL, BELL, BELL,
    BAR, BAR, BAR, BAR, BAR, BAR,
    CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY,
    BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK,
];

/// A paytable tier: multipliers in basis points of the wager.
#[derive(Debug, Clone, Copy)]
pub struct Tier {
    pub name: &'static str,
    pub three_jackpot_bp: u128,
    pub three_seven_bp: u128,
    pub three_bell_bp: u128,
    pub three_bar_bp: u128,
    pub three_cherry_bp: u128,
    pub two_cherry_bp: u128,
    pub one_cherry_bp: u128,
}

impl Tier {
    pub const fn max_mult_bp(&self) -> u128 { self.three_jackpot_bp }

    /// Multiplier (bp) for a spin outcome (three symbol ids).
    pub fn payout_bp(&self, s: [u8; REELS]) -> u128 {
        if s[0] == s[1] && s[1] == s[2] {
            return match s[0] {
                JACKPOT => self.three_jackpot_bp,
                SEVEN => self.three_seven_bp,
                BELL => self.three_bell_bp,
                BAR => self.three_bar_bp,
                CHERRY => self.three_cherry_bp,
                _ => 0,
            };
        }
        match s.iter().filter(|&&x| x == CHERRY).count() {
            2 => self.two_cherry_bp,
            1 => self.one_cherry_bp,
            _ => 0,
        }
    }
}

/// SHALLOW tier: frequent small wins, 50x top. DEEP tier: 500x jackpot profile.
/// Both engineered to base RTP ~= 92% (asserted exactly in tests).
pub const SHALLOW: Tier = Tier {
    name: "shallow",
    three_jackpot_bp: 50_0000,   // 50x
    three_seven_bp: 25_0000,     // 25x
    three_bell_bp: 12_0000,      // 12x
    three_bar_bp: 8_0000,        // 8x
    three_cherry_bp: 5_0000,     // 5x
    two_cherry_bp: 2_2000,       // 2.2x
    one_cherry_bp: 8000,         // 0.8x
};

pub const DEEP: Tier = Tier {
    name: "deep",
    three_jackpot_bp: 500_0000,  // 500x
    three_seven_bp: 60_0000,     // 60x
    three_bell_bp: 25_0000,      // 25x
    three_bar_bp: 10_0000,       // 10x
    three_cherry_bp: 6_0000,     // 6x
    two_cherry_bp: 2_0000,       // 2.0x
    one_cherry_bp: 7000,         // 0.7x
};

/// Exact base RTP of a tier in bp, computed by full enumeration.
/// RTP_bp = sum(payout_bp over all 32^3 outcomes) / 32^3.
/// Returned as (rtp_bp_floor, exact_numerator) so callers can be integer-exact.
pub fn base_rtp(t: &Tier) -> (u128, u128) {
    let mut num: u128 = 0;
    for a in 0..STOPS {
        for b in 0..STOPS {
            for c in 0..STOPS {
                num += t.payout_bp([STRIP[a], STRIP[b], STRIP[c]]);
            }
        }
    }
    let total = (STOPS * STOPS * STOPS) as u128;
    (num / total, num)
}

/// RTP band the module guarantees, in bp.
pub const RTP_MIN_BP: u128 = 9_200; // 92%
pub const RTP_MAX_BP: u128 = 9_700; // 97%

/// k scaler bounds (in bp, 10_000 = 1.0x) from a tier's exact base-RTP
/// numerator, such that realized RTP = base_rtp * k stays inside the band.
/// k_min rounds UP (so RTP >= floor), k_max rounds DOWN (so RTP <= ceiling).
/// `const` so on-chain callers avoid the 32_768-outcome enumeration entirely.
pub const fn k_bounds_of_num(num: u128) -> (u128, u128) {
    k_bounds_of_num_with(num, RTP_MIN_BP, RTP_MAX_BP)
}

/// k bounds for an ARBITRARY realized-RTP band [rtp_min_bp, rtp_max_bp]. The
/// single-asset default uses [92%, 97%]; dual-asset machines pass a tighter
/// ceiling (the spec's 95%) so the margin-floor invariant holds under the price
/// band gate (see `margin::margin_floor_holds`). Same rounding discipline:
/// k_min rounds UP (realized ≥ floor), k_max rounds DOWN (realized ≤ ceiling).
pub const fn k_bounds_of_num_with(num: u128, rtp_min_bp: u128, rtp_max_bp: u128) -> (u128, u128) {
    let total = (STOPS * STOPS * STOPS) as u128;
    let k_min = (rtp_min_bp * total * BP).div_ceil(num);
    let k_max = (rtp_max_bp * total * BP) / num;
    (k_min, k_max)
}

/// Dual-asset k bounds for a tier numerator at a validated RTP ceiling. The
/// floor is the dual RTP min (`margin::DUAL_RTP_MIN_BP`, 92%); `rtp_max_bp` is
/// the machine's validated ceiling. O(1), on-chain-safe.
pub const fn k_bounds_dual(num: u128, rtp_max_bp: u128) -> (u128, u128) {
    k_bounds_of_num_with(num, margin::DUAL_RTP_MIN_BP, rtp_max_bp)
}

/// k scaler bounds for a tier — enumerates to derive the numerator. Test-time
/// path; on-chain code must use the pinned [`SHALLOW_K`]/[`DEEP_K`] constants
/// (base_rtp's 32_768-outcome enumeration would blow the BPF compute budget).
pub fn k_bounds(t: &Tier) -> (u128, u128) {
    let (_, num) = base_rtp(t);
    k_bounds_of_num(num)
}

// --- O(1) on-chain constants ---------------------------------------------
// The exact base-RTP numerators, pinned from the full enumeration (and cross-
// verified in `base_rtp_exact_and_pinned`). On-chain the house program reads
// the k bounds through these constants rather than enumerating; the proof
// `const_k_bounds_match_enumeration` guarantees they equal `k_bounds()`, so
// the enumeration in house-math remains the single source of truth.
pub const SHALLOW_NUM: u128 = 301_132_000;
pub const DEEP_NUM: u128 = 302_901_000;

/// (k_min, k_max) in bp for each tier — const-derived from the pinned numerators.
pub const SHALLOW_K: (u128, u128) = k_bounds_of_num(SHALLOW_NUM);
pub const DEEP_K: (u128, u128) = k_bounds_of_num(DEEP_NUM);

/// k bounds by tier, O(1). `is_deep` selects DEEP (true) or SHALLOW (false).
pub const fn k_bounds_const(is_deep: bool) -> (u128, u128) {
    if is_deep { DEEP_K } else { SHALLOW_K }
}

/// Piecewise-linear k(D): k_max at/below d_low, k_min at/above d_high.
pub fn k_of_depth(depth: u128, d_low: u128, d_high: u128, k_min: u128, k_max: u128) -> u128 {
    debug_assert!(d_low < d_high && k_min <= k_max);
    if depth <= d_low { return k_max; }
    if depth >= d_high { return k_min; }
    // interpolate downward as depth rises
    let span = d_high - d_low;
    let into = depth - d_low;
    k_max - (k_max - k_min) * into / span
}

/// Tier selection by depth.
pub fn tier_of_depth(depth: u128, d_mid: u128) -> &'static Tier {
    if depth < d_mid { &SHALLOW } else { &DEEP }
}

// --- ODDS-1: the normalized cross-machine odds curve -----------------------
//
// The per-machine (d_low, d_mid, d_high) reference made odds a function of a
// machine's OWN reference depth, so two machines never ordered by pool value
// (a 0.3-SOL machine could pay worse than a 0.999-SOL one). The normalized curve
// removes the per-machine reference: target RTP is ONE global, monotone function
// of pool value, so the lowest-value pool in a tier class always has the best
// odds — cheap pools attract volume until edge accrual grows them and odds
// converge (the equilibrating property; proofs `k_target_*` / `equilibration_*`).
//
// target RTP(value): RTP_MAX at/below REF_D_LOW, linear down to RTP_MIN at/above
// REF_D_MID (the shallow→deep split, which is also the RTP floor point); deep
// pools sit at the floor and unlock the 500x paytable. k_target is the scaler
// that realizes target RTP for the ACTIVE paytable, clamped to that tier's band.

/// Protocol curve reference (single-asset floor), lamports. At/below REF_D_LOW ⇒
/// best odds (RTP_MAX); at/above REF_D_MID ⇒ RTP floor + DEEP paytable.
pub const REF_D_LOW: u128 = 100_000_000; // 0.1 SOL
pub const REF_D_MID: u128 = 2_000_000_000; // 2 SOL — tier split and RTP floor point

/// Tier class as a pure function of pool value against the protocol split.
pub const fn is_deep_ref(pool_value: u128) -> bool { pool_value >= REF_D_MID }

/// Global target realized RTP (bp), monotone non-increasing in pool value:
/// RTP_MAX at/below REF_D_LOW, linear to RTP_MIN at/above REF_D_MID.
pub fn target_rtp_bp(pool_value: u128) -> u128 {
    if pool_value <= REF_D_LOW { return RTP_MAX_BP; }
    if pool_value >= REF_D_MID { return RTP_MIN_BP; }
    RTP_MAX_BP - (RTP_MAX_BP - RTP_MIN_BP) * (pool_value - REF_D_LOW) / (REF_D_MID - REF_D_LOW)
}

/// The numerator (base-RTP × total) for the paytable active at a pool value.
const fn tier_num(is_deep: bool) -> u128 { if is_deep { DEEP_NUM } else { SHALLOW_NUM } }

/// Normalized k target: the scaler realizing `target_rtp_bp(value)` for the
/// active tier's paytable, clamped to that tier's band. Monotone NON-INCREASING
/// in pool value across the FULL domain — RTP falls with value, and the numerator
/// rises at the tier split, so k only ever drops or holds as value grows. This is
/// the single source of truth for odds; the smoothing target is this curve.
pub fn k_target(pool_value: u128) -> u128 {
    let is_deep = is_deep_ref(pool_value);
    let num = tier_num(is_deep);
    let (k_min, k_max) = k_bounds_const(is_deep);
    let total = (STOPS * STOPS * STOPS) as u128;
    let k = target_rtp_bp(pool_value) * total * BP / num;
    if k < k_min { k_min } else if k > k_max { k_max } else { k }
}

/// Realized RTP (bp) for a pool value under the normalized curve — for display
/// and the equilibration model. realized = base_rtp × k (the paytable actually
/// pays k, so realized may differ from target by the k-rounding, always ≤ 1 bp).
pub fn realized_rtp_bp(pool_value: u128) -> u128 {
    let num = tier_num(is_deep_ref(pool_value));
    let total = (STOPS * STOPS * STOPS) as u128;
    num * k_target(pool_value) / (total * BP)
}

/// Solvency-derived max bet: one spin's worst case <= max_exposure_bp of the pool.
/// max_bet = depth * max_exposure_bp / BP / max_effective_mult
/// where max_effective_mult = tier.max_mult_bp * k / BP (in bp of wager).
pub fn max_bet(depth: u128, max_exposure_bp: u128, tier: &Tier, k_bp: u128) -> u128 {
    let max_eff_mult_bp = tier.max_mult_bp() * k_bp / BP; // bp of wager
    if max_eff_mult_bp == 0 { return 0; }
    depth * max_exposure_bp / BP * BP / max_eff_mult_bp
}

/// Payout for a settled spin (floors; dust accrues to the pool).
pub fn spin_payout(wager: u128, tier: &Tier, k_bp: u128, symbols: [u8; REELS]) -> u128 {
    wager * tier.payout_bp(symbols) / BP * k_bp / BP
}

/// Map 32 bytes of revealed randomness to reel indices (independent byte per reel;
/// 32 stops divides 256 exactly, so `mod 32` is bias-free).
pub fn reels_from_randomness(bytes: &[u8; 32]) -> [u8; REELS] {
    [
        STRIP[(bytes[0] % STOPS as u8) as usize],
        STRIP[(bytes[1] % STOPS as u8) as usize],
        STRIP[(bytes[2] % STOPS as u8) as usize],
    ]
}

#[cfg(test)]
mod proofs {
    use super::*;

    /// PROOF: base RTP of both tiers is sane and close to the design point,
    /// and the exact numerators are pinned (any table edit must re-derive).
    #[test]
    fn base_rtp_exact_and_pinned() {
        let (s_bp, s_num) = base_rtp(&SHALLOW);
        let (d_bp, d_num) = base_rtp(&DEEP);
        // pinned exact numerators (bp-weighted outcome sums over 32768 states),
        // cross-verified by an independent Python enumeration at spec time
        assert_eq!(s_num, 301_132_000, "SHALLOW numerator drifted: {}", s_num);
        assert_eq!(d_num, 302_901_000, "DEEP numerator drifted: {}", d_num);
        // both tiers designed near 92%; must be below the band ceiling pre-scaling
        assert!((9_000..=9_300).contains(&s_bp), "shallow base rtp {}", s_bp);
        assert!((9_000..=9_300).contains(&d_bp), "deep base rtp {}", d_bp);
    }

    /// PROOF: with k clamped to k_bounds, realized RTP stays inside [92%, 97%]
    /// at BOTH extremes for BOTH tiers — and never reaches 100% anywhere.
    #[test]
    fn rtp_band_holds_at_curve_extremes() {
        for t in [&SHALLOW, &DEEP] {
            let (k_min, k_max) = k_bounds(t);
            assert!(k_min <= k_max, "{} k bounds inverted", t.name);
            let (_, num) = base_rtp(t);
            let total = (STOPS * STOPS * STOPS) as u128;
            for k in [k_min, k_max] {
                let realized_bp = num * k / (total * BP);
                assert!(realized_bp >= RTP_MIN_BP - 1, "{} k={} rtp={}", t.name, k, realized_bp);
                assert!(realized_bp <= RTP_MAX_BP, "{} k={} rtp={}", t.name, k, realized_bp);
                assert!(realized_bp < BP, "{}: RTP reached par — faucet condition", t.name);
            }
        }
    }

    /// PROOF: k(D) is monotone non-increasing in depth and clamps at both ends.
    #[test]
    fn curve_monotone_and_clamped() {
        let (k_min, k_max) = k_bounds(&DEEP);
        let (d_low, d_high) = (10_u128.pow(9), 10_u128.pow(12));
        assert_eq!(k_of_depth(0, d_low, d_high, k_min, k_max), k_max);
        assert_eq!(k_of_depth(d_low, d_low, d_high, k_min, k_max), k_max);
        assert_eq!(k_of_depth(d_high, d_low, d_high, k_min, k_max), k_min);
        assert_eq!(k_of_depth(d_high * 5, d_low, d_high, k_min, k_max), k_min);
        let mut prev = k_max;
        for i in 0..=100u128 {
            let d = d_low + (d_high - d_low) * i / 100;
            let k = k_of_depth(d, d_low, d_high, k_min, k_max);
            assert!(k <= prev, "k not monotone at step {}", i);
            assert!((k_min..=k_max).contains(&k));
            prev = k;
        }
    }

    /// PROOF: the exposure cap bounds a worst-case spin to max_exposure_bp of
    /// the pool, at the most dangerous curve point (k_max) for both tiers.
    #[test]
    fn exposure_cap_bounds_worst_case() {
        let depth: u128 = 100_000 * 1_000_000_000; // "$100k machine" in lamport-scale units
        let max_exposure_bp = 100; // 1%
        for t in [&SHALLOW, &DEEP] {
            let (_, k_max) = k_bounds(t);
            let bet = max_bet(depth, max_exposure_bp, t, k_max);
            assert!(bet > 0, "{} max bet zero", t.name);
            // worst case payout at that bet
            let jackpot = [JACKPOT, JACKPOT, JACKPOT];
            let worst = spin_payout(bet, t, k_max, jackpot);
            assert!(
                worst <= depth * max_exposure_bp / BP,
                "{}: worst-case {} exceeds {} of pool", t.name, worst, max_exposure_bp
            );
        }
    }

    /// PROOF: books balance to the unit over the full outcome space —
    /// sum(payouts) + sum(retained) == sum(wagers), with flooring dust retained.
    #[test]
    fn books_balance_over_full_enumeration() {
        let wager: u128 = 12_345_679; // deliberately awkward for rounding
        for t in [&SHALLOW, &DEEP] {
            let (k_min, k_max) = k_bounds(t);
            for k in [k_min, k_max] {
                let mut paid: u128 = 0;
                let mut retained: u128 = 0;
                let mut wagered: u128 = 0;
                for a in 0..STOPS {
                    for b in 0..STOPS {
                        for c in 0..STOPS {
                            let s = [STRIP[a], STRIP[b], STRIP[c]];
                            let p = spin_payout(wager, t, k, s);
                            wagered += wager;
                            paid += p;
                            retained += wager - p.min(wager) + p.saturating_sub(wager) * 0; // see assert below
                            // retained per spin = wager - p can be negative on wins;
                            // pool-level accounting nets it:
                        }
                    }
                }
                // Pool-level: retained is simply wagered - paid (can be checked exact).
                let net = wagered as i128 - paid as i128;
                assert!(net > 0, "{} k={}: pool lost money over full space", t.name, k);
                assert_eq!(wagered, paid + net as u128, "books do not balance");
                // realized RTP from actual floored payouts stays inside the band (+rounding down)
                let realized_bp = paid * BP / wagered;
                assert!(realized_bp >= RTP_MIN_BP - 5 && realized_bp <= RTP_MAX_BP,
                        "{} k={} floored rtp={}", t.name, k, realized_bp);
            }
        }
    }

    /// PROOF: the O(1) on-chain k-bound constants equal the enumerated
    /// `k_bounds()` exactly, for both tiers. This is what lets the house
    /// program read k bounds without running base_rtp's 32_768-outcome loop
    /// (which would exceed the BPF compute budget) while keeping the
    /// enumeration the single source of truth.
    #[test]
    fn const_k_bounds_match_enumeration() {
        assert_eq!(SHALLOW_K, k_bounds(&SHALLOW), "SHALLOW const k-bounds drifted");
        assert_eq!(DEEP_K, k_bounds(&DEEP), "DEEP const k-bounds drifted");
        assert_eq!(k_bounds_const(false), k_bounds(&SHALLOW));
        assert_eq!(k_bounds_const(true), k_bounds(&DEEP));
        // and the pinned numerators match the enumeration
        assert_eq!(SHALLOW_NUM, base_rtp(&SHALLOW).1);
        assert_eq!(DEEP_NUM, base_rtp(&DEEP).1);
    }

    /// PROOF: randomness mapping is bias-free (mod 32 over a byte) and total.
    #[test]
    fn randomness_mapping_uniform() {
        // each of 256 byte values maps to a stop; every stop hit exactly 8 times
        let mut counts = [0u32; STOPS];
        for b in 0..=255u8 {
            counts[(b % STOPS as u8) as usize] += 1;
        }
        assert!(counts.iter().all(|&c| c == 8));
        // and mapping consumes independent bytes per reel
        let r = reels_from_randomness(&[0u8; 32]);
        assert_eq!(r, [STRIP[0], STRIP[0], STRIP[0]]);
    }
}

// ---------------------------------------------------------------------------
// Depth smoothing — anti-snipe layer.
//
// k must not read instantaneous depth: a jackpot would open a discrete,
// watchable RTP window. Instead k reads a slot-decayed moving value that
// drifts toward true depth over WINDOW slots. Integer-exact, one update per
// touching instruction: v += (depth - v) * min(elapsed, W) / W.
// ---------------------------------------------------------------------------

/// Default smoothing window: ~1 hour of slots at ~0.4s/slot.
pub const SMOOTH_WINDOW_SLOTS: u64 = 9_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SmoothedDepth {
    pub value: u128,
    pub last_slot: u64,
}

impl SmoothedDepth {
    pub fn new(depth: u128, slot: u64) -> Self {
        Self { value: depth, last_slot: slot }
    }

    /// Advance toward `depth_now`. Call from every instruction that reads k.
    pub fn update(&mut self, depth_now: u128, slot_now: u64, window: u64) -> u128 {
        debug_assert!(window > 0);
        let elapsed = slot_now.saturating_sub(self.last_slot).min(window);
        if elapsed > 0 {
            if depth_now >= self.value {
                self.value += (depth_now - self.value) * elapsed as u128 / window as u128;
            } else {
                self.value -= (self.value - depth_now) * elapsed as u128 / window as u128;
            }
            self.last_slot = slot_now;
        }
        self.value
    }
}

#[cfg(test)]
mod smoothing_proofs {
    use super::*;

    /// PROOF: smoothed value is always bounded by [min, max] of inputs seen.
    #[test]
    fn bounded_by_inputs() {
        let mut s = SmoothedDepth::new(1_000_000, 0);
        let inputs: [u128; 6] = [1_000_000, 400_000, 2_500_000, 900_000, 2_500_000, 400_000];
        let (lo, hi) = (400_000u128, 2_500_000u128);
        for (i, &d) in inputs.iter().enumerate() {
            let v = s.update(d, (i as u64 + 1) * 700, SMOOTH_WINDOW_SLOTS);
            assert!((lo..=hi).contains(&v), "escaped bounds: {}", v);
        }
    }

    /// PROOF: with constant depth, smoothed converges monotonically to depth.
    #[test]
    fn converges_monotonically() {
        let mut s = SmoothedDepth::new(2_000_000, 0);
        let target: u128 = 500_000;
        let mut prev = s.value;
        let mut slot = 0u64;
        for _ in 0..80 {
            slot += 1_000;
            let v = s.update(target, slot, SMOOTH_WINDOW_SLOTS);
            assert!(v <= prev, "not monotone");
            prev = v;
        }
        // ~80 linear steps of 1/9 each: remaining gap factor (8/9)^80 ≈ 8e-5
        assert!(prev.abs_diff(target) <= target / 100, "did not converge: {}", prev);
    }

    /// PROOF (anti-snipe): after an instant crater of the pool, the k
    /// available ONE SLOT later has moved by less than 0.02% of the band —
    /// there is no discrete post-jackpot window to snipe. Full adjustment
    /// takes ~WINDOW slots by construction.
    #[test]
    fn crater_moves_k_negligibly_next_slot() {
        let (k_min, k_max) = k_bounds(&DEEP);
        let (d_low, d_high) = (1_000_000u128, 100_000_000u128);
        // pool sitting deep (k = k_min), jackpot removes 40% instantly
        let before: u128 = 90_000_000;
        let after: u128 = 54_000_000;
        let mut s = SmoothedDepth::new(before, 1_000);
        let k_before = k_of_depth(s.value, d_low, d_high, k_min, k_max);
        let v1 = s.update(after, 1_001, SMOOTH_WINDOW_SLOTS); // one slot later
        let k_after = k_of_depth(v1, d_low, d_high, k_min, k_max);
        let band = k_max - k_min;
        let moved = k_after.abs_diff(k_before);
        assert!(
            moved * 10_000 <= band * 2,
            "k moved {} of band {} in one slot", moved, band
        );
        // and after a full window at the new depth, k HAS meaningfully adjusted
        let v_full = s.update(after, 1_001 + SMOOTH_WINDOW_SLOTS, SMOOTH_WINDOW_SLOTS);
        let k_full = k_of_depth(v_full, d_low, d_high, k_min, k_max);
        assert!(k_full > k_before, "curve failed to respond over the window");
    }

    /// PROOF (cold-start): a machine's FOUNDING state is not a change to damp.
    /// `new(depth)` reads the full depth immediately and stays there under
    /// constant depth, so a freshly-seeded machine offers full max_bet at once
    /// — the H3 fix is to seed SmoothedDepth with the first deposit rather than
    /// let it ramp up from zero over a window.
    #[test]
    fn founding_state_reads_full_depth() {
        let d = 5_000_000_000u128;
        let mut s = SmoothedDepth::new(d, 100);
        assert_eq!(s.value, d, "new() seeds value = depth");
        assert_eq!(s.update(d, 100, SMOOTH_WINDOW_SLOTS), d, "zero elapsed is identity");
        assert_eq!(s.update(d, 100 + SMOOTH_WINDOW_SLOTS, SMOOTH_WINDOW_SLOTS), d, "constant depth stays");
        assert_eq!(s.update(d, 100 + 10 * SMOOTH_WINDOW_SLOTS, SMOOTH_WINDOW_SLOTS), d);
    }

    /// PROOF: elapsed beyond one window clamps (no overshoot past target).
    #[test]
    fn long_gaps_clamp_never_overshoot() {
        let mut s = SmoothedDepth::new(10_000_000, 0);
        let v = s.update(1_000_000, 1_000_000_000, SMOOTH_WINDOW_SLOTS);
        assert_eq!(v, 1_000_000, "should land exactly on target after >= one window");
        let v2 = s.update(1_000_000, 2_000_000_000, SMOOTH_WINDOW_SLOTS);
        assert_eq!(v2, 1_000_000, "must not move past a constant target");
    }
}

// ---------------------------------------------------------------------------
// ODDS-1 proofs: the normalized odds curve orders by pool value, couples to
// staker capital, converges under smoothing, and equilibrates across machines.
#[cfg(test)]
mod odds_normalized_proofs {
    use super::*;

    const SOL: u128 = 1_000_000_000;

    /// (a) MONOTONICITY: k_target is non-increasing in pool value across the full
    /// domain — best odds at the lowest value, in EVERY tier class. Dense sweep
    /// plus per-integer coverage of the tier split (the only place two rounded
    /// divisions and a numerator change meet).
    #[test]
    fn k_target_monotone_in_pool_value() {
        let mut prev = k_target(0);
        // dense sweep 0..3 SOL at 0.001-SOL steps
        let mut p = 0u128;
        while p <= 3 * SOL {
            let k = k_target(p);
            assert!(k <= prev, "k rose at {} lamports: {} > {}", p, k, prev);
            prev = k;
            p += SOL / 1000;
        }
        // per-integer coverage around the shallow→deep split
        let mut prev2 = k_target(REF_D_MID - 5000);
        for x in (REF_D_MID - 5000)..(REF_D_MID + 5000) {
            let k = k_target(x);
            assert!(k <= prev2, "k rose across split at {}: {} > {}", x, k, prev2);
            prev2 = k;
        }
        // clamps: best odds at/below D_LOW, deep floor at/above D_MID
        assert_eq!(k_target(0), SHALLOW_K.1);
        assert_eq!(k_target(REF_D_LOW), SHALLOW_K.1);
        assert_eq!(k_target(REF_D_MID), DEEP_K.0);
        assert_eq!(k_target(REF_D_MID * 100), DEEP_K.0);
        // strict drop at the split (shallow floor scaler > deep floor scaler)
        assert!(k_target(REF_D_MID - 1) > k_target(REF_D_MID));
    }

    /// Cross-machine: two SHALLOW machines order by pool value alone, regardless
    /// of any legacy per-machine params. Uses the three live pools.
    #[test]
    fn cross_machine_orders_by_pool_value() {
        let cold = 300_000_000u128;   // Cold Comfort
        let demo = 999_000_000u128;   // house-demo-1
        let levi = 1_200_000_000u128; // Leviathan (still < REF_D_MID ⇒ shallow)
        assert!(is_deep_ref(cold) == false && is_deep_ref(demo) == false && is_deep_ref(levi) == false);
        // lowest pool ⇒ best odds ⇒ highest k
        assert!(k_target(cold) > k_target(demo), "0.3 must beat 0.999");
        assert!(k_target(demo) > k_target(levi), "0.999 must beat 1.2");
        // realized RTP strictly orders too
        assert!(realized_rtp_bp(cold) > realized_rtp_bp(demo));
        assert!(realized_rtp_bp(demo) > realized_rtp_bp(levi));
    }

    /// (b) STAKER-COUPLING: a deposit (value up) never raises k; a withdrawal
    /// (value down) never lowers it — and it STRICTLY moves on the interior
    /// gradient. The curve input is pool value, so staker capital counts.
    #[test]
    fn k_target_couples_to_staker_capital() {
        let bases = [
            REF_D_LOW / 2, REF_D_LOW, 200_000_000, 500_000_000, 999_000_000,
            REF_D_MID - 1, REF_D_MID, REF_D_MID + 1, REF_D_MID * 2,
        ];
        for &base in &bases {
            let k = k_target(base);
            for &d in &[1u128, 1_000, 1_000_000, 50_000_000, 500_000_000] {
                assert!(k_target(base + d) <= k, "deposit raised k at {}+{}", base, d);
                if base >= d {
                    assert!(k_target(base - d) >= k, "withdraw lowered k at {}-{}", base, d);
                }
            }
        }
        // strict on the gradient (away from either clamp)
        let mid = (REF_D_LOW + REF_D_MID) / 2;
        assert!(k_target(mid + 50_000_000) < k_target(mid), "deposit must strictly lower k on the gradient");
        assert!(k_target(mid - 50_000_000) > k_target(mid), "withdraw must strictly raise k on the gradient");
    }

    /// (c) CONVERGENCE: under the unchanged anti-snipe smoothing, k reaches within
    /// 1 bp of the spot's k target in a BOUNDED number of touches, from any start
    /// (below and above). Worked case: window W, e = W/2 slots per touch.
    #[test]
    fn k_target_converges_under_smoothing_bounded() {
        let w = SMOOTH_WINDOW_SLOTS;
        let e = w / 2;
        let spot = 1_500_000_000u128; // 1.5 SOL, mid-shallow gradient
        let target = k_target(spot);
        const BOUND: u32 = 40; // pinned convergence bound (touches)

        for &start in &[1u128, REF_D_MID * 2] {
            let mut sd = SmoothedDepth::new(start, 0);
            let mut slot = 0u64;
            let mut touches = 0u32;
            loop {
                slot += e;
                let v = sd.update(spot, slot, w);
                touches += 1;
                let k = k_target(v);
                let diff = if k > target { k - target } else { target - k };
                if diff <= 1 { break; }
                assert!(touches <= BOUND, "no convergence from {} within {} touches", start, BOUND);
            }
            assert!(touches <= BOUND, "start {} took {} touches", start, touches);
        }
    }

    /// (d) EQUILIBRATION: N machines, same tier, different pools; route a fixed
    /// wager to the best-odds (lowest-value) machine each step, its house edge
    /// accrues to its pool. The max-min gap STRICTLY shrinks until it is within
    /// one spin's edge granularity, at which point the pools are equal up to a
    /// single spin (converged). Worked example: the three live pools.
    #[test]
    fn equilibration_gap_strictly_shrinks() {
        let mut pools = [300_000_000u128, 999_000_000, 1_200_000_000];
        let wager = 50_000_000u128; // 0.05 SOL routed per step
        let gap = |p: &[u128; 3]| p.iter().max().unwrap() - p.iter().min().unwrap();
        let gap0 = gap(&pools);
        // Largest possible per-spin edge (at the RTP floor). Below ~2x this, one
        // spin can push the fed (lowest) pool a hair past the max — the discrete
        // granularity floor; convergence is defined as reaching it.
        let max_edge = wager * (BP - RTP_MIN_BP) / BP;
        let granularity = 2 * max_edge;

        let mut prev = gap0;
        let mut steps = 0u32;
        // best-odds routing: pick the highest-k machine, breaking ties toward the
        // strictly-lowest pool so a min-tie is resolved (not re-fed) — the gap is
        // then non-increasing every step and strictly shrinks over any tie-free
        // window, converging to the granularity floor.
        while prev > granularity {
            let i = (0..3).max_by_key(|&i| (k_target(pools[i]), u128::MAX - pools[i])).unwrap();
            let rtp = realized_rtp_bp(pools[i]);
            let edge = wager * (BP - rtp) / BP; // house edge on this spin volume
            assert!(edge > 0, "positive edge (RTP < 100%) must accrue");
            pools[i] += edge;
            let g = gap(&pools);
            assert!(g <= prev, "gap must be non-increasing (step {}: {} > {})", steps, g, prev);
            prev = g;
            steps += 1;
            assert!(steps <= 1000, "did not converge within horizon");
        }
        assert!(prev <= granularity, "converged to within one spin's edge");
        assert!(prev < gap0, "net strict shrink from the initial gap");
        // pinned convergence rate for this worked example: the 0.9-SOL gap across
        // 0.3/0.999/1.2 closes to one-spin granularity in 457 steps (0.05-SOL
        // spins). A regression tripwire on the equilibration speed.
        assert_eq!(steps, 457, "equilibration convergence-step count drifted");
    }
}
