//! MasterChef-style per-share SOL dividend ledger for dual-asset machines (H6b-2).
//!
//! Dual-asset machines take SOL wagers and pay token prizes, so every settled
//! wager is retained in SOL — pure income to the LP pool (there is no SOL payout
//! side). That SOL is distributed to token-share holders through a per-share
//! accumulator, exactly the SushiSwap/MasterChef reward-debt pattern:
//!
//!   acc_sol_per_share += amount · SCALE / total_shares        (on each accrual)
//!   entitlement(pos)   = pos.shares · acc / SCALE
//!   pending(pos)       = entitlement(pos) − pos.sol_debt
//!
//! A deposit sets `sol_debt` so the new shares are entitled to ZERO of any prior
//! accrual (no dilution). A claim pays `min(pending, pool_balance)` and lifts
//! `sol_debt` by exactly what was paid.
//!
//! CONSERVATION MODEL. A per-share index cannot make `Σ floor(shares_i·acc)`
//! agree with the distributed total to the lamport — independent per-position
//! flooring can drift by up to one lamport per position. So conservation is
//! anchored to the PHYSICAL dividend pool, not to the sum of estimates: every
//! settled wager adds its full amount to `div_pool_sol`, every claim removes
//! exactly what it pays, and a claim is capped at the pool balance. Then
//! `accrued == claimed + pool` holds to the lamport across ANY interleaving, the
//! pool never goes negative (no claim is ever over-paid — rounding only ever
//! favors the pool), and whatever rounding leaves behind is DUST that stays in
//! the pool. The uncapped `pending` is the fair-share estimate a UI shows; the
//! cap is what makes the books exact.
//!
//! Scale is 1e24 (not 1e12): shares are token base units × SHARE_SCALE(1e6), so
//! they are large, and a small SOL wager over a large share count must still
//! move the index. All multiply-divides go through the 256-bit
//! [`crate::price::wide_mul_div`] so nothing overflows u128.

use crate::price::wide_mul_div;

/// Fixed-point scale of `acc_sol_per_share`. 1e24 keeps the per-share increment
/// precise for share counts up to ~1e25 (token u64 × SHARE_SCALE) against
/// lamport-scale wagers; dust per accrual is then < ~1 lamport.
pub const SOL_INDEX_SCALE: u128 = 1_000_000_000_000_000_000_000_000; // 1e24

/// floor(shares · acc / SCALE) — a share count's total SOL entitlement to date.
pub fn sol_entitlement(shares: u128, acc_sol_per_share: u128) -> u128 {
    wide_mul_div(shares, acc_sol_per_share, SOL_INDEX_SCALE)
}

/// pending SOL for a position: entitlement − debt, floored and never negative.
pub fn pending_sol(shares: u128, sol_debt: u128, acc_sol_per_share: u128) -> u128 {
    sol_entitlement(shares, acc_sol_per_share).saturating_sub(sol_debt)
}

/// The index after distributing `amount` lamports across `total_shares`. Floors,
/// so the remainder stays in the pool as dust (caller must hold the full
/// `amount` physically). Returns `acc` unchanged if there are no shares.
pub fn accrue(acc_sol_per_share: u128, total_shares: u128, amount: u128) -> u128 {
    if total_shares == 0 {
        return acc_sol_per_share;
    }
    acc_sol_per_share + wide_mul_div(amount, SOL_INDEX_SCALE, total_shares)
}

/// The `sol_debt` a position must carry, when its share count changes to
/// `new_shares`, to leave its current `pending` exactly unchanged (so a deposit
/// dilutes nobody and grants the new shares zero prior accrual). For a fresh
/// position (`pending_before == 0`) this is simply the current entitlement.
pub fn debt_preserving_pending(new_shares: u128, acc_sol_per_share: u128, pending_before: u128) -> u128 {
    // pending_before ≤ entitlement(old_shares) ≤ entitlement(new_shares) since
    // shares only grow on deposit, so this never underflows.
    sol_entitlement(new_shares, acc_sol_per_share) - pending_before
}

#[cfg(test)]
mod proofs {
    use super::*;
    const SHARE_SCALE: u128 = 1_000_000; // mirrors the program's share scale

    // A tiny reference ledger the proofs drive through arbitrary op sequences.
    // It tracks the PHYSICAL dividend pool, exactly like the on-chain machine.
    struct Pos { shares: u128, sol_debt: u128 }
    struct Ledger {
        acc: u128,
        total_shares: u128,
        accrued: u128, // every lamport ever routed to dividends
        claimed: u128, // every lamport ever paid out
        pool: u128,    // physical SOL held for dividends (== accrued − claimed)
        pos: Vec<Pos>,
    }
    impl Ledger {
        fn new(n: usize) -> Self {
            Ledger { acc: 0, total_shares: 0, accrued: 0, claimed: 0, pool: 0,
                     pos: (0..n).map(|_| Pos { shares: 0, sol_debt: 0 }).collect() }
        }
        fn pending(&self, i: usize) -> u128 {
            pending_sol(self.pos[i].shares, self.pos[i].sol_debt, self.acc)
        }
        fn deposit(&mut self, i: usize, ds: u128) {
            let before = self.pending(i);
            self.pos[i].shares += ds;
            self.total_shares += ds;
            self.pos[i].sol_debt = debt_preserving_pending(self.pos[i].shares, self.acc, before);
        }
        fn accrue_amt(&mut self, amt: u128) {
            self.acc = accrue(self.acc, self.total_shares, amt);
            self.accrued += amt;
            self.pool += amt; // the full wager is held physically
        }
        /// Claim: pay min(pending, pool) — the cap is what keeps the pool ≥ 0 and
        /// the books exact. Debt rises by exactly what was paid, so any uncollected
        /// remainder stays claimable when the pool refills.
        fn claim(&mut self, i: usize) -> u128 {
            let paid = self.pending(i).min(self.pool);
            self.pos[i].sol_debt += paid;
            self.claimed += paid;
            self.pool -= paid;
            paid
        }
        fn withdraw(&mut self, i: usize, ws: u128) {
            self.claim(i); // harvest first (MasterChef)
            self.pos[i].shares -= ws;
            self.total_shares -= ws;
            self.pos[i].sol_debt = sol_entitlement(self.pos[i].shares, self.acc);
        }
        /// The exact, physical invariant checked after every operation.
        fn check_conservation(&self) {
            assert_eq!(self.claimed + self.pool, self.accrued, "conservation broke");
            // pool is u128, so pool ≥ 0 is structural; assert the cap held it there.
            assert!(self.claimed <= self.accrued, "over-distribution");
        }
    }

    /// PROOF (a): conservation to the lamport across an arbitrary interleaving of
    /// deposit / accrue / claim / withdraw — every accrued lamport is either
    /// claimed or physically in the pool (`claimed + pool == accrued`), the pool
    /// never goes negative, and after draining all positions the pool holds only
    /// dust (rounding remainder), owed to no one.
    #[test]
    fn conservation_over_arbitrary_interleavings() {
        // deterministic pseudo-random script (LCG) so the sweep is reproducible.
        let mut rng: u64 = 0x1234_5678_9abc_def1;
        let mut next = || { rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1); rng >> 33 };
        let mut l = Ledger::new(4);
        for _ in 0..4000 {
            let op = next() % 4;
            let i = (next() % 4) as usize;
            match op {
                0 => { let ds = 1 + next() % 5_000_000; l.deposit(i, ds as u128 * SHARE_SCALE); }
                1 => if l.total_shares > 0 { let amt = 1 + next() % 2_000_000_000; l.accrue_amt(amt as u128); }
                2 => { l.claim(i); }
                _ => { let s = l.pos[i].shares; if s > 0 { let ws = 1 + next() % (s as u64).max(1) as u64; l.withdraw(i, (ws as u128).min(s)); } }
            }
            l.check_conservation();
        }
        assert!(l.accrued > 0 && l.claimed > 0 && l.total_shares > 0);
        // drain everyone: the pool never underflows and what's left is bounded dust.
        for _ in 0..8 { for i in 0..4 { l.claim(i); } }
        l.check_conservation();
        let dust = l.pool; // accrued − claimed after full drain
        assert!(dust < 4 * 200, "dust unexpectedly large: {dust}"); // ≪ 1 lamport/accrue/position
    }

    /// PROOF (b): a deposit made AFTER accrual owes the new position exactly 0
    /// from prior accruals — no dilution of, and no theft from, existing holders.
    #[test]
    fn no_dilution_for_deposit_after_accrual() {
        let mut l = Ledger::new(2);
        l.deposit(0, 1_000_000 * SHARE_SCALE); // existing LP
        l.accrue_amt(5_000_000_000); // 5 SOL of yield accrues to LP 0
        let owed_before = l.pending(0);
        assert!(owed_before > 0);
        // a brand-new LP deposits the same size AFTER the accrual
        l.deposit(1, 1_000_000 * SHARE_SCALE);
        assert_eq!(l.pending(1), 0, "new depositor must owe 0 from prior accrual");
        // and the existing LP's entitlement is untouched by the new deposit
        assert_eq!(l.pending(0), owed_before, "existing LP diluted by a later deposit");
    }

    /// PROOF (c): at an adversarial ratio (a wager indivisible by the share
    /// count), draining every position never over-draws the pool — total paid ≤
    /// accrued — and the leftover dust stays in the pool. Rounding only ever
    /// favors the pool.
    #[test]
    fn rounding_never_favors_claimant() {
        let mut l = Ledger::new(3);
        l.deposit(0, 333_333 * SHARE_SCALE);
        l.deposit(1, 666_667 * SHARE_SCALE);
        // an awkward, prime-ish wager that will not divide evenly
        for _ in 0..50 { l.accrue_amt(1_000_000_007); }
        l.check_conservation();
        // claiming everyone (repeatedly) can never overdraw the pool.
        let mut paid = 0u128;
        for _ in 0..3 { for i in 0..3 { paid += l.claim(i); } }
        assert!(paid <= l.accrued, "paid {} exceeded accrued {}", paid, l.accrued);
        assert_eq!(l.claimed, paid);
        l.check_conservation();
        // whatever remains is dust, held in the pool, owed to no one.
        assert_eq!(l.pool, l.accrued - l.claimed);
    }

    /// PROOF: claiming twice pays once — the second claim yields 0 until more accrues.
    #[test]
    fn claim_twice_pays_once() {
        let mut l = Ledger::new(1);
        l.deposit(0, 2_000_000 * SHARE_SCALE);
        l.accrue_amt(3_000_000_000);
        let first = l.claim(0);
        assert!(first > 0);
        assert_eq!(l.claim(0), 0, "second claim with no new accrual pays nothing");
        l.accrue_amt(1_000_000_000);
        assert!(l.claim(0) > 0, "new accrual is claimable again");
    }
}
