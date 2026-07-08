//! Multi-pool price aggregator (VAULT-1) — a MEDIAN over a set of 1..=5 Raydium
//! CLMM pools, gated by a majority QUORUM. Generalizes the single-pool
//! `price_at_commit` (H6 spec §3) to a pool SET while keeping the per-pool math
//! (TWAP, staleness, band) exactly as it is: this module only decides WHICH pools
//! count and HOW their TWAPs combine.
//!
//! ## The rule
//!   * A pool is ELIGIBLE iff it is fresh (its newest observation is within
//!     `max_staleness` AND its TWAP window is covered) and its own spot is within
//!     `band_bp` of its own TWAP. This is byte-for-byte the single-pool gate
//!     ([`crate::twap`] + the §3 band test), applied per pool.
//!   * The AGGREGATE is the MEDIAN of the eligible pools' TWAPs — a median, not a
//!     mean, so moving a MINORITY of the pools cannot drag the result past the
//!     honest band (bounded-manipulation; proofs below).
//!   * A commit is allowed iff `eligible >= quorum`, where `quorum` is a strict
//!     majority of the SET size: 1-of-1, 2-of-2, 2-of-3, 3-of-4, 3-of-5.
//!
//! ## What is proven here
//!   * `single_pool_degenerates_to_twap` — a 1-pool set returns EXACTLY that
//!     pool's TWAP and refuses in EXACTLY the cases the legacy single-pool machine
//!     refuses. This is the bit-identical-migration guarantee (dual-chip-1).
//!   * `median_is_deterministic_and_exact` — a pure integer function; the result
//!     is always one of the input TWAPs (no averaging, no float).
//!   * `honest_majority_bounds_the_median` — if a STRICT majority of the eligible
//!     pools are honest and inside the band, the median is inside the band, for
//!     every eligible count 1..=5 and every adversary placement.
//!   * `odd_set_fewer_than_quorum_is_bounded` — the corollary for the recommended
//!     ODD set sizes (1,3,5): corrupting fewer than `quorum` pools leaves the
//!     aggregate inside the band. `even_set_tie_is_the_residual` pins the one edge
//!     even sets (2,4) do NOT cover (an exactly-half tie), documented in the spec.

use crate::BP;

/// Maximum pools in a set (spec: 1..=5).
pub const MAX_POOLS: usize = 5;

/// Majority-of-set quorum — the minimum eligible pools to price a commit.
/// 1→1, 2→2, 3→2, 4→3, 5→3 (⌊n/2⌋ + 1).
pub const fn quorum(set_len: u8) -> u8 {
    set_len / 2 + 1
}

/// One pool's reading in the machine's fixed point (token-per-SOL × 1e12),
/// already reduced by the CLMM reader / mock seam. `twap_1e12 == 0` marks a
/// not-ready read (cold/uncovered window) — the same sentinel `read_price` maps a
/// `TwapRead::NotReady` to, so such a pool is simply ineligible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PoolQuote {
    pub twap_1e12: u128,
    pub spot_1e12: u128,
    pub age_secs: u32,
}

/// `|spot − twap|·BP ≤ twap·band_bp` — the spec §3 band test, u128-exact.
/// Realistic prices (~1e15) keep both sides far under u128; `saturating_mul`
/// guards the absurd-input corner without changing any in-range result.
pub fn spot_in_band(spot_1e12: u128, twap_1e12: u128, band_bp: u16) -> bool {
    let diff = spot_1e12.abs_diff(twap_1e12);
    diff.saturating_mul(BP) <= twap_1e12.saturating_mul(band_bp as u128)
}

/// Per-pool eligibility: a live TWAP, fresh enough, with spot in its own band.
/// EXACTLY the single-pool gate, applied to one pool.
pub fn pool_eligible(q: &PoolQuote, max_staleness_secs: u32, band_bp: u16) -> bool {
    q.twap_1e12 > 0 && q.age_secs <= max_staleness_secs && spot_in_band(q.spot_1e12, q.twap_1e12, band_bp)
}

/// The aggregation outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Aggregate {
    /// Priced: `price_1e12` is the median of the eligible TWAPs; `eligible >= quorum`.
    Priced { price_1e12: u128, eligible: u8 },
    /// Refused: fewer eligible pools than the quorum — the commit must be rejected.
    BelowQuorum { eligible: u8, quorum: u8 },
}

/// Aggregate the first `set_len` quotes: median of the eligible TWAPs, gated by a
/// majority quorum. Deterministic and integer-exact — no float, the priced result
/// is one of the input TWAPs. `set_len` is clamped to `MAX_POOLS`.
pub fn aggregate(quotes: &[PoolQuote], set_len: u8, max_staleness_secs: u32, band_bp: u16) -> Aggregate {
    let n = (set_len as usize).min(MAX_POOLS);
    let q = quorum(set_len);

    // gather eligible TWAPs into a fixed buffer (≤ 5).
    let mut buf = [0u128; MAX_POOLS];
    let mut m = 0usize;
    let mut i = 0;
    while i < n {
        if pool_eligible(&quotes[i], max_staleness_secs, band_bp) {
            buf[m] = quotes[i].twap_1e12;
            m += 1;
        }
        i += 1;
    }
    if (m as u8) < q {
        return Aggregate::BelowQuorum { eligible: m as u8, quorum: q };
    }

    // insertion sort the m eligible values (m ≤ 5, so O(m²) is trivial).
    let mut j = 1;
    while j < m {
        let key = buf[j];
        let mut k = j;
        while k > 0 && buf[k - 1] > key {
            buf[k] = buf[k - 1];
            k -= 1;
        }
        buf[k] = key;
        j += 1;
    }
    // MEDIAN: index m/2 — the exact middle for odd m, the upper-middle for even m.
    // Always an actual pool's TWAP (integer-exact, no synthetic average).
    Aggregate::Priced { price_1e12: buf[m / 2], eligible: m as u8 }
}

#[cfg(test)]
mod proofs {
    use super::*;

    const P: u128 = 1_000_000_000_000_000; // a 1000-CHIP/SOL reference price (×1e12)

    fn q(twap: u128, spot: u128, age: u32) -> PoolQuote {
        PoolQuote { twap_1e12: twap, spot_1e12: spot, age_secs: age }
    }
    /// an eligible pool at price `p` (spot == twap, fresh).
    fn ok(p: u128) -> PoolQuote { q(p, p, 0) }

    /// PROOF: the quorum table is a strict majority of the set — the exact values
    /// the spec pins (1-of-1, 2-of-2, 2-of-3, 3-of-4, 3-of-5).
    #[test]
    fn quorum_table_is_majority() {
        assert_eq!([quorum(1), quorum(2), quorum(3), quorum(4), quorum(5)], [1, 2, 2, 3, 3]);
        for n in 1u8..=5 {
            assert!(2 * quorum(n) > n, "quorum {} not a strict majority of {}", quorum(n), n);
            assert!(2 * (quorum(n) - 1) <= n, "quorum {} not minimal for {}", quorum(n), n);
        }
    }

    /// PROOF (bit-identical migration): a 1-pool set degenerates EXACTLY to the
    /// single-pool machine. When the one pool is eligible, the aggregate is its
    /// TWAP unchanged; when it is not, the aggregate refuses — the SAME two
    /// outcomes, at the SAME threshold, as today's `read_price` + `eval_price_gates`.
    #[test]
    fn single_pool_degenerates_to_twap() {
        // eligible → priced at exactly the pool's twap (no transform).
        for &p in &[1u128, P, 3 * P, 22_015_456_048_481_850u128] {
            assert_eq!(aggregate(&[ok(p)], 1, 90, 300), Aggregate::Priced { price_1e12: p, eligible: 1 });
        }
        // stale → refuse (age > staleness).
        assert_eq!(aggregate(&[q(P, P, 91)], 1, 90, 300), Aggregate::BelowQuorum { eligible: 0, quorum: 1 });
        // not-ready twap (0) → refuse.
        assert_eq!(aggregate(&[q(0, P, 0)], 1, 90, 300), Aggregate::BelowQuorum { eligible: 0, quorum: 1 });
        // spot out of band → refuse (5% drift vs 3% band).
        assert_eq!(aggregate(&[q(P, P * 105 / 100, 0)], 1, 90, 300), Aggregate::BelowQuorum { eligible: 0, quorum: 1 });
        // spot exactly at the band edge (3%) → still eligible (≤, matches §3).
        assert_eq!(aggregate(&[q(P, P + P * 300 / BP, 0)], 1, 90, 300), Aggregate::Priced { price_1e12: P, eligible: 1 });
    }

    /// PROOF: the priced median is a pure, deterministic integer function whose
    /// result is always one of the input TWAPs (no averaging, no float), and it
    /// sits at the median position of the eligible values.
    #[test]
    fn median_is_deterministic_and_exact() {
        let pools = [ok(3 * P), ok(P), ok(5 * P), ok(2 * P), ok(4 * P)];
        // 5 eligible, sorted {1,2,3,4,5}·P → median index 2 → 3·P.
        let a = aggregate(&pools, 5, 90, 300);
        assert_eq!(a, Aggregate::Priced { price_1e12: 3 * P, eligible: 5 });
        // determinism: same inputs, same output, and order-independent (a shuffle
        // of the same set yields the identical median).
        let shuffled = [ok(5 * P), ok(4 * P), ok(3 * P), ok(2 * P), ok(P)];
        assert_eq!(aggregate(&shuffled, 5, 90, 300), a);
        // the result is one of the inputs.
        if let Aggregate::Priced { price_1e12, .. } = a {
            assert!(pools.iter().any(|q| q.twap_1e12 == price_1e12));
        }
        // odd/even positions: 3 eligible → middle; 4 eligible → upper-middle.
        assert_eq!(aggregate(&[ok(P), ok(2 * P), ok(9 * P)], 3, 90, 300),
                   Aggregate::Priced { price_1e12: 2 * P, eligible: 3 });
        assert_eq!(aggregate(&[ok(P), ok(2 * P), ok(3 * P), ok(9 * P)], 4, 90, 300),
                   Aggregate::Priced { price_1e12: 3 * P, eligible: 4 });
    }

    /// PROOF (quorum gating): a 3-of-5 set with 2 stale pools is still LIVE (3 ≥ 3);
    /// with 3 stale it is REFUSED (2 < 3). The spec's worked gate case.
    #[test]
    fn quorum_gates_stale_pools() {
        // 3 fresh + 2 stale → 3 eligible = quorum → priced at the median of the fresh.
        let two_stale = [ok(P), ok(2 * P), ok(3 * P), q(P, P, 999), q(P, P, 999)];
        assert_eq!(aggregate(&two_stale, 5, 90, 300),
                   Aggregate::Priced { price_1e12: 2 * P, eligible: 3 });
        // 2 fresh + 3 stale → 2 < quorum 3 → refused.
        let three_stale = [ok(P), ok(2 * P), q(P, P, 999), q(P, P, 999), q(P, P, 999)];
        assert_eq!(aggregate(&three_stale, 5, 90, 300),
                   Aggregate::BelowQuorum { eligible: 2, quorum: 3 });
    }

    /// Median of the first `m` values of `buf` (already what `aggregate` computes,
    /// re-derived here directly on raw values for the manipulation proofs).
    fn median_of(vals: &[u128]) -> u128 {
        let mut v = vals.to_vec();
        v.sort_unstable();
        v[v.len() / 2]
    }

    /// PROOF (bounded manipulation, the core theorem): if a STRICT majority of the
    /// n eligible pools are honest and inside the band [P−δ, P+δ], the median is
    /// inside the band — for EVERY eligible count 1..=5, every choice of which
    /// pools are adversarial, and adversaries pinned at both extremes (0 and
    /// u128::MAX). Exhaustive over the subset lattice.
    #[test]
    fn honest_majority_bounds_the_median() {
        let lo = P - P / 100; // −1%
        let hi = P + P / 100; // +1%
        let honest_vals = [P - P / 100, P - P / 200, P, P + P / 200, P + P / 100];
        for n in 1usize..=5 {
            // every adversary subset of the n positions
            for mask in 0u32..(1 << n) {
                let c = mask.count_ones() as usize; // adversary count
                let h = n - c;
                if 2 * h <= n {
                    continue; // require a STRICT honest majority
                }
                // adversaries at each extreme
                for &adv in &[0u128, u128::MAX] {
                    let mut vals = [0u128; 5];
                    for (idx, slot) in vals.iter_mut().enumerate().take(n) {
                        *slot = if mask & (1 << idx) != 0 { adv } else { honest_vals[idx] };
                    }
                    let med = median_of(&vals[..n]);
                    assert!(
                        (lo..=hi).contains(&med),
                        "median {med} escaped band with n={n} adversaries={c} adv={adv} mask={mask:b}"
                    );
                }
            }
        }
    }

    /// PROOF (odd-set corollary — the recommended sizes 1,3,5): corrupting FEWER
    /// THAN quorum pools leaves the aggregate inside the band. For odd n,
    /// quorum = ⌈n/2⌉, so `c < quorum` ⇔ honest strict majority ⇔ bounded. This is
    /// the spec's headline "moving fewer than quorum pools moves the aggregate
    /// bounded-by-the-band."
    #[test]
    fn odd_set_fewer_than_quorum_is_bounded() {
        let lo = P - P / 100;
        let hi = P + P / 100;
        let honest_vals = [P - P / 100, P, P + P / 100, P - P / 200, P + P / 200];
        for &n in &[1usize, 3, 5] {
            let ql = quorum(n as u8) as usize;
            for mask in 0u32..(1 << n) {
                let c = mask.count_ones() as usize;
                if c >= ql {
                    continue; // only "fewer than quorum" corrupted
                }
                for &adv in &[0u128, u128::MAX] {
                    let mut vals = [0u128; 5];
                    for (idx, slot) in vals.iter_mut().enumerate().take(n) {
                        *slot = if mask & (1 << idx) != 0 { adv } else { honest_vals[idx] };
                    }
                    let med = median_of(&vals[..n]);
                    assert!((lo..=hi).contains(&med),
                        "odd-set median {med} escaped with n={n} c={c} < quorum {ql}");
                }
            }
        }
    }

    /// PROOF (the documented residual): EVEN sets (2, 4) have one edge the odd-set
    /// corollary does not cover — an adversary controlling EXACTLY HALF the
    /// eligible pools (quorum − 1 of them) CAN move an even-count median, because
    /// the even median has a 50% breakdown at the tie. The spec therefore
    /// RECOMMENDS odd set sizes; even sets stay solvent (the per-pool band + the
    /// margin floor still bind) but need strictly more than half honest for the
    /// bound. This test pins that the edge is real (not an oversight).
    #[test]
    fn even_set_tie_is_the_residual() {
        // 2-of-2: one adversary (quorum−1 = 1) is exactly half → moves the median.
        assert_eq!(median_of(&[P, u128::MAX]), u128::MAX, "n=2 half-adversary moves the median");
        // 4-of-set: two adversaries (quorum−1 = 2) is exactly half → moves it.
        assert_eq!(median_of(&[P, P, u128::MAX, u128::MAX]), u128::MAX, "n=4 half-adversary moves the median");
        // but ONE adversary in a 4-set (a true minority) stays bounded (corollary holds).
        let med = median_of(&[P, P, P, u128::MAX]);
        assert_eq!(med, P, "n=4 with a lone adversary stays at the honest price");
    }

    /// PROOF: the per-pool band gate is NOT bypassed by aggregation — a pool whose
    /// own spot is out of band is excluded BEFORE the median, so even a pool
    /// reporting a plausible TWAP cannot vote unless it also holds its spot in
    /// band (the full single-pool cost, per pool). Here a rigged pool at a wedge
    /// price with a matching spot is eligible (it paid the cost), but as a
    /// minority its vote is discarded by the median.
    #[test]
    fn rigged_minority_pool_is_outvoted() {
        // 5-set: 3 honest at P, 2 rigged pools that DID hold spot≈twap at 2·P.
        let pools = [ok(P), ok(P), ok(P), ok(2 * P), ok(2 * P)];
        assert_eq!(aggregate(&pools, 5, 90, 300),
                   Aggregate::Priced { price_1e12: P, eligible: 5 },
                   "two rigged (but minority) pools cannot move the median off the honest price");
        // a rigged pool that did NOT hold its spot in band is excluded entirely.
        let with_unbanded = [ok(P), ok(P), q(2 * P, 3 * P, 0)];
        assert_eq!(aggregate(&with_unbanded, 3, 90, 300),
                   Aggregate::Priced { price_1e12: P, eligible: 2 },
                   "an out-of-band pool is dropped before the median");
    }
}
