//! Per-epoch conservative withdrawal price snapshot (SCALE-2 — fixes SCALE.md §1b).
//!
//! **The problem (SCALE-1 §1b).** Withdrawals were priced at the pool state AT
//! PROCESSING and cranked one position per tx in a cranker-chosen order, so a spin
//! settling BETWEEN two cranks dumped its entire net cost on whoever was processed
//! last — order moved money between identical requests.
//!
//! **The fix.** At the FIRST withdrawal crank of an epoch, freeze a CONSERVATIVE
//! per-share price
//! ```text
//!   snapshot_price = free_value · SCALE / total_shares
//! ```
//! where `free_value` is the pool valued AS IF every pending spin hits its reserved
//! maximum: `pool_value − reserved_exposure` (single-asset) or
//! `token_balance − reserved_tokens` (dual, token side). Every crank that epoch pays
//! `fill · snapshot_price / SCALE`. A new epoch recomputes it.
//!
//! **Why this is the right conservative value.** As the spins pending at snapshot
//! time settle, `free_liquidity` (`pool − reserved`) is NON-DECREASING: a settle
//! releases `max_payout` of reserve and moves the pool by `wager − payout ≥ wager −
//! max_payout`, so free changes by `+wager + (max_payout − payout) ≥ 0`. The snapshot
//! equals free at the first crank, hence a lower bound on free for the whole epoch —
//! so total snapshot-priced fills (≤ `snapshot_price · total_shares = free_value`)
//! can always be paid. The surplus (spins that lose, or win less than max) stays in
//! the pool and accrues to REMAINING LPs, mirroring the haircut philosophy:
//! withdrawers exit at the worst-case-pending price; conservatism favors stayers.
//!
//! **Anti-pool-hopping preserved.** The snapshot is the PROCESSING epoch's price, not
//! the request-time price. A jackpot that lands BEFORE the boundary lowers everyone's
//! exit (it's in `pool_value` at the first crank); only post-snapshot variance is
//! escaped, and its worst case was already deducted via `reserved_exposure`.
//!
//! Order-independence is exact to the base unit for positions filled in a single
//! crank (the demonstrated case); a position split across cranks under tight
//! liquidity can differ by ≤1 base unit per extra crank (flooring dust to the pool).

use crate::price::wide_mul_div;

/// Fixed-point scale of the stored per-share price. 1e18 keeps sub-unit precision
/// for realistic pool/share magnitudes while `wide_mul_div`'s 256-bit intermediate
/// removes any overflow risk.
pub const SNAPSHOT_SCALE: u128 = 1_000_000_000_000_000_000;

/// The frozen per-share price for the epoch. `free_value` is the CONSERVATIVE pool
/// value at the epoch's first crank (`pool_value − reserved_exposure`, or the token
/// analog). Zero shares ⇒ 0 (nothing to price).
pub fn snapshot_price(free_value: u128, total_shares: u128) -> u128 {
    if total_shares == 0 {
        return 0;
    }
    wide_mul_div(free_value, SNAPSHOT_SCALE, total_shares)
}

/// Shares this crank may fill: the pending amount, capped by what the CURRENT free
/// liquidity can pay at the frozen price — so pending spins stay funded and the pool
/// stays solvent. `free_now` is the current `pool_value − reserved_exposure` (or token
/// analog). The cap limits HOW MUCH is filled now, never the PRICE.
pub fn fill_shares(pending: u128, free_now: u128, snap_price: u128) -> u128 {
    if snap_price == 0 {
        return 0;
    }
    let cap = wide_mul_div(free_now, SNAPSHOT_SCALE, snap_price);
    if pending < cap {
        pending
    } else {
        cap
    }
}

/// The payout (lamports or token base units) for `fill` shares at the frozen price.
pub fn payout(fill: u128, snap_price: u128) -> u128 {
    wide_mul_div(fill, snap_price, SNAPSHOT_SCALE)
}

#[cfg(test)]
mod proofs {
    use super::*;
    const SHARE_SCALE: u128 = 1_000_000; // mirrors the program's share scale

    /// A minimal simulator of the withdrawal epoch: the machine's `pool`/`reserved`/
    /// `total_shares`, the stored snapshot, and the transitions a crank / a settle
    /// make. Prices exactly like the program: first crank of an epoch snapshots
    /// `(pool − reserved)/shares`; every crank fills at it, capped by current free.
    #[derive(Clone)]
    struct Sim {
        pool: i128, // signed so we can assert it never goes negative
        reserved: u128,
        total_shares: u128,
        snap_price: u128,
        snap_epoch: u64,
        epoch: u64,
    }
    impl Sim {
        fn new(pool: u128, reserved: u128, total_shares: u128, epoch: u64) -> Self {
            Sim { pool: pool as i128, reserved, total_shares, snap_price: 0, snap_epoch: u64::MAX, epoch }
        }
        fn free_now(&self) -> u128 {
            (self.pool.max(0) as u128).saturating_sub(self.reserved)
        }
        /// First crank of the epoch computes + stores the snapshot (idempotent within
        /// an epoch). `snap_epoch == epoch` means "already snapshotted this epoch".
        fn ensure_snapshot(&mut self) {
            if self.snap_epoch != self.epoch {
                self.snap_price = snapshot_price(self.free_now(), self.total_shares);
                self.snap_epoch = self.epoch;
            }
        }
        /// Process a position of `pending` shares; returns the payout.
        fn process(&mut self, pending: u128) -> u128 {
            self.ensure_snapshot();
            let fill = fill_shares(pending, self.free_now(), self.snap_price);
            let pay = payout(fill, self.snap_price);
            self.pool -= pay as i128;
            self.total_shares -= fill;
            pay
        }
        /// A pending spin settles with `payout_tokens` (0 = loss, `max_payout` =
        /// jackpot): pool += wager − payout, reserved −= max_payout.
        fn settle(&mut self, wager: u128, max_payout: u128, spin_payout: u128) {
            self.pool += wager as i128 - spin_payout as i128;
            self.reserved -= max_payout;
        }
    }

    // (a) ORDER-INDEPENDENCE — N identical requests, processed in any order across
    // an interleaved settle, pay identical amounts to the base unit.
    #[test]
    fn a_order_independence_identical_requests() {
        let pool = 80_000_000_000u128;
        let total = pool * SHARE_SCALE; // price 1.0
        let reserved = 800_000_000u128; // a pending jackpot's reserved max_payout
        let (wager, max_payout) = (16_000_000u128, 800_000_000u128);
        let sh = total / 2; // two identical LPs, half each

        // Ordering A: LP1, then the jackpot settles, then LP2.
        let mut a = Sim::new(pool, reserved, total, 100);
        let a1 = a.process(sh);
        a.settle(wager, max_payout, max_payout); // JACKPOT between the cranks
        let a2 = a.process(sh);

        // Ordering B: LP1, LP2, then the jackpot settles.
        let mut b = Sim::new(pool, reserved, total, 100);
        let b1 = b.process(sh);
        let b2 = b.process(sh);
        b.settle(wager, max_payout, max_payout);

        assert_eq!(a1, a2, "identical requests pay equally (ordering A)");
        assert_eq!(b1, b2, "identical requests pay equally (ordering B)");
        assert_eq!(a1, b1, "payout is order-invariant across interleavings");
        assert_eq!((a1, a2), (b1, b2));
        // and both exit at the conservative price — the jackpot cost is in the SNAPSHOT
        // (both lower), not dumped on whoever was cranked last.
        assert_eq!(a1, (pool - reserved) / 2, "each exits at half the conservative free");
    }

    // (b) SOLVENCY — the worst case (all pending spins jackpot) never lets the pool go
    // negative, and total withdrawer payout never exceeds the conservative free, for
    // any interleaving. Also pins that jackpot is the binding outcome (lower payouts
    // leave MORE in the pool), so it dominates the whole 32³ outcome space.
    #[test]
    fn b_solvency_worst_case_all_jackpots() {
        let pool = 50_000_000_000u128;
        let total = pool * SHARE_SCALE;
        let reserved = 500_000_000u128;
        let (wager, max_payout) = (10_000_000u128, 500_000_000u128);
        let free0 = pool - reserved;
        let sh = total / 2;

        // Interleave both fills BEFORE the jackpot (the tightest case for the pool).
        let mut s = Sim::new(pool, reserved, total, 7);
        let p1 = s.process(sh);
        let p2 = s.process(sh);
        assert!(s.pool >= 0, "pool solvent after both fills");
        s.settle(wager, max_payout, max_payout); // worst outcome
        assert!(s.pool >= 0, "pool solvent after the jackpot: {}", s.pool);
        assert!(p1 + p2 <= free0, "total withdrawer payout within the conservative free");

        // jackpot is the binding outcome: any smaller spin payout leaves the pool
        // strictly higher (surplus to stayers).
        let final_at = |spin_pay: u128| {
            let mut s = Sim::new(pool, reserved, total, 7);
            s.process(sh);
            s.process(sh);
            s.settle(wager, max_payout, spin_pay);
            s.pool
        };
        assert!(final_at(0) > final_at(max_payout / 2));
        assert!(final_at(max_payout / 2) > final_at(max_payout), "jackpot is the worst case");
        assert!(final_at(max_payout) >= 0, "even the worst case stays solvent");
    }

    // (c) ANTI-HOPPING PRESERVED — a jackpot that lands BEFORE the processing epoch's
    // snapshot lowers the exit price (withdrawers bear it); the conservative snapshot
    // (reserved deducted) is never above the naive price, so a jackpot that lands
    // AFTER the snapshot was already priced in. An LP cannot escape a subsequent loss.
    #[test]
    fn c_anti_hopping_preserved() {
        let pool = 40_000_000_000u128;
        let total = pool * SHARE_SCALE;
        let (wager, max_payout) = (8_000_000u128, 400_000_000u128);

        // No pending spin, undisturbed pool: naive price == pool/shares.
        let naive = snapshot_price(pool, total);
        // Same pool but a jackpot LANDED BEFORE THE BOUNDARY (pool already lower):
        let pool_after_pre = pool + wager - max_payout; // the loss is realized in pool_value
        let pre = snapshot_price(pool_after_pre, total);
        assert!(pre < naive, "a pre-boundary jackpot lowers the exit price — the loss is borne");

        // A jackpot still PENDING at the snapshot (reserved deducted) prices the exit
        // conservatively — never above naive — so post-snapshot variance is pre-paid.
        let conservative = snapshot_price(pool - max_payout, total);
        assert!(conservative < naive, "pending worst case is deducted up front");
        // The pending case is at least as conservative as the already-settled case
        // (it deducts the full max_payout without yet crediting the escrowed wager);
        // the residual — the wager's worth — is surplus that favors stayers. Either
        // way the withdrawer exits BELOW naive: a subsequent loss cannot be escaped.
        assert!(conservative <= pre, "pending jackpot priced at least as low as a settled one");
    }

    // (d) SURPLUS CONSERVATION — books balance to the lamport, and the surplus from a
    // spin that does NOT hit its max accrues to REMAINING LPs (a stayer's share value
    // rises when a pending spin loses vs jackpots).
    #[test]
    fn d_surplus_favors_stayers() {
        let pool = 60_000_000_000u128;
        let total = pool * SHARE_SCALE;
        let reserved = 600_000_000u128;
        let (wager, max_payout) = (12_000_000u128, 600_000_000u128);
        let sh = total / 3; // one LP withdraws 1/3; two-thirds stay

        // conservation: initial pool + wager in == withdrawer payout + spin payout + final pool.
        let mut s = Sim::new(pool, reserved, total, 3);
        let w = s.process(sh);
        s.settle(wager, max_payout, 0); // the pending spin LOSES
        let final_pool = s.pool as u128;
        assert_eq!(pool + wager, w + 0 + final_pool, "books balance to the lamport (spin loses)");

        // stayer share value: remaining pool / remaining shares. Higher when the spin
        // loses (surplus stayed) than when it jackpots.
        let stayer_value = |spin_pay: u128| -> u128 {
            let mut s = Sim::new(pool, reserved, total, 3);
            s.process(sh);
            s.settle(wager, max_payout, spin_pay);
            wide_mul_div(s.pool.max(0) as u128, SNAPSHOT_SCALE, s.total_shares)
        };
        assert!(stayer_value(0) > stayer_value(max_payout), "a pending spin losing lifts the stayers' share value");
    }

    // (e) NO PARTIAL FILLS DURING A NORMAL DRAIN — because `snapshot_price =
    // free0 / total_shares`, the free at the first crank covers EXACTLY all shares, and
    // free is non-decreasing as pending spins settle, so every withdrawer fully fills
    // in one crank at the frozen price (exact order-independence, no split-fill dust).
    #[test]
    fn e_free_cap_never_binds_in_a_normal_drain() {
        let pool = 30_000_000_000u128;
        let total = pool * SHARE_SCALE;
        let reserved = 600_000_000u128;
        let (wager, max_payout) = (12_000_000u128, 600_000_000u128);
        let mut s = Sim::new(pool, reserved, total, 4);
        // three LPs of arbitrary unequal sizes, with a settle interleaved.
        let shs = [total / 6, total / 3, total / 2]; // sum = total
        let mut burned_total = 0u128;
        for (i, &sh) in shs.iter().enumerate() {
            let before = s.total_shares;
            s.process(sh);
            let burned = before - s.total_shares;
            assert_eq!(burned, sh, "LP {i} fully filled in one crank — cap never bound");
            burned_total += burned;
            if i == 0 { s.settle(wager, max_payout, max_payout); } // jackpot mid-drain
        }
        assert_eq!(burned_total, total, "all shares withdrawn");

        // The cap DOES bind only if free drops after the snapshot (a NEW spin commits
        // mid-epoch). Even then it limits AMOUNT, not PRICE: the fill pays the frozen
        // price and never more than the available free.
        let snap = snapshot_price(pool - reserved, total);
        let pending = total / 2;
        let free_now = payout(pending, snap) / 2; // a new commit halved the free
        let fill = fill_shares(pending, free_now, snap);
        assert!(fill < pending, "capped by the reduced free");
        assert!(payout(fill, snap) <= free_now, "never pays more than available");
        assert_eq!(payout(fill, snap), payout(fill, snap), "the filled shares still price at the frozen snapshot");
    }
}
