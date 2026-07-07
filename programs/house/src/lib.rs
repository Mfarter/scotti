//! Yvone House Module — H1 program skeleton.
//!
//! Peer-to-house slot machines backed by LP pools, where the odds are a
//! published deterministic function of pool state (HOUSE-SPEC §1–2). This
//! program owns the money movement and lifecycle; ALL odds/exposure/smoothing
//! arithmetic is delegated to the `yvone-house-math` crate (the H0 artifact
//! with the enumeration solvency proofs) — this program never reimplements it.
//!
//! Randomness is abstracted behind a narrow seam (`commit_seed_slot` +
//! `revealed_bytes`) with two implementations selected at compile time:
//!   * `mock-randomness` feature ON  → reads a program-owned MockRandomness
//!     account (LiteSVM tests only; a deployable mock is a drain-everything
//!     backdoor, so this feature is OFF in the default/deployable build);
//!   * feature OFF (default/deployable) → Switchboard On-Demand (H2): parse
//!     RandomnessAccountData, enforce seed_slot freshness at commit, and read
//!     the revealed value at settle (reveal bundled in the settle tx).
//!
//! Mirrors the Yvone-Protocol arbiter patterns: singleton config PDA
//! (initialize-once + update_admin), direct-debit lamport transfers, manual
//! `close` on permissionless cranks.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
// Real Raydium CLMM swap CPI (compound_epoch's deployable path). The mock-swap
// build uses none of these — they are pulled in only when the real seam compiles.
#[cfg(not(feature = "mock-swap"))]
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use yvone_house_math as hm;
// Switchboard On-Demand parsing lives only in the deployable (non-mock) build.
#[cfg(not(feature = "mock-randomness"))]
use switchboard_on_demand::{RandomnessAccountData, ON_DEMAND_DEVNET_PID};

declare_id!("EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ");

/// Share scale: the first deposit mints `amount * SHARE_SCALE` shares, so the
/// initial share price is 1/1e6 (HOUSE-SPEC §5, "first deposit 1:1 at 1e6
/// scale"). Subsequent deposits mint at the prevailing price, preserving it.
pub const SHARE_SCALE: u128 = 1_000_000;

/// Reveal-expiry window: a spin whose randomness never resolves within this
/// many slots (~1h at ~0.4s/slot) can be permissionlessly expired and refunded
/// (HOUSE-SPEC §4.3). Matches the smoothing window by construction.
pub const EXPIRE_SLOTS: u64 = hm::SMOOTH_WINDOW_SLOTS;

/// Epoch length (slots) used by machines whose `epoch_length` is 0 — i.e. those
/// created before H3 added the field (it reads 0 out of the old `reserved`
/// tail). ~9 min at ~0.4s/slot on devnet, so withdrawals are testable live;
/// production machines set a larger value (the spec's 6h) at creation.
pub const DEFAULT_EPOCH_LENGTH_SLOTS: u64 = 1_350;

const JACKPOT_SYMBOLS: [u8; hm::REELS] = [hm::JACKPOT, hm::JACKPOT, hm::JACKPOT];

#[program]
pub mod house {
    use super::*;

    /// Create the singleton HouseConfig, setting the initial admin. Anchor
    /// `init` makes this callable exactly once. First-caller-wins is acceptable
    /// ONLY because we initialize immediately after the program upgrade (same
    /// devnet caveat as the arbiter's ProtocolConfig / core SPEC §3.2).
    pub fn initialize_house_config(ctx: Context<InitializeHouseConfig>, admin: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.bump = ctx.bumps.config;
        c.reserved = [0u8; HouseConfig::RESERVED_LEN];
        Ok(())
    }

    /// Rotate the house admin. Only the current admin may call this.
    pub fn update_admin(ctx: Context<UpdateAdmin>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.admin = new_admin;
        Ok(())
    }

    /// Admin-gated machine creation. Params are validated and immutable after
    /// creation except `paused` (HOUSE-SPEC §6, admin risk): a param upgrade is
    /// a new machine. The paytable tiers themselves are house-math constants
    /// (SHALLOW/DEEP), shared by every machine — not stored per-machine.
    pub fn create_machine(
        ctx: Context<CreateMachine>,
        machine_id: [u8; 16],
        d_low: u64,
        d_mid: u64,
        d_high: u64,
        max_exposure_bp: u64,
        smooth_window: u64,
        epoch_length: u64,
        curator: Pubkey,
    ) -> Result<()> {
        // d_low < d_mid < d_high, all positive; the curve and tier split are
        // only well-defined under this ordering (house-math debug-asserts it).
        require!(0 < d_low && d_low < d_mid && d_mid < d_high, HouseError::InvalidParams);
        // exposure in (0, 100%]; the spec's governance default is 100 bp (1%).
        require!(max_exposure_bp > 0 && max_exposure_bp <= hm::BP as u64, HouseError::InvalidParams);
        require!(smooth_window > 0, HouseError::InvalidParams);
        // epoch_length must be > 0 (0 is the legacy sentinel meaning "default").
        require!(epoch_length > 0, HouseError::InvalidParams);

        let now = Clock::get()?.slot;
        let m = &mut ctx.accounts.machine;
        m.machine_id = machine_id;
        m.curator = curator;
        m.d_low = d_low;
        m.d_mid = d_mid;
        m.d_high = d_high;
        m.max_exposure_bp = max_exposure_bp;
        m.smooth_window = smooth_window;
        m.epoch_length = epoch_length;
        m.pool_value = 0;
        m.reserved_exposure = 0;
        m.total_shares = 0;
        // smoothed depth is seeded at the FIRST deposit (cold-start fix); a
        // machine with no bankroll has no depth to read.
        m.smoothed_value = 0;
        m.smoothed_last_slot = now;
        m.paused = false;
        m.bump = ctx.bumps.machine;
        m.reserved = [0u8; Machine::RESERVED_LEN];
        Ok(())
    }

    /// Curator halts (or resumes) spin commits (HOUSE-SPEC §6, admin risk).
    /// A halt blocks `spin_commit` only — settles and expires of already-
    /// committed spins must always proceed, so escrowed wagers never strand.
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.machine.paused = paused;
        Ok(())
    }

    /// LP deposits `amount` lamports into the machine vault and receives shares
    /// at the prevailing share price (HOUSE-SPEC §5). Allowed while paused —
    /// pausing only halts spins, never liquidity. Lamports land in the Machine
    /// PDA (the vault); `pool_value` is the internal accounting depth the curve
    /// reads, so it tracks principal + realized edge, never raw lamports.
    pub fn lp_deposit(ctx: Context<LpDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, HouseError::InvalidWager);

        let m = &ctx.accounts.machine;
        let first_deposit = m.total_shares == 0;
        let shares: u128 = if first_deposit {
            // first deposit: 1:1 at 1e6 scale.
            (amount as u128).checked_mul(SHARE_SCALE).ok_or(HouseError::MathOverflow)?
        } else {
            require!(m.pool_value > 0, HouseError::MathOverflow);
            (amount as u128)
                .checked_mul(m.total_shares).ok_or(HouseError::MathOverflow)?
                .checked_div(m.pool_value as u128).ok_or(HouseError::MathOverflow)?
        };
        require!(shares > 0, HouseError::DepositTooSmall);

        // move lamports owner -> vault (Machine PDA) via the system program.
        invoke(
            &system_instruction::transfer(&ctx.accounts.owner.key(), &ctx.accounts.machine.key(), amount),
            &[
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.machine.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let m = &mut ctx.accounts.machine;
        m.pool_value = m.pool_value.checked_add(amount).ok_or(HouseError::MathOverflow)?;
        m.total_shares = m.total_shares.checked_add(shares).ok_or(HouseError::MathOverflow)?;
        // Cold-start fix (H3): a machine's FOUNDING bankroll is not a change to
        // damp — seed the smoothed depth to it directly so max_bet is meaningful
        // immediately, instead of ramping from zero over the whole window.
        if first_deposit {
            m.smoothed_value = amount as u128;
            m.smoothed_last_slot = Clock::get()?.slot;
        }

        let pos = &mut ctx.accounts.position;
        pos.machine = ctx.accounts.machine.key();
        pos.owner = ctx.accounts.owner.key();
        pos.shares = pos.shares.checked_add(shares).ok_or(HouseError::MathOverflow)?;
        pos.bump = ctx.bumps.position;
        Ok(())
    }

    /// Queue `shares` for epoch-gated withdrawal (HOUSE-SPEC §5). The shares
    /// move from active to pending so they can't be double-requested; the
    /// position keeps owning them (total_shares/pool_value unchanged, so the
    /// share price is untouched until they are actually processed and burned).
    /// Requesting again adds to the queue and (re)stamps the current epoch, so
    /// the whole pending amount waits at least one epoch boundary.
    pub fn request_withdraw(ctx: Context<RequestWithdraw>, shares: u128) -> Result<()> {
        require!(shares > 0, HouseError::InvalidWithdrawAmount);
        let now = Clock::get()?.slot;
        let epoch = ctx.accounts.machine.epoch_of(now);
        let pos = &mut ctx.accounts.position;
        require!(pos.shares >= shares, HouseError::InsufficientShares);
        pos.shares -= shares;
        pos.pending_shares = pos.pending_shares.checked_add(shares).ok_or(HouseError::MathOverflow)?;
        pos.pending_epoch = epoch;
        Ok(())
    }

    /// Cancel a pending request before it is processed, restoring the shares to
    /// the active balance exactly (HOUSE-SPEC §5).
    pub fn cancel_withdraw(ctx: Context<CancelWithdraw>) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.pending_shares > 0, HouseError::NothingToWithdraw);
        pos.shares = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        pos.pending_shares = 0;
        pos.pending_epoch = 0;
        Ok(())
    }

    /// Permissionless epoch crank (HOUSE-SPEC §5). Processes ONE position's
    /// pending request, once its epoch has fully elapsed, at the share price AT
    /// THIS MOMENT (pool_value / total_shares) — never the request-time price;
    /// that repricing is the anti-pool-hopping mechanism. The fill is capped by
    /// the liquidity floor `free = pool_value - reserved_exposure`, so pending
    /// spins stay funded; any remainder stays queued. Call once per position;
    /// cranking several in one tx prices each at the state left by the previous.
    pub fn process_withdrawals(ctx: Context<ProcessWithdrawals>) -> Result<()> {
        let now = Clock::get()?.slot;
        let m = &ctx.accounts.machine;
        let pending = ctx.accounts.position.pending_shares;
        require!(pending > 0, HouseError::NothingToWithdraw);
        // the request's epoch must be strictly in the past (waited a boundary).
        require!(m.epoch_of(now) > ctx.accounts.position.pending_epoch, HouseError::EpochNotElapsed);
        require!(m.total_shares > 0 && m.pool_value > 0, HouseError::MathOverflow);

        // SCALE-2: price this withdrawal at the epoch's CONSERVATIVE snapshot, frozen
        // at the epoch's first crank, so a spin settling mid-drain can't move money
        // between identical requests by processing order (SCALE.md §1b; house-math
        // `snapshot`). free_value = pool_value − reserved_exposure (the pool valued as
        // if every pending spin hits its reserved maximum). A new epoch (or a legacy
        // zero / a still-unpriceable epoch) recomputes; otherwise the stored price is
        // reused. Anti-hopping is preserved: this is the PROCESSING epoch's price.
        let epoch = m.epoch_of(now);
        let free_now = m.free_liquidity() as u128;
        let snap_price = if m.withdraw_snapshot_epoch == epoch && m.withdraw_snapshot_price != 0 {
            m.withdraw_snapshot_price
        } else {
            hm::snapshot::snapshot_price(free_now, m.total_shares)
        };

        // fill capped by the CURRENT free (keeps pending spins funded); the cap limits
        // HOW MUCH fills now, never the PRICE. Payout = fill × snapshot price.
        let fill_shares = hm::snapshot::fill_shares(pending, free_now, snap_price);
        let payout_u128 = hm::snapshot::payout(fill_shares, snap_price);
        let payout = u64::try_from(payout_u128).map_err(|_| HouseError::MathOverflow)?;

        // burn the filled shares and remove the paid lamports from pool depth;
        // flooring dust stays in the pool (accrues to remaining LPs).
        let m = &mut ctx.accounts.machine;
        // freeze the snapshot for the epoch (first meaningful crank stores it).
        m.withdraw_snapshot_price = snap_price;
        m.withdraw_snapshot_epoch = epoch;
        m.total_shares -= fill_shares;
        m.pool_value -= payout;

        let pos = &mut ctx.accounts.position;
        pos.pending_shares -= fill_shares;

        if payout > 0 {
            debit_credit(&ctx.accounts.machine.to_account_info(), &ctx.accounts.owner, payout)?;
        }

        // fully-emptied position (no active, no pending) closes; rent to owner.
        let pos = &ctx.accounts.position;
        if pos.shares == 0 && pos.pending_shares == 0 {
            ctx.accounts.position.close(ctx.accounts.owner.to_account_info())?;
        }
        Ok(())
    }

    /// Commit a spin (HOUSE-SPEC §4.1). Freezes the odds at commit: the snapshot
    /// `(k, tier, max_payout)` is computed from the SMOOTHED depth and stored;
    /// settle honors it and can never re-price. The wager is escrowed into the
    /// vault and its worst-case payout is added to `reserved_exposure`.
    pub fn spin_commit(ctx: Context<SpinCommit>, wager: u64, nonce: u64) -> Result<()> {
        let m = &ctx.accounts.machine;
        require!(!m.paused, HouseError::MachinePaused);
        require!(wager > 0, HouseError::InvalidWager);

        let now = Clock::get()?.slot;

        // Advance the anti-snipe smoothed depth toward spot pool_value, then read
        // k and tier from the SMOOTHED value — never instantaneous depth. The
        // curve reads internal `pool_value`, so lamport donations to the vault
        // are inert (HOUSE-SPEC §6 donation attack).
        let mut sd = hm::SmoothedDepth { value: m.smoothed_value, last_slot: m.smoothed_last_slot };
        let depth = sd.update(m.pool_value as u128, now, m.smooth_window);

        let is_deep = depth >= m.d_mid as u128;
        let tier = if is_deep { &hm::DEEP } else { &hm::SHALLOW };
        let (k_min, k_max) = hm::k_bounds_const(is_deep);
        let k = hm::k_of_depth(depth, m.d_low as u128, m.d_high as u128, k_min, k_max);

        // solvency-derived max bet at this snapshot; wager must not exceed it.
        let max_bet = hm::max_bet(depth, m.max_exposure_bp as u128, tier, k);
        require!((wager as u128) <= max_bet, HouseError::BetExceedsMax);

        // worst case = JACKPOT^3 at the snapshot k/tier; this is what we escrow.
        let max_payout_u128 = hm::spin_payout(wager as u128, tier, k, JACKPOT_SYMBOLS);
        let max_payout = u64::try_from(max_payout_u128).map_err(|_| HouseError::MathOverflow)?;

        // verify the randomness account is freshly committed and snapshot its
        // seed_slot; settle later requires the same account + seed_slot. Done
        // before moving money so a stale/foreign randomness account fails fast.
        let seed_slot = commit_seed_slot(&ctx.accounts.randomness, now)?;

        // escrow the wager into the vault (player signs).
        invoke(
            &system_instruction::transfer(&ctx.accounts.player.key(), &ctx.accounts.machine.key(), wager),
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.machine.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let m = &mut ctx.accounts.machine;
        // persist the smoothing advance (one update per touching instruction).
        m.smoothed_value = sd.value;
        m.smoothed_last_slot = sd.last_slot;
        m.reserved_exposure = m.reserved_exposure.checked_add(max_payout).ok_or(HouseError::MathOverflow)?;
        // NB: pool_value is intentionally NOT credited here — the wager is only
        // absorbed into pool depth at settle, as net edge (HOUSE-SPEC §4.2).

        let s = &mut ctx.accounts.pending_spin;
        s.machine = ctx.accounts.machine.key();
        s.player = ctx.accounts.player.key();
        s.nonce = nonce;
        s.wager = wager;
        s.k_bp = k;
        s.tier_is_deep = is_deep;
        s.max_payout = max_payout;
        s.randomness = ctx.accounts.randomness.key();
        s.rand_seed_slot = seed_slot;
        s.commit_slot = now;
        s.bump = ctx.bumps.pending_spin;
        Ok(())
    }

    /// Settle a committed spin (HOUSE-SPEC §4.2). Permissionless: anyone cranks.
    /// Reads the revealed randomness through the seam, maps to reels, evaluates
    /// the SNAPSHOT tier/k (never current state), pays the player, releases the
    /// reserve, and folds the net edge into pool_value. Closes the spin, rent
    /// to the player.
    pub fn spin_settle(ctx: Context<SpinSettle>, nonce: u64) -> Result<()> {
        let _ = nonce; // bound in the Accounts seeds; unused in the handler body
        let s = &ctx.accounts.pending_spin;

        // read the revealed randomness through the seam: the account must match
        // the snapshot key AND seed_slot, and (Switchboard) the reveal must have
        // landed this slot. Snapshot k/tier below are still used to price it.
        let now = Clock::get()?.slot;
        let bytes = revealed_bytes(&ctx.accounts.randomness, s.randomness, s.rand_seed_slot, now)?;
        let reels = hm::reels_from_randomness(&bytes);

        let tier = if s.tier_is_deep { &hm::DEEP } else { &hm::SHALLOW };
        // SNAPSHOT k/tier — frozen at commit, immune to pool changes since.
        let payout_u128 = hm::spin_payout(s.wager as u128, tier, s.k_bp, reels);
        let payout = u64::try_from(payout_u128).map_err(|_| HouseError::MathOverflow)?;
        // the snapshot reserved JACKPOT^3 (the max outcome); nothing can exceed it.
        require!(payout <= s.max_payout, HouseError::MathOverflow);

        let wager = s.wager;
        let max_payout = s.max_payout;

        // pay the player from the vault (direct-debit lamport pattern).
        if payout > 0 {
            debit_credit(&ctx.accounts.machine.to_account_info(), &ctx.accounts.player, payout)?;
        }

        let m = &mut ctx.accounts.machine;
        // release the escrow.
        m.reserved_exposure = m.reserved_exposure.checked_sub(max_payout).ok_or(HouseError::MathOverflow)?;
        // fold net edge (wager - payout) into pool depth; on a win this is
        // negative and the pool pays it from LP capital. Signed to stay exact.
        let new_pool = (m.pool_value as i128) + (wager as i128) - (payout as i128);
        require!(new_pool >= 0, HouseError::InsolventSettlement);
        m.pool_value = new_pool as u64;
        Ok(())
    }

    /// Expire a spin whose randomness never resolved (HOUSE-SPEC §4.3).
    /// Permissionless after EXPIRE_SLOTS: refund the wager, release the reserve,
    /// close. No outcome, no edge taken; pool_value is untouched.
    pub fn spin_expire(ctx: Context<SpinExpire>, nonce: u64) -> Result<()> {
        let _ = nonce; // bound in the Accounts seeds; unused in the handler body
        let s = &ctx.accounts.pending_spin;
        let now = Clock::get()?.slot;
        require!(now.saturating_sub(s.commit_slot) > EXPIRE_SLOTS, HouseError::SpinNotExpired);

        let wager = s.wager;
        let max_payout = s.max_payout;

        // refund the escrowed wager to the player.
        debit_credit(&ctx.accounts.machine.to_account_info(), &ctx.accounts.player, wager)?;

        let m = &mut ctx.accounts.machine;
        m.reserved_exposure = m.reserved_exposure.checked_sub(max_payout).ok_or(HouseError::MathOverflow)?;
        Ok(())
    }

    // ===================== DUAL-ASSET MACHINES (H6b-1) =====================
    // SOL wagers in, SPL-token payouts out. A separate DualMachine account type
    // (see its doc-comment for the live-account-compatibility justification), a
    // token vault owned by the machine PDA, a price snapshot behind the mock/clmm
    // price seam with staleness + band gates, and a haircut-reserved token escrow.
    // The randomness seam and ALL math (via house-math) are shared with H1.

    /// Admin-gated dual-asset machine creation. Validates the margin-floor
    /// invariant via house-math (`validate_dual_params`) so no accepted config
    /// can cross the floor under the band gate, records the price-source
    /// addresses (parsed in H6b-3), and creates the machine's token vault ATA.
    #[allow(clippy::too_many_arguments)]
    pub fn create_machine_dual(
        ctx: Context<CreateMachineDual>,
        machine_id: [u8; 16],
        params: DualParams,
        curator: Pubkey,
    ) -> Result<()> {
        let p = &params;
        require!(0 < p.d_low && p.d_low < p.d_mid && p.d_mid < p.d_high, HouseError::InvalidParams);
        require!(p.max_exposure_bp > 0 && p.max_exposure_bp <= hm::BP as u64, HouseError::InvalidParams);
        require!(p.smooth_window > 0 && p.epoch_length > 0, HouseError::InvalidParams);
        require!(p.token_decimals <= 18, HouseError::InvalidParams);
        require!(p.twap_window_secs > 0 && p.max_staleness_secs > 0, HouseError::InvalidParams);
        // SCALE.md §5 guard: the Raydium observation ring is 100 wide and writes at
        // most one observation per 15s, so it covers at most 99×15 = 1485s of history.
        // A twap_window beyond that can be starved on a BUSY pool (coverage < window →
        // cold-start refusals), so reject it at creation. The demo's 300s is unaffected.
        require!(p.twap_window_secs <= hm::twap::RING_MIN_COVERAGE_SECS, HouseError::TwapWindowExceedsRingCoverage);
        require!(p.max_pending_spins > 0, HouseError::InvalidParams);
        require!(p.haircut_bp as u128 <= hm::BP, HouseError::InvalidParams);
        // The solvency link: reject any RTP-ceiling / band / margin-floor combo
        // that could cross the floor (spec §3–4). This is where the H6a
        // margin.rs invariant becomes an on-chain gate.
        require!(
            hm::margin::validate_dual_params(p.rtp_max_bp as u128, p.band_bp as u128, p.m_bp as u128),
            HouseError::MarginFloorViolation
        );

        let now = Clock::get()?.slot;
        let m = &mut ctx.accounts.machine;
        m.machine_id = machine_id;
        m.curator = curator;
        m.token_mint = ctx.accounts.token_mint.key();
        m.pool = p.pool;
        m.observation = p.observation;
        m.token_vault = ctx.accounts.token_vault.key();
        m.token_decimals = p.token_decimals;
        m.d_low = p.d_low;
        m.d_mid = p.d_mid;
        m.d_high = p.d_high;
        m.max_exposure_bp = p.max_exposure_bp;
        m.smooth_window = p.smooth_window;
        m.epoch_length = p.epoch_length;
        m.twap_window_secs = p.twap_window_secs;
        m.max_staleness_secs = p.max_staleness_secs;
        m.band_bp = p.band_bp;
        m.m_bp = p.m_bp;
        m.haircut_bp = p.haircut_bp;
        m.rtp_max_bp = p.rtp_max_bp;
        m.max_pending_spins = p.max_pending_spins;
        m.pending_spins = 0;
        m.token_balance = 0;
        m.reserved_tokens = 0;
        m.escrowed_sol = 0;
        m.div_pool_sol = 0;
        m.acc_sol_per_share = 0;
        m.earmarked_sol = 0;
        m.total_shares = 0;
        m.smoothed_value = 0; // cold until the first spin (first time a TWAP is read)
        m.smoothed_last_slot = now;
        m.paused = false;
        m.bump = ctx.bumps.machine;
        m.reserved = [0u8; DualMachine::RESERVED_LEN];
        Ok(())
    }

    /// Token deposit (spec §5) — PRICE-FREE by design. Shares are minted pro-rata
    /// on the TOKEN side only (`mint = amount × total_shares / token_balance`,
    /// first deposit 1:1 at 1e6 scale); no TWAP is read. This is the locked
    /// decision, and it is strictly SAFER than value-pricing: pricing the deposit
    /// would let an attacker inflate the TWAP at deposit to mint excess shares
    /// (the deposit-timing game of threat model §6). The SOL side is made correct
    /// WITHOUT a price by the dividend ledger — `sol_debt` is set so these shares
    /// are entitled to ZERO of any prior accrual (no dilution). `spin_commit` is
    /// the only price-touching instruction. See the H6b-2 report / spec §5 note.
    pub fn lp_deposit_token(ctx: Context<LpDepositToken>, amount: u64) -> Result<()> {
        require!(amount > 0, HouseError::InvalidWager);
        let m = &ctx.accounts.machine;
        let first = m.total_shares == 0;
        let shares: u128 = if first {
            (amount as u128).checked_mul(SHARE_SCALE).ok_or(HouseError::MathOverflow)?
        } else {
            require!(m.token_balance > 0, HouseError::MathOverflow);
            (amount as u128)
                .checked_mul(m.total_shares).ok_or(HouseError::MathOverflow)?
                .checked_div(m.token_balance).ok_or(HouseError::MathOverflow)?
        };
        require!(shares > 0, HouseError::DepositTooSmall);

        // The position's dividend entitlement up to now must be preserved across
        // the share change (a fresh position has pending 0 → no-dilution). Earning
        // shares are shares + pending_shares (queued withdrawals keep earning).
        let pos = &ctx.accounts.position;
        let earning_before = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        let pending_before = hm::dividend::pending_sol(earning_before, pos.sol_debt, m.acc_sol_per_share);

        // owner ATA -> vault, authority = owner.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.owner_token_account.to_account_info(),
                    to: ctx.accounts.token_vault.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        let acc = ctx.accounts.machine.acc_sol_per_share;
        let m = &mut ctx.accounts.machine;
        m.token_balance = m.token_balance.checked_add(amount as u128).ok_or(HouseError::MathOverflow)?;
        m.total_shares = m.total_shares.checked_add(shares).ok_or(HouseError::MathOverflow)?;

        let pos = &mut ctx.accounts.position;
        pos.machine = ctx.accounts.machine.key();
        pos.owner = ctx.accounts.owner.key();
        pos.shares = pos.shares.checked_add(shares).ok_or(HouseError::MathOverflow)?;
        // sol_debt = entitlement(new_earning_shares) − pending_before, so old
        // pending is preserved and the new shares earn from now on only (proof
        // `debt_preserving_pending`).
        let earning_after = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        pos.sol_debt = hm::dividend::debt_preserving_pending(earning_after, acc, pending_before);
        pos.bump = ctx.bumps.position;
        Ok(())
    }

    /// Commit a dual-asset spin (spec §3). Gates paused / staleness / band /
    /// pending-spin cap, snapshots `price_at_commit = TWAP`, freezes k/tier from
    /// the SMOOTHED token-side VALUE depth, enforces BOTH the value-curve max_bet
    /// and the token-solvency bound (max_payout × (1+haircut) ≤ exposure × token
    /// balance), escrows the SOL wager and reserves the token payout+haircut.
    pub fn spin_commit_dual(ctx: Context<SpinCommitDual>, wager: u64, nonce: u64) -> Result<()> {
        let m = &ctx.accounts.machine;
        require!(!m.paused, HouseError::MachinePaused);
        require!(wager > 0, HouseError::InvalidWager);
        require!(m.pending_spins < m.max_pending_spins, HouseError::TooManyPendingSpins);

        // --- price seam + shared gates (spec §2–3) ---
        let clock = Clock::get()?;
        let now_secs = clock.unix_timestamp.max(0) as u32; // matches CLMM observation stamps
        let reading = read_price(
            &ctx.accounts.price_pool, &ctx.accounts.price_observation, m.pool, m.observation,
            now_secs, m.twap_window_secs,
        )?;
        eval_price_gates(&reading, m.max_staleness_secs, m.band_bp)?;
        let twap = reading.twap_1e12;
        let dec = m.token_decimals;

        let now = clock.slot;

        // Curve depth is TOKEN-SIDE ONLY: D = token_balance valued at TWAP. The
        // accrued SOL (div_pool_sol) is LP dividend income, NOT at-risk capital —
        // payouts are token-only, so accrued SOL can never back a payout and must
        // never inflate max_bet (H6b-2 refinement of spec §4).
        let d_now = hm::payout::payout_value_lamports(m.token_balance, twap, dec);

        // SmoothedDepth on the token-side value; cold-start seeds to D_now at the
        // first spin (the first moment a TWAP exists to value the token side).
        let mut sd = if m.smoothed_value == 0 {
            hm::SmoothedDepth::new(d_now, now)
        } else {
            hm::SmoothedDepth { value: m.smoothed_value, last_slot: m.smoothed_last_slot }
        };
        let depth = sd.update(d_now, now, m.smooth_window);

        let is_deep = depth >= m.d_mid as u128;
        let tier = if is_deep { &hm::DEEP } else { &hm::SHALLOW };
        let num = if is_deep { hm::DEEP_NUM } else { hm::SHALLOW_NUM };
        // dual k-bounds respect the machine's validated RTP ceiling (spec §4).
        let (k_min, k_max) = hm::k_bounds_dual(num, m.rtp_max_bp as u128);
        let k = hm::k_of_depth(depth, m.d_low as u128, m.d_high as u128, k_min, k_max);

        // constraint 1: value-curve max_bet (lamports).
        let value_max_bet = hm::max_bet(depth, m.max_exposure_bp as u128, tier, k);
        require!((wager as u128) <= value_max_bet, HouseError::BetExceedsMax);

        // constraint 2: token-solvency (payouts are tokens) — the binding one wins.
        let max_payout = hm::payout::max_payout_tokens(wager as u128, tier, k, twap, dec)
            .ok_or(HouseError::MathOverflow)?;
        let reserve = hm::payout::reserve_with_haircut(max_payout, m.haircut_bp as u128)
            .ok_or(HouseError::MathOverflow)?;
        let token_cap = (m.token_balance)
            .checked_mul(m.max_exposure_bp as u128).ok_or(HouseError::MathOverflow)? / hm::BP;
        require!(reserve <= token_cap, HouseError::BetExceedsMax);
        // and the reserve must fit within the currently-free token balance.
        let free_tokens = m.token_balance.checked_sub(m.reserved_tokens).ok_or(HouseError::MathOverflow)?;
        require!(reserve <= free_tokens, HouseError::InsufficientTokenLiquidity);

        // randomness commit (shared seam), then escrow the SOL wager.
        let seed_slot = commit_seed_slot(&ctx.accounts.randomness, now)?;
        invoke(
            &system_instruction::transfer(&ctx.accounts.player.key(), &ctx.accounts.machine.key(), wager),
            &[
                ctx.accounts.player.to_account_info(),
                ctx.accounts.machine.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;

        let m = &mut ctx.accounts.machine;
        m.smoothed_value = sd.value;
        m.smoothed_last_slot = sd.last_slot;
        m.reserved_tokens = m.reserved_tokens.checked_add(reserve).ok_or(HouseError::MathOverflow)?;
        m.escrowed_sol = m.escrowed_sol.checked_add(wager).ok_or(HouseError::MathOverflow)?;
        m.pending_spins += 1;

        let s = &mut ctx.accounts.pending_spin;
        s.machine = ctx.accounts.machine.key();
        s.player = ctx.accounts.player.key();
        s.nonce = nonce;
        s.wager = wager;
        s.k_bp = k;
        s.tier_is_deep = is_deep;
        s.price_at_commit_1e12 = twap;
        s.max_payout_tokens = max_payout;
        s.reserved_tokens = reserve;
        s.randomness = ctx.accounts.randomness.key();
        s.rand_seed_slot = seed_slot;
        s.commit_slot = now;
        s.bump = ctx.bumps.pending_spin;
        Ok(())
    }

    /// Settle a dual-asset spin (spec §3). Permissionless. Reads randomness via
    /// the seam, prices the outcome at the SNAPSHOT price (never current), pays
    /// tokens from the vault by CPI (signed by the machine PDA), releases the
    /// token reserve, and accrues the full SOL wager into the per-share dividend
    /// ledger (`acc_sol_per_share` + `div_pool_sol`) for the LPs (H6b-2).
    pub fn spin_settle_dual(ctx: Context<SpinSettleDual>, nonce: u64) -> Result<()> {
        let _ = nonce;
        let s = &ctx.accounts.pending_spin;
        let now = Clock::get()?.slot;
        let bytes = revealed_bytes(&ctx.accounts.randomness, s.randomness, s.rand_seed_slot, now)?;
        let reels = hm::reels_from_randomness(&bytes);

        let tier = if s.tier_is_deep { &hm::DEEP } else { &hm::SHALLOW };
        let m = &ctx.accounts.machine;
        // payout in tokens at the COMMITTED price (FX snapshot discipline).
        let payout = hm::payout::spin_payout_tokens(
            s.wager as u128, tier, s.k_bp, reels, s.price_at_commit_1e12, m.token_decimals,
        ).ok_or(HouseError::MathOverflow)?;
        require!(payout <= s.max_payout_tokens, HouseError::MathOverflow);
        let payout_u64 = u64::try_from(payout).map_err(|_| HouseError::MathOverflow)?;

        let wager = s.wager;
        let reserve = s.reserved_tokens;

        // pay tokens from the vault, signed by the machine PDA.
        if payout_u64 > 0 {
            let id = m.machine_id;
            let bump = [m.bump];
            let seeds: &[&[u8]] = &[b"dual-machine", id.as_ref(), &bump];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.token_vault.to_account_info(),
                        to: ctx.accounts.player_token_account.to_account_info(),
                        authority: ctx.accounts.machine.to_account_info(),
                    },
                    &[seeds],
                ),
                payout_u64,
            )?;
        }

        let m = &mut ctx.accounts.machine;
        m.reserved_tokens = m.reserved_tokens.checked_sub(reserve).ok_or(HouseError::MathOverflow)?;
        m.token_balance = m.token_balance.checked_sub(payout).ok_or(HouseError::MathOverflow)?;
        // The whole wager is house SOL income (payouts are token-only, so SOL
        // never leaves): route it into the dividend ledger. On a win the token
        // vault took the hit; on a loss it didn't — either way 100% of the wager
        // is LP yield (H6b-2). Accrue it to the per-share index and hold it in
        // div_pool_sol. total_shares > 0 here (token_balance > 0 ⇒ a deposit
        // minted shares); if somehow 0, it falls through as pool dust.
        m.escrowed_sol = m.escrowed_sol.checked_sub(wager).ok_or(HouseError::MathOverflow)?;
        m.acc_sol_per_share = hm::dividend::accrue(m.acc_sol_per_share, m.total_shares, wager as u128);
        m.div_pool_sol = m.div_pool_sol.checked_add(wager).ok_or(HouseError::MathOverflow)?;
        m.pending_spins = m.pending_spins.checked_sub(1).ok_or(HouseError::MathOverflow)?;
        Ok(())
    }

    /// Expire a dual-asset spin whose randomness never resolved (spec §3, §4.3
    /// analog): refund the SOL wager, release the token reserve, close.
    pub fn spin_expire_dual(ctx: Context<SpinExpireDual>, nonce: u64) -> Result<()> {
        let _ = nonce;
        let s = &ctx.accounts.pending_spin;
        let now = Clock::get()?.slot;
        require!(now.saturating_sub(s.commit_slot) > EXPIRE_SLOTS, HouseError::SpinNotExpired);
        let wager = s.wager;
        let reserve = s.reserved_tokens;

        debit_credit(&ctx.accounts.machine.to_account_info(), &ctx.accounts.player, wager)?;

        let m = &mut ctx.accounts.machine;
        m.reserved_tokens = m.reserved_tokens.checked_sub(reserve).ok_or(HouseError::MathOverflow)?;
        m.escrowed_sol = m.escrowed_sol.checked_sub(wager).ok_or(HouseError::MathOverflow)?;
        m.pending_spins = m.pending_spins.checked_sub(1).ok_or(HouseError::MathOverflow)?;
        Ok(())
    }

    // ---------- dual-asset LP dividend ledger (H6b-2) ----------

    /// Claim accrued SOL dividends (SOL reward mode). Permissioned to the owner,
    /// callable anytime. Pays `min(pending, div_pool_sol)` — the pool cap is what
    /// keeps the books exact (house-math `dividend` conservation) — and lifts
    /// `sol_debt` by exactly what was paid. Claiming again with no new accrual
    /// pays 0.
    pub fn claim_sol(ctx: Context<ClaimDividend>) -> Result<()> {
        let m = &ctx.accounts.machine;
        let pos = &ctx.accounts.position;
        require!(pos.reward_mode == REWARD_MODE_SOL, HouseError::WrongRewardMode);
        let earning = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        let pending = hm::dividend::pending_sol(earning, pos.sol_debt, m.acc_sol_per_share);
        let paid = pending.min(m.div_pool_sol as u128);
        let paid_u64 = u64::try_from(paid).map_err(|_| HouseError::MathOverflow)?;
        if paid_u64 > 0 {
            let new_debt = pos.sol_debt.checked_add(paid).ok_or(HouseError::MathOverflow)?;
            debit_credit(&ctx.accounts.machine.to_account_info(), &ctx.accounts.owner.to_account_info(), paid_u64)?;
            ctx.accounts.machine.div_pool_sol -= paid_u64;
            ctx.accounts.position.sol_debt = new_debt;
        }
        Ok(())
    }

    /// Earmark accrued SOL dividends (SPL reward mode). No SOL leaves the machine:
    /// the pending is moved from `div_pool_sol` into `earmarked_sol` (machine and
    /// position), reserved for a swap-to-token in H6b-3. Earmarked SOL is excluded
    /// from dividends, house capital, and everyone else's withdrawals.
    pub fn earmark_sol(ctx: Context<ClaimDividend>) -> Result<()> {
        let m = &ctx.accounts.machine;
        let pos = &ctx.accounts.position;
        require!(pos.reward_mode == REWARD_MODE_SPL, HouseError::WrongRewardMode);
        let earning = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        let pending = hm::dividend::pending_sol(earning, pos.sol_debt, m.acc_sol_per_share);
        let moved = pending.min(m.div_pool_sol as u128);
        let moved_u64 = u64::try_from(moved).map_err(|_| HouseError::MathOverflow)?;
        if moved_u64 > 0 {
            let new_debt = pos.sol_debt.checked_add(moved).ok_or(HouseError::MathOverflow)?;
            let m = &mut ctx.accounts.machine;
            m.div_pool_sol -= moved_u64;
            m.earmarked_sol = m.earmarked_sol.checked_add(moved_u64).ok_or(HouseError::MathOverflow)?;
            let pos = &mut ctx.accounts.position;
            pos.sol_debt = new_debt;
            pos.earmarked_sol = pos.earmarked_sol.checked_add(moved_u64).ok_or(HouseError::MathOverflow)?;
        }
        Ok(())
    }

    /// Switch a position's reward mode. Realizes the current pending in the OLD
    /// mode first (pays if SOL, earmarks if SPL), so the switch never strands or
    /// re-buckets already-earned dividends, then flips the mode.
    pub fn set_reward_mode(ctx: Context<ClaimDividend>, mode: u8) -> Result<()> {
        require!(mode == REWARD_MODE_SOL || mode == REWARD_MODE_SPL, HouseError::InvalidParams);
        let m = &ctx.accounts.machine;
        let pos = &ctx.accounts.position;
        let old_mode = pos.reward_mode;
        let earning = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        let pending = hm::dividend::pending_sol(earning, pos.sol_debt, m.acc_sol_per_share);
        let realized = pending.min(m.div_pool_sol as u128);
        let realized_u64 = u64::try_from(realized).map_err(|_| HouseError::MathOverflow)?;
        let new_debt = pos.sol_debt.checked_add(realized).ok_or(HouseError::MathOverflow)?;
        if realized_u64 > 0 && old_mode == REWARD_MODE_SOL {
            debit_credit(&ctx.accounts.machine.to_account_info(), &ctx.accounts.owner.to_account_info(), realized_u64)?;
        }
        let m = &mut ctx.accounts.machine;
        if realized_u64 > 0 {
            m.div_pool_sol -= realized_u64;
            if old_mode == REWARD_MODE_SPL { m.earmarked_sol = m.earmarked_sol.checked_add(realized_u64).ok_or(HouseError::MathOverflow)?; }
        }
        let pos = &mut ctx.accounts.position;
        pos.sol_debt = new_debt;
        if realized_u64 > 0 && old_mode == REWARD_MODE_SPL { pos.earmarked_sol = pos.earmarked_sol.checked_add(realized_u64).ok_or(HouseError::MathOverflow)?; }
        pos.reward_mode = mode;
        Ok(())
    }

    // ---------- dual-asset withdrawals (H3 pattern, both assets, price-free) ----------

    /// Queue `shares` for epoch-gated withdrawal (spec §5). Shares move from
    /// active to pending; they KEEP earning dividends until processed (the
    /// position's earning total, shares + pending_shares, is unchanged, so the
    /// SOL ledger is untouched). Requesting again re-stamps the epoch.
    pub fn request_withdraw_token(ctx: Context<RequestWithdrawToken>, shares: u128) -> Result<()> {
        require!(shares > 0, HouseError::InvalidWithdrawAmount);
        let now = Clock::get()?.slot;
        let epoch = ctx.accounts.machine.epoch_of(now);
        let pos = &mut ctx.accounts.position;
        require!(pos.shares >= shares, HouseError::InsufficientShares);
        pos.shares -= shares;
        pos.pending_shares = pos.pending_shares.checked_add(shares).ok_or(HouseError::MathOverflow)?;
        pos.pending_epoch = epoch;
        Ok(())
    }

    /// Cancel a pending withdrawal, restoring the shares to active (spec §5).
    pub fn cancel_withdraw_token(ctx: Context<CancelWithdrawToken>) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.pending_shares > 0, HouseError::NothingToWithdraw);
        pos.shares = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        pos.pending_shares = 0;
        pos.pending_epoch = 0;
        Ok(())
    }

    /// Permissionless epoch crank (spec §5): process ONE position's pending
    /// request once its epoch has elapsed, paying pro-rata of BOTH assets, ENTIRELY
    /// PRICE-FREE. Harvests the position's accrued SOL dividend (pay in SOL mode,
    /// earmark in SPL mode) and pays `fill/total_shares` of the token vault. The
    /// token fill is capped by the free (unreserved) token balance so pending
    /// spins stay funded; any remainder stays queued (partial fill). No price is
    /// read — the withdrawal path is manipulation-immune.
    pub fn process_withdrawal_token(ctx: Context<ProcessWithdrawalToken>) -> Result<()> {
        let now = Clock::get()?.slot;
        let m = &ctx.accounts.machine;
        let pos = &ctx.accounts.position;
        let pending_sh = pos.pending_shares;
        require!(pending_sh > 0, HouseError::NothingToWithdraw);
        require!(m.epoch_of(now) > pos.pending_epoch, HouseError::EpochNotElapsed);
        require!(m.total_shares > 0 && m.token_balance > 0, HouseError::MathOverflow);

        // SOL dividend harvest (the whole position's pending, per reward mode).
        let acc = m.acc_sol_per_share;
        let earning = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        let pending_div = hm::dividend::pending_sol(earning, pos.sol_debt, acc);
        let sol_realized = pending_div.min(m.div_pool_sol as u128);
        let sol_realized_u64 = u64::try_from(sol_realized).map_err(|_| HouseError::MathOverflow)?;
        let reward_mode = pos.reward_mode;

        // SCALE-2: token side is PRICE-FREE (no TWAP) but was still pro-rata of the
        // token balance AT PROCESSING, so a token jackpot settling mid-drain moved
        // tokens between identical requests by order (SCALE.md §1b, dual). Fix: freeze
        // a CONSERVATIVE token-per-share snapshot at the epoch's first crank —
        // free_value = token_balance − reserved_tokens (as if every pending spin pays
        // its full reserve) — and pay every crank that epoch at it. The SOL dividend
        // side is already order-independent (per-share ledger), so only the token side
        // needs this. free cap limits HOW MUCH, never the PRICE.
        let epoch = m.epoch_of(now);
        let free_tokens = m.free_tokens();
        let snap_price = if m.withdraw_snapshot_epoch == epoch && m.withdraw_snapshot_price != 0 {
            m.withdraw_snapshot_price
        } else {
            hm::snapshot::snapshot_price(free_tokens, m.total_shares)
        };
        let fill = hm::snapshot::fill_shares(pending_sh, free_tokens, snap_price);
        let token_payout = hm::snapshot::payout(fill, snap_price);
        let token_payout_u64 = u64::try_from(token_payout).map_err(|_| HouseError::MathOverflow)?;

        // ----- money movement -----
        // token side FIRST: vault -> owner ATA, signed by the machine PDA. The SOL
        // dividend payout is machine-PDA lamport surgery, and a surgery interleaved
        // BEFORE this CPI would trip the runtime's per-CPI subset balance check
        // (the H6c-1 compound_epoch gotcha). So the SOL debit is deferred to the
        // LAST lamport op (below), leaving the only balance check at instruction
        // return — exactly the pattern amm_swap_sol_to_token documents.
        if token_payout_u64 > 0 {
            let id = m.machine_id;
            let bump = [m.bump];
            let seeds: &[&[u8]] = &[b"dual-machine", id.as_ref(), &bump];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    Transfer {
                        from: ctx.accounts.token_vault.to_account_info(),
                        to: ctx.accounts.owner_token_account.to_account_info(),
                        authority: ctx.accounts.machine.to_account_info(),
                    },
                    &[seeds],
                ),
                token_payout_u64,
            )?;
        }

        // ----- accounting -----
        let m = &mut ctx.accounts.machine;
        // freeze the token snapshot for the epoch (first meaningful crank stores it).
        m.withdraw_snapshot_price = snap_price;
        m.withdraw_snapshot_epoch = epoch;
        m.div_pool_sol = m.div_pool_sol.checked_sub(sol_realized_u64).ok_or(HouseError::MathOverflow)?;
        if reward_mode == REWARD_MODE_SPL {
            m.earmarked_sol = m.earmarked_sol.checked_add(sol_realized_u64).ok_or(HouseError::MathOverflow)?;
        }
        m.total_shares = m.total_shares.checked_sub(fill).ok_or(HouseError::MathOverflow)?;
        m.token_balance = m.token_balance.checked_sub(token_payout).ok_or(HouseError::MathOverflow)?;

        let pos = &mut ctx.accounts.position;
        if reward_mode == REWARD_MODE_SPL {
            pos.earmarked_sol = pos.earmarked_sol.checked_add(sol_realized_u64).ok_or(HouseError::MathOverflow)?;
        }
        pos.pending_shares = pos.pending_shares.checked_sub(fill).ok_or(HouseError::MathOverflow)?;
        // reset dividend debt to the remaining earning shares (harvested → pending 0).
        let remaining = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        pos.sol_debt = hm::dividend::sol_entitlement(remaining, acc);

        // ----- SOL side, LAST: pay the owner (SOL mode); SPL mode earmarked above.
        // Deferred to here so all lamport surgery follows the token CPI — the only
        // runtime balance check is now at instruction return (this debit + the
        // close primitive below), never across the CPI. Amount and condition are
        // unchanged from before the reorder; the accounting above already reflects it.
        if sol_realized_u64 > 0 && reward_mode == REWARD_MODE_SOL {
            debit_credit(&ctx.accounts.machine.to_account_info(), &ctx.accounts.owner.to_account_info(), sol_realized_u64)?;
        }

        // fully-emptied position with no earmark closes; rent to owner.
        if ctx.accounts.position.shares == 0 && ctx.accounts.position.pending_shares == 0 && ctx.accounts.position.earmarked_sol == 0 {
            ctx.accounts.position.close(ctx.accounts.owner.to_account_info())?;
        }
        Ok(())
    }

    /// Compound an SPL-mode position's earmarked SOL back into token shares
    /// (spec §5) — the module's ONLY AMM CPI. Permissionless epoch crank: reads
    /// the price behind the SAME band gate as a spin, and only if spot is within
    /// `band_bp` of the TWAP does it swap the earmarked SOL into token (ONE swap,
    /// min_out = value at TWAP × (1 − band)), deposit the tokens into the vault,
    /// and mint shares at the PRE-swap price (house-math `compound_mint_shares`,
    /// proven non-dilutive). If the band is exceeded / price stale, it NO-OPs and
    /// succeeds — it never force-fills. sol_debt is reset so the minted shares owe
    /// 0 of prior SOL accruals. Per-position, one compound per epoch.
    ///
    /// The swap is behind the `amm_swap_sol_to_token` seam: mock fill (LiteSVM)
    /// vs the real Raydium CLMM swap CPI; the crank passes the swap accounts as
    /// remaining_accounts (Raydium tick arrays / the mock counterparty).
    pub fn compound_epoch<'info>(ctx: Context<'info, CompoundEpoch<'info>>) -> Result<()> {
        let m = &ctx.accounts.machine;
        let pos = &ctx.accounts.position;
        require!(pos.reward_mode == REWARD_MODE_SPL, HouseError::WrongRewardMode);
        let amount = pos.earmarked_sol;
        if amount == 0 {
            return Ok(()); // nothing earmarked — noop success
        }
        let clock = Clock::get()?;
        let epoch = m.epoch_of(clock.slot);
        require!(epoch > pos.last_compound_epoch, HouseError::EpochNotElapsed);

        // read price through the SAME seam + band as a spin. If not tradeable
        // (stale or out of band), NO-OP: never force a fill (spec §5).
        let now_secs = clock.unix_timestamp.max(0) as u32;
        let reading = read_price(
            &ctx.accounts.price_pool, &ctx.accounts.price_observation, m.pool, m.observation,
            now_secs, m.twap_window_secs,
        )?;
        if eval_price_gates(&reading, m.max_staleness_secs, m.band_bp).is_err() {
            return Ok(()); // wait for a calmer/fresher price — succeed as a noop
        }
        let twap = reading.twap_1e12;
        let spot = reading.spot_1e12;
        let dec = m.token_decimals;

        // min_out = value of `amount` SOL at TWAP, haircut by the band.
        let value_at_twap = hm::payout::payout_tokens(amount as u128, hm::BP, hm::BP, twap, dec)
            .ok_or(HouseError::MathOverflow)?;
        let min_out = value_at_twap
            .checked_mul(hm::BP - m.band_bp as u128).ok_or(HouseError::MathOverflow)? / hm::BP;
        let min_out_u64 = u64::try_from(min_out).map_err(|_| HouseError::MathOverflow)?;

        // pre-swap snapshot: the share price the minted shares are priced at.
        let pre_total_shares = m.total_shares;
        let pre_token_balance = m.token_balance;
        let acc = m.acc_sol_per_share;
        let earning_before = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        let pending_before = hm::dividend::pending_sol(earning_before, pos.sol_debt, acc);
        let machine_id = m.machine_id;
        let bump = m.bump;
        // HARDEN-1 (B1): the swap must execute against the machine's OWN pool, so the
        // swap pool == the pool we priced min_out off of — not merely a pool bounded by
        // min_out. Pass the stored pool/observation for the real path to pin by key.
        let expected_pool = m.pool;
        let expected_observation = m.observation;

        // THE swap (seam). Moves `amount` SOL out of the machine and `received`
        // tokens into the vault.
        let received = amm_swap_sol_to_token(
            ctx.accounts.machine.to_account_info(),
            &machine_id, bump,
            ctx.accounts.token_vault.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            ctx.remaining_accounts,
            amount, min_out_u64, spot, dec,
            expected_pool, expected_observation,
        )?;
        require!(received >= min_out_u64, HouseError::PriceUnstable); // slippage guard

        let minted = hm::dividend::compound_mint_shares(received as u128, pre_total_shares, pre_token_balance);

        let m = &mut ctx.accounts.machine;
        m.token_balance = m.token_balance.checked_add(received as u128).ok_or(HouseError::MathOverflow)?;
        m.total_shares = m.total_shares.checked_add(minted).ok_or(HouseError::MathOverflow)?;
        m.earmarked_sol = m.earmarked_sol.checked_sub(amount).ok_or(HouseError::MathOverflow)?;

        let pos = &mut ctx.accounts.position;
        pos.earmarked_sol = pos.earmarked_sol.checked_sub(amount).ok_or(HouseError::MathOverflow)?;
        pos.shares = pos.shares.checked_add(minted).ok_or(HouseError::MathOverflow)?;
        pos.last_compound_epoch = epoch;
        let earning_after = pos.shares.checked_add(pos.pending_shares).ok_or(HouseError::MathOverflow)?;
        pos.sol_debt = hm::dividend::debt_preserving_pending(earning_after, acc, pending_before);
        Ok(())
    }

    /// TEST-ONLY (mock-price feature): set the program-owned MockPrice account a
    /// dual spin reads through the price seam. ABSENT from the default build — a
    /// settable price is a mint-arbitrary-payout backdoor (spec §2 threat model).
    #[cfg(feature = "mock-price")]
    pub fn mock_set_price(ctx: Context<MockSetPrice>, id: [u8; 16], twap_1e12: u128, spot_1e12: u128, age_secs: u32) -> Result<()> {
        let _ = id;
        let p = &mut ctx.accounts.price;
        p.authority = ctx.accounts.authority.key();
        p.twap_1e12 = twap_1e12;
        p.spot_1e12 = spot_1e12;
        p.age_secs = age_secs;
        p.bump = ctx.bumps.price;
        Ok(())
    }

    /// TEST-ONLY (mock-randomness feature): fill a program-owned MockRandomness
    /// account with the 32 bytes a spin will settle against. ABSENT from the
    /// default build — its presence there would be a drain-everything backdoor.
    #[cfg(feature = "mock-randomness")]
    pub fn mock_fill_randomness(ctx: Context<MockFillRandomness>, id: [u8; 16], bytes: [u8; 32]) -> Result<()> {
        let _ = id; // bound in the Accounts seeds; unused in the handler body
        let r = &mut ctx.accounts.randomness;
        r.authority = ctx.accounts.authority.key();
        r.bytes = bytes;
        r.slot = Clock::get()?.slot;
        r.filled = true;
        r.bump = ctx.bumps.randomness;
        Ok(())
    }
}

// -------------------- randomness seam --------------------
//
// Two backends behind one boundary, selected at compile time:
//   * commit_seed_slot(account, slot) — verify the randomness at commit and
//     return the seed_slot to snapshot into PendingSpin;
//   * revealed_bytes(account, key, seed_slot, slot) — verify the SAME account
//     at settle (key + seed_slot must match the snapshot) and read the value.
// The default/deployable build is Switchboard On-Demand; the mock is compiled
// ONLY under `mock-randomness` (LiteSVM tests). The expiry path is backend-
// agnostic: a request that never reveals just falls through to spin_expire.

// ---- mock backend (feature = "mock-randomness") ----

/// Mock: nothing to verify at commit (the account may not even exist yet), and
/// there is no meaningful seed slot — snapshot 0; the mock reader ignores it.
#[cfg(feature = "mock-randomness")]
fn commit_seed_slot(_account: &AccountInfo, _clock_slot: u64) -> Result<u64> {
    Ok(0)
}

/// Mock: revealed bytes come from a program-owned MockRandomness account.
#[cfg(feature = "mock-randomness")]
fn revealed_bytes(
    account: &AccountInfo,
    expected_key: Pubkey,
    _expected_seed_slot: u64,
    _clock_slot: u64,
) -> Result<[u8; 32]> {
    require_keys_eq!(account.key(), expected_key, HouseError::InvalidRandomnessAccount);
    require_keys_eq!(*account.owner, crate::ID, HouseError::InvalidRandomnessAccount);
    let data = account.try_borrow_data()?;
    let r = MockRandomness::try_deserialize(&mut &data[..])
        .map_err(|_| HouseError::RandomnessNotResolved)?;
    require!(r.filled, HouseError::RandomnessNotResolved);
    Ok(r.bytes)
}

// ---- Switchboard On-Demand backend (default / deployable) ----
//
// devnet-only module (HOUSE-SPEC §Cluster), so the owner is pinned to the
// Switchboard devnet program id. is_devnet() in the crate is compile/env-gated
// and would resolve to mainnet on-chain, so we do NOT use the Owner trait.

/// Verify a freshly committed randomness account and return its seed_slot.
/// Per the Switchboard tutorial the commitment must have happened in the
/// immediately preceding slot (`seed_slot == clock_slot - 1`); bundling the
/// Switchboard commit ix in the same tx as spin_commit satisfies this.
#[cfg(not(feature = "mock-randomness"))]
fn commit_seed_slot(account: &AccountInfo, clock_slot: u64) -> Result<u64> {
    require!(
        account.owner.to_bytes() == ON_DEMAND_DEVNET_PID.to_bytes(),
        HouseError::InvalidRandomnessAccount
    );
    let data = account.try_borrow_data()?;
    let rand = RandomnessAccountData::parse(data).map_err(|_| HouseError::InvalidRandomnessAccount)?;
    let expected = clock_slot.checked_sub(1).ok_or(HouseError::RandomnessExpired)?;
    require!(rand.seed_slot == expected, HouseError::RandomnessExpired);
    Ok(rand.seed_slot)
}

/// Verify the settle-time randomness account matches the snapshot (key AND
/// seed_slot — a swapped or re-seeded account fails) and read the revealed
/// value. get_value requires the reveal to have landed this slot, so the
/// Switchboard reveal ix is bundled in the same tx as spin_settle; a spin that
/// never reveals is unreadable and routes to spin_expire.
#[cfg(not(feature = "mock-randomness"))]
fn revealed_bytes(
    account: &AccountInfo,
    expected_key: Pubkey,
    expected_seed_slot: u64,
    clock_slot: u64,
) -> Result<[u8; 32]> {
    require_keys_eq!(account.key(), expected_key, HouseError::InvalidRandomnessAccount);
    require!(
        account.owner.to_bytes() == ON_DEMAND_DEVNET_PID.to_bytes(),
        HouseError::InvalidRandomnessAccount
    );
    let data = account.try_borrow_data()?;
    let rand = RandomnessAccountData::parse(data).map_err(|_| HouseError::InvalidRandomnessAccount)?;
    // the account must be the very one committed against: same seed_slot.
    require!(rand.seed_slot == expected_seed_slot, HouseError::InvalidRandomnessAccount);
    rand.get_value(clock_slot).map_err(|_| HouseError::RandomnessNotResolved.into())
}

/// Direct-debit lamport move between two accounts (no CPI), matching the
/// arbiter's settlement style. The `from` account must be program-owned.
fn debit_credit<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, lamports: u64) -> Result<()> {
    **from.try_borrow_mut_lamports()? -= lamports;
    **to.try_borrow_mut_lamports()? += lamports;
    Ok(())
}

// -------------------- price seam (H6b-1) --------------------
//
// Mirrors the randomness seam: one narrow boundary, two implementations chosen
// at compile time. `read_price` returns ONLY a reading; ALL gate evaluation
// lives in `eval_price_gates` (shared), so H6b-3 swaps the CLMM reader in
// without touching a line of gate logic.
//   * mock-price feature ON  → reads a program-owned MockPrice account (LiteSVM
//     tests only; a settable price is a mint-arbitrary-payout backdoor).
//   * feature OFF (default/deployable) → the CLMM backend: verify the pool +
//     observation accounts, then (H6b-3) parse Raydium PoolState.sqrt_price and
//     ObservationState cumulative-tick TWAP with the pinned H6a layouts. Stubbed
//     to `PriceNotImplemented` until then.

/// Raydium CLMM program id on devnet, H6a-verified
/// (DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH). The CLMM price backend owner-
/// checks pool/observation accounts against this; `verify-layouts.ts` guards the
/// byte offsets `house-math::clmm` reads.
pub const CLMM_PROGRAM_ID: Pubkey = Pubkey::new_from_array([
    184, 152, 151, 52, 252, 179, 140, 145, 104, 216, 83, 199, 83, 182, 184, 164,
    54, 16, 205, 211, 37, 175, 187, 199, 47, 212, 21, 54, 219, 205, 194, 88,
]);

/// A price reading in the machine's fixed point: token-per-SOL × 1e12 for both
/// TWAP and spot, plus the age of the newest observation the TWAP was built on.
pub struct PriceReading {
    pub twap_1e12: u128,
    pub spot_1e12: u128,
    pub newest_obs_age_secs: u32,
}

// ---- mock price backend (feature = "mock-price") ----
#[cfg(feature = "mock-price")]
fn read_price(
    pool: &AccountInfo, _observation: &AccountInfo, expected_pool: Pubkey, _expected_obs: Pubkey,
    _now_secs: u32, _window_secs: u32,
) -> Result<PriceReading> {
    // the mock reuses the machine's `pool` field as the MockPrice account key.
    require_keys_eq!(pool.key(), expected_pool, HouseError::InvalidPriceAccount);
    require_keys_eq!(*pool.owner, crate::ID, HouseError::InvalidPriceAccount);
    let data = pool.try_borrow_data()?;
    let p = MockPrice::try_deserialize(&mut &data[..]).map_err(|_| HouseError::InvalidPriceAccount)?;
    Ok(PriceReading { twap_1e12: p.twap_1e12, spot_1e12: p.spot_1e12, newest_obs_age_secs: p.age_secs })
}

// ---- CLMM backend (default / deployable), stubbed until H6b-3 ----
#[cfg(not(feature = "mock-price"))]
fn read_price(
    pool: &AccountInfo, observation: &AccountInfo, expected_pool: Pubkey, expected_obs: Pubkey,
    now_secs: u32, window_secs: u32,
) -> Result<PriceReading> {
    // key checks: the accounts must be the ones the machine recorded at creation.
    require_keys_eq!(pool.key(), expected_pool, HouseError::InvalidPriceAccount);
    require_keys_eq!(observation.key(), expected_obs, HouseError::InvalidPriceAccount);
    // owner-check trust pattern (spec §2): both must be owned by the Raydium CLMM
    // program — the protocol's own accounts, not a look-alike we could be fed.
    require!(pool.owner.to_bytes() == CLMM_PROGRAM_ID.to_bytes(), HouseError::InvalidPriceAccount);
    require!(observation.owner.to_bytes() == CLMM_PROGRAM_ID.to_bytes(), HouseError::InvalidPriceAccount);

    let pool_data = pool.try_borrow_data()?;
    let obs_data = observation.try_borrow_data()?;
    // cross-link: PoolState.observation_id == the observation account, and
    // ObservationState.pool_id == the pool account (the pinned H6a offsets).
    require!(hm::clmm::pool_observation_id(&pool_data) == observation.key().to_bytes(), HouseError::InvalidPriceAccount);
    require!(hm::clmm::obs_pool_id(&obs_data) == pool.key().to_bytes(), HouseError::InvalidPriceAccount);

    // read spot (sqrt_price) + TWAP (cumulative-tick ring) via house-math.
    let r = hm::clmm::read_clmm_price(&pool_data, &obs_data, now_secs, window_secs)
        .ok_or(HouseError::InvalidPriceAccount)?;
    // Map the raw TWAP to the PriceReading contract WITHOUT touching gate logic:
    // a covered window yields (twap price, real age); an uncovered/cold ring
    // yields (0, u32::MAX) so eval_price_gates refuses it as PriceStale.
    let (twap_1e12, age) = match r.twap {
        hm::twap::TwapRead::Live { avg_tick } => (hm::price::price_1e12_at_tick(avg_tick as i32), r.newest_obs_age_secs),
        hm::twap::TwapRead::NotReady(_) => (0u128, u32::MAX),
    };
    Ok(PriceReading { twap_1e12, spot_1e12: r.spot_1e12, newest_obs_age_secs: age })
}

/// Shared gate evaluation (spec §2–3), OUTSIDE the seam so both backends and
/// H6b-3 use identical logic: refuse if the newest observation is stale, or if
/// spot has drifted more than `band_bp` from the TWAP.
fn eval_price_gates(r: &PriceReading, max_staleness_secs: u32, band_bp: u16) -> Result<()> {
    require!(r.newest_obs_age_secs <= max_staleness_secs, HouseError::PriceStale);
    require!(r.twap_1e12 > 0, HouseError::PriceUnstable);
    // refuse if |spot − twap| / twap > band_bp/BP  ⇔  |spot−twap|·BP > twap·band_bp
    let diff = r.spot_1e12.abs_diff(r.twap_1e12);
    let lhs = diff.checked_mul(hm::BP).ok_or(HouseError::MathOverflow)?;
    let rhs = r.twap_1e12.checked_mul(band_bp as u128).ok_or(HouseError::MathOverflow)?;
    require!(lhs <= rhs, HouseError::PriceUnstable);
    Ok(())
}

// -------------------- AMM swap seam (H6b-3 accounting, H6c-1 real CPI) --------------------
//
// compound_epoch's ONE AMM CPI, behind a seam like the price/randomness ones:
//   * mock-swap feature ON  → fills at the read SPOT price from a caller-supplied
//     counterparty (LiteSVM has no Raydium program). Proves the compound
//     ACCOUNTING; a settable fill is test-only, so it is OFF in the deployable
//     build. The mock takes remaining_accounts [counterparty_token, counterparty
//     _authority(signer)].
//   * feature OFF (default/deployable) → the REAL Raydium CLMM `swap_v2` CPI
//     (WSOL → token) signed by the machine PDA (H6c-1). Its ACCOUNTING is what the
//     mock proves in LiteSVM; the on-chain wiring is proven live on devnet by
//     scripts/devnet-compound.ts (LiteSVM has no Raydium program), mirroring how
//     the CLMM price reader was proven via a real dual spin.

/// Swap `amount_sol` of the machine's earmarked lamports into the token, into the
/// vault. Returns tokens_received. The machine PDA is the swap authority.
#[cfg(feature = "mock-swap")]
#[allow(clippy::too_many_arguments)]
fn amm_swap_sol_to_token<'info>(
    machine: AccountInfo<'info>,
    _machine_id: &[u8; 16],
    _bump: u8,
    vault: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    amount_sol: u64,
    _min_out: u64,
    spot_1e12: u128,
    token_decimals: u8,
    _expected_pool: Pubkey,        // (B1) real path pins these; the mock uses a counterparty
    _expected_observation: Pubkey,
) -> Result<u64> {
    require!(remaining.len() >= 2, HouseError::InvalidPriceAccount);
    let counterparty_token = &remaining[0];
    let counterparty_auth = &remaining[1];
    // fill at the SPOT price: tokens_out = value of amount_sol in token base units.
    let tokens_out = u64::try_from(
        hm::payout::payout_tokens(amount_sol as u128, hm::BP, hm::BP, spot_1e12, token_decimals)
            .ok_or(HouseError::MathOverflow)?,
    ).map_err(|_| HouseError::MathOverflow)?;
    // machine SOL -> counterparty (the AMM side), tokens -> vault.
    token::transfer(
        CpiContext::new(
            token_program.key(),
            Transfer { from: counterparty_token.clone(), to: vault.clone(), authority: counterparty_auth.clone() },
        ),
        tokens_out,
    )?;
    **machine.try_borrow_mut_lamports()? -= amount_sol;
    **counterparty_auth.try_borrow_mut_lamports()? += amount_sol;
    Ok(tokens_out)
}

/// Raydium CLMM `swap_v2` anchor discriminator = sha256("global:swap_v2")[..8],
/// pinned from the live reference tx (verified in `compound_swap_wiring_tests`).
#[cfg(not(feature = "mock-swap"))]
const SWAP_V2_DISCRIMINATOR: [u8; 8] = [0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62];

/// Real Raydium CLMM `swap_v2` CPI — the deployable path (H6c-1). The crank fronts
/// the WSOL (creates + funds + sync_natives the machine PDA's WSOL ATA with
/// `amount_sol`, in the same tx, right before this call); this seam swaps that
/// WSOL→token straight into the machine's own vault (min_out enforced as
/// `other_amount_threshold`, swap signed by the machine PDA), then reimburses the
/// cranker `amount_sol` out of the machine as its LAST lamport op. Net: the
/// machine's lamport balance falls by EXACTLY `amount_sol`, the cranker is whole.
///
/// GROUND TRUTH — pinned against a live devnet keeper swap on the CHIP/WSOL pool
/// (`prove-layouts-with-swaps.ts` / `keeper.ts` produce these):
///   reference txid 5XcKLeGcHVcdDf8faCutjZ1BH22dgWYgjE49Dg56S6MoE4iSPMdzc6DcC2xF1m26jkEoTjETN4KhAV9XWehKXFVk
///   (devnet, slot 474331936, 2026-07-06T07:50:08Z; log "Instruction: SwapV2", 52929 CU).
/// Instruction data (41 bytes): disc sha256("global:swap_v2")[..8] = 2b04ed0b1ac91e62,
///   then amount:u64, other_amount_threshold:u64, sqrt_price_limit_x64:u128, is_base_input:bool.
/// swap_v2 account order (13 fixed + remaining): [0] payer/authority, [1] amm_config,
///   [2] pool_state, [3] input_token_account, [4] output_token_account, [5] input_vault,
///   [6] output_vault, [7] observation_state, [8] token_program, [9] token_program_2022,
///   [10] memo_program, [11] input_vault_mint, [12] output_vault_mint, then
///   [tickarray_bitmap_extension, tick_array..] as remaining accounts.
///
/// The crank supplies the Raydium + wrap accounts through `remaining` (the seam
/// keeps its signature; the CompoundEpoch struct is unchanged). Order:
///   [0] cranker (writable — fronted the WSOL wrap, reimbursed by the machine)
///   [1] wsol_mint (NATIVE_MINT; swap_v2 input_vault_mint)
///   [2] wsol_ata  (writable; the machine PDA's WSOL ATA, funded by the crank)
///   [3] clmm_program (owner-checked == CLMM_PROGRAM_ID)
///   [4] amm_config          [5] pool_state
///   [6] pool_input_vault (WSOL)   [7] pool_output_vault (token)
///   [8] observation_state  [9] token_program_2022   [10] memo_program
///   [11] output_vault_mint (== machine token mint)
///   [12..] tickarray_bitmap_extension, tick_array.. (SDK `remainingAccounts`)
#[cfg(not(feature = "mock-swap"))]
#[allow(clippy::too_many_arguments)]
fn amm_swap_sol_to_token<'info>(
    machine: AccountInfo<'info>,
    machine_id: &[u8; 16],
    bump: u8,
    vault: AccountInfo<'info>,
    token_program: AccountInfo<'info>,
    remaining: &[AccountInfo<'info>],
    amount_sol: u64,
    min_out: u64,
    _spot_1e12: u128,
    _token_decimals: u8,
    expected_pool: Pubkey,
    expected_observation: Pubkey,
) -> Result<u64> {
    // fixed prefix (13) + at least one tick array.
    require!(remaining.len() >= 14, HouseError::InvalidPriceAccount);
    let cranker = &remaining[0];
    let wsol_mint = &remaining[1];
    let wsol_ata = &remaining[2];
    let clmm_program = &remaining[3];
    let amm_config = &remaining[4];
    let pool_state = &remaining[5];
    let pool_input_vault = &remaining[6];
    let pool_output_vault = &remaining[7];
    let observation = &remaining[8];
    let token_program_2022 = &remaining[9];
    let memo_program = &remaining[10];
    let output_vault_mint = &remaining[11];
    let bitmap_and_ticks = &remaining[12..];

    // trust the REAL CLMM program only (owner-check pattern, spec §2): a look-alike
    // can't be the swap target. Output lands in `vault` (constrained to the
    // machine's token_vault by the accounts struct) and must clear `min_out`.
    require_keys_eq!(*clmm_program.key, CLMM_PROGRAM_ID, HouseError::InvalidPriceAccount);
    // HARDEN-1 (B1): PIN the swap pool + observation to the machine's OWN price source,
    // so the pool we swap against is provably the pool we priced `min_out` off of — not
    // merely a real Raydium pool bounded by min_out. The pool's own vaults are then
    // transitively constrained (Raydium's swap_v2 checks vault↔pool_state internally),
    // and `output_vault_mint` must equal the machine token (Raydium checks it against
    // the output ATA = the machine vault). min_out + the CLMM owner-check stay as
    // defense in depth. (REDTEAM.md §2 / B1.)
    require_keys_eq!(*pool_state.key, expected_pool, HouseError::InvalidPriceAccount);
    require_keys_eq!(*observation.key, expected_observation, HouseError::InvalidPriceAccount);

    let signer_seeds: &[&[u8]] = &[b"dual-machine", machine_id.as_ref(), std::slice::from_ref(&bump)];

    // FUNDING MODEL. The machine PDA is program-owned, so it can be neither a
    // system-transfer source nor (having modified a non-owned account's lamports
    // mid-instruction) followed by a CPI without tripping the runtime's per-CPI
    // balance check. So the WSOL for the swap is fronted by the CRANK: it creates
    // + funds + sync_natives the machine PDA's WSOL ATA with EXACTLY `amount_sol`
    // in the SAME transaction, right before this instruction. This seam swaps that
    // WSOL, then — as the LAST lamport operation, so the only balance check is at
    // the instruction's RETURN (the Anchor `close` primitive) — reimburses the
    // cranker `amount_sol` out of the machine. Net: machine −amount_sol, cranker ±0.

    // measure the vault, then swap_v2 WSOL→token straight into it.
    let before = token_amount(&vault)?;
    let mut data = Vec::with_capacity(41);
    data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
    data.extend_from_slice(&amount_sol.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes()); // other_amount_threshold
    data.extend_from_slice(&0u128.to_le_bytes()); // sqrt_price_limit_x64 = 0 (no limit)
    data.push(1); // is_base_input = true

    let mut metas = vec![
        AccountMeta::new_readonly(*machine.key, true), // [0] payer/authority (PDA-signed)
        AccountMeta::new_readonly(*amm_config.key, false),
        AccountMeta::new(*pool_state.key, false),
        AccountMeta::new(*wsol_ata.key, false), // input_token_account
        AccountMeta::new(*vault.key, false),    // output_token_account (machine vault)
        AccountMeta::new(*pool_input_vault.key, false),
        AccountMeta::new(*pool_output_vault.key, false),
        AccountMeta::new(*observation.key, false),
        AccountMeta::new_readonly(*token_program.key, false),
        AccountMeta::new_readonly(*token_program_2022.key, false),
        AccountMeta::new_readonly(*memo_program.key, false),
        AccountMeta::new_readonly(*wsol_mint.key, false), // input_vault_mint
        AccountMeta::new_readonly(*output_vault_mint.key, false),
    ];
    for a in bitmap_and_ticks {
        metas.push(AccountMeta::new(*a.key, false)); // bitmap ext + tick arrays are writable
    }
    let mut infos = vec![
        machine.clone(), amm_config.clone(), pool_state.clone(), wsol_ata.clone(),
        vault.clone(), pool_input_vault.clone(), pool_output_vault.clone(),
        observation.clone(), token_program.clone(), token_program_2022.clone(),
        memo_program.clone(), wsol_mint.clone(), output_vault_mint.clone(),
    ];
    infos.extend(bitmap_and_ticks.iter().cloned());
    infos.push(clmm_program.clone()); // program account for the invoke

    invoke_signed(
        &Instruction { program_id: *clmm_program.key, accounts: metas, data },
        &infos,
        &[signer_seeds],
    )?;
    let after = token_amount(&vault)?;
    let received = after.checked_sub(before).ok_or(HouseError::MathOverflow)?;

    // reimburse the cranker for the WSOL it fronted — the LAST lamport op, so the
    // only balance check is at instruction RETURN (owned-debit + non-owned-credit,
    // the Anchor `close` primitive; a credit interleaved before a CPI would trip
    // the per-CPI subset balance check). Machine's net lamport delta is EXACTLY
    // `amount_sol`; the cranker is made whole; the machine keeps the swapped token.
    **machine.try_borrow_mut_lamports()? = machine
        .lamports()
        .checked_sub(amount_sol)
        .ok_or(HouseError::MathOverflow)?;
    **cranker.try_borrow_mut_lamports()? = cranker
        .lamports()
        .checked_add(amount_sol)
        .ok_or(HouseError::MathOverflow)?;
    Ok(received)
}

/// SPL token account balance (u64 @ offset 64) read straight from account bytes —
/// used to measure the vault before/after the swap CPI (the CPI returns no amount).
#[cfg(not(feature = "mock-swap"))]
fn token_amount(acct: &AccountInfo) -> Result<u64> {
    let data = acct.try_borrow_data()?;
    require!(data.len() >= 72, HouseError::InvalidPriceAccount);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

// -------------------- accounts --------------------

/// Singleton house config (PDA `["house-config"]`). `reserved` pads to a fixed
/// size so fee/epoch/governance fields can be added later without a migration.
#[account]
pub struct HouseConfig {
    pub admin: Pubkey,
    pub bump: u8,
    pub reserved: [u8; HouseConfig::RESERVED_LEN],
}
impl HouseConfig {
    pub const RESERVED_LEN: usize = 63;
    pub const SIZE: usize = 8 + 32 + 1 + Self::RESERVED_LEN;
}

/// A machine: vault + immutable params + pool accounting + anti-snipe smoothed
/// depth. PDA `["machine", machine_id]`.
#[account]
pub struct Machine {
    pub machine_id: [u8; 16],
    pub curator: Pubkey,
    // params (immutable after creation)
    pub d_low: u64,
    pub d_mid: u64,
    pub d_high: u64,
    pub max_exposure_bp: u64,
    pub smooth_window: u64,
    // accounting (internal depth the curve reads — NOT raw vault lamports)
    pub pool_value: u64,
    pub reserved_exposure: u64,
    pub total_shares: u128,
    // anti-snipe smoothed depth (house-math SmoothedDepth fields)
    pub smoothed_value: u128,
    pub smoothed_last_slot: u64,
    pub paused: bool,
    pub bump: u8,
    /// Epoch length in slots for the withdrawal crank (HOUSE-SPEC §5). Carved
    /// from the former 32→ (now 56)-byte reserved tail so the account size is
    /// unchanged: machines created before H3 read 0 here and fall back to
    /// DEFAULT_EPOCH_LENGTH_SLOTS via `epoch_length_eff()`.
    pub epoch_length: u64,
    /// SCALE-2 per-epoch conservative withdrawal price snapshot (fixes SCALE.md §1b).
    /// Carved from the reserved tail (24 bytes: u128 + u64), SIZE unchanged. Legacy
    /// accounts read 0 here; `withdraw_snapshot_epoch != current_epoch` (or price 0)
    /// means "no snapshot for this epoch yet — compute + store on the first crank".
    pub withdraw_snapshot_price: u128,
    pub withdraw_snapshot_epoch: u64,
    pub reserved: [u8; Machine::RESERVED_LEN],
}
impl Machine {
    // epoch_length(8) + withdraw_snapshot_price(16) + withdraw_snapshot_epoch(8)
    // carved out of the former 64-byte reserved; size unchanged.
    pub const RESERVED_LEN: usize = 32;
    pub const SIZE: usize = 8 + 16 + 32 + (5 * 8) + 8 + 8 + 16 + 16 + 8 + 1 + 1 + 8 + 16 + 8 + Self::RESERVED_LEN;

    /// Effective epoch length: the stored value, or the default for legacy
    /// (pre-H3) machines that stored 0. `create_machine` forbids 0 for new ones.
    pub fn epoch_length_eff(&self) -> u64 {
        if self.epoch_length == 0 { DEFAULT_EPOCH_LENGTH_SLOTS } else { self.epoch_length }
    }
    /// The epoch index a slot falls in (HOUSE-SPEC §5, `slot / epoch_length`).
    pub fn epoch_of(&self, slot: u64) -> u64 { slot / self.epoch_length_eff() }
    /// Free liquidity available to withdrawals: pool depth minus escrowed spin
    /// exposure. Withdrawals are capped here so pending spins always stay funded.
    pub fn free_liquidity(&self) -> u64 { self.pool_value.saturating_sub(self.reserved_exposure) }
}

/// An LP's stake in a machine. PDA `["lp", machine, owner]`. The pending-
/// withdrawal fields are sized now so the H3 epoch-withdrawal crank needs no
/// layout change (HOUSE-SPEC §3, §5).
#[account]
pub struct LpPosition {
    pub machine: Pubkey,
    pub owner: Pubkey,
    pub shares: u128,
    // pending withdrawal (H3): queued shares + the epoch they were queued in.
    pub pending_shares: u128,
    pub pending_epoch: u64,
    pub bump: u8,
    pub reserved: [u8; 32],
}
impl LpPosition {
    pub const SIZE: usize = 8 + 32 + 32 + 16 + 16 + 8 + 1 + 32;
}

/// A committed, not-yet-settled spin. PDA `["spin", machine, player, nonce]`.
/// Holds the frozen odds snapshot and the randomness binding.
#[account]
pub struct PendingSpin {
    pub machine: Pubkey,
    pub player: Pubkey,
    pub nonce: u64,
    pub wager: u64,
    // snapshot frozen at commit (HOUSE-SPEC §4.1)
    pub k_bp: u128,
    pub tier_is_deep: bool,
    pub max_payout: u64,
    // randomness binding
    pub randomness: Pubkey,
    /// Switchboard seed_slot the account was committed against (0 under mock).
    /// Settle requires the presented account's seed_slot to equal this, so a
    /// swapped or re-seeded randomness account is rejected.
    pub rand_seed_slot: u64,
    pub commit_slot: u64,
    pub bump: u8,
    pub reserved: [u8; 24],
}
impl PendingSpin {
    // rand_seed_slot(8) was carved out of the former 32-byte reserved tail, so
    // the account size is unchanged from H1.
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8 + 16 + 1 + 8 + 32 + 8 + 8 + 1 + 24;
}

// ===================== DUAL-ASSET ACCOUNTS (H6b-1) =====================
//
// ACCOUNT-STRATEGY DECISION (task requirement). The dual-asset parameter set —
// four Pubkeys (mint, pool, observation, vault) plus decimals, five bp/window
// params, and token/reserve/yield accounting — is ~190 bytes, FAR beyond
// `Machine`'s 56 reserved bytes. So the H3-style "carve a discriminant + append
// fields into the existing account" is impossible without growing `Machine`,
// which would break deserialization of the LIVE H3 SOL machines on devnet (their
// accounts simply lack the bytes). We therefore use a SEPARATE `DualMachine`
// account type: purely additive, legacy `Machine` accounts and code paths are
// untouched, and the "denom" distinction is the account TYPE (Machine = SOL /
// legacy, DualMachine = dual-asset) rather than a byte flag. PDA seed differs
// (`["dual-machine", id]`) so the namespaces never collide.

/// Parameters for `create_machine_dual`, bundled to dodge the arg-count limit.
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DualParams {
    pub pool: Pubkey,          // Raydium CLMM pool (MockPrice PDA under mock-price)
    pub observation: Pubkey,   // Raydium ObservationState (unused under mock-price)
    pub token_decimals: u8,
    pub d_low: u64,
    pub d_mid: u64,
    pub d_high: u64,
    pub max_exposure_bp: u64,
    pub smooth_window: u64,
    pub epoch_length: u64,
    pub twap_window_secs: u32,
    pub max_staleness_secs: u32,
    pub band_bp: u16,
    pub m_bp: u16,
    pub haircut_bp: u16,
    pub rtp_max_bp: u16,
    pub max_pending_spins: u16,
}

/// A dual-asset machine: SOL vault (the PDA's lamports) + token vault (an ATA the
/// PDA owns) + price-source addresses + risk params + dual accounting. PDA
/// `["dual-machine", machine_id]`.
#[account]
pub struct DualMachine {
    pub machine_id: [u8; 16],
    pub curator: Pubkey,
    // price source (recorded now; parsed on-chain in H6b-3)
    pub token_mint: Pubkey,
    pub pool: Pubkey,
    pub observation: Pubkey,
    pub token_vault: Pubkey,
    pub token_decimals: u8,
    // curve params (value-denominated), mirror Machine
    pub d_low: u64,
    pub d_mid: u64,
    pub d_high: u64,
    pub max_exposure_bp: u64,
    pub smooth_window: u64,
    pub epoch_length: u64,
    // price / risk params
    pub twap_window_secs: u32,
    pub max_staleness_secs: u32,
    pub band_bp: u16,
    pub m_bp: u16,
    pub haircut_bp: u16,
    pub rtp_max_bp: u16,
    pub max_pending_spins: u16,
    pub pending_spins: u16,
    // accounting
    pub token_balance: u128,     // internal token depth (mirrors the vault ATA)
    pub reserved_tokens: u128,   // sum of haircut reserves across pending spins
    pub escrowed_sol: u64,       // committed wagers held, not yet settled
    pub div_pool_sol: u64,       // SOL held for SOL-mode dividends (== accrued − claimed)
    pub total_shares: u128,      // token-denominated LP shares
    // H6b-2 SOL dividend ledger (MasterChef): per-share index + SPL-mode earmark
    pub acc_sol_per_share: u128, // 1e24-scaled per-share accumulator (house-math dividend)
    pub earmarked_sol: u64,      // SOL set aside for SPL-mode positions (excluded from all else)
    // anti-snipe smoothed depth on token-side VALUE (token_balance × TWAP)
    pub smoothed_value: u128,
    pub smoothed_last_slot: u64,
    pub paused: bool,
    pub bump: u8,
    /// SCALE-2 per-epoch conservative withdrawal price snapshot on the TOKEN side
    /// (fixes SCALE.md §1b). Carved from the reserved tail (24 bytes), SIZE unchanged;
    /// legacy semantics identical to Machine's.
    pub withdraw_snapshot_price: u128,
    pub withdraw_snapshot_epoch: u64,
    pub reserved: [u8; DualMachine::RESERVED_LEN],
}
impl DualMachine {
    // acc_sol_per_share(16) + earmarked_sol(8) carved earlier; SCALE-2 adds
    // withdraw_snapshot_price(16) + withdraw_snapshot_epoch(8) from the reserved
    // tail; SIZE unchanged.
    pub const RESERVED_LEN: usize = 16;
    pub const SIZE: usize = 8 + 16 + 32   // id, curator
        + 32 + 32 + 32 + 32 + 1           // mint, pool, obs, vault, decimals
        + (6 * 8)                         // d_low..epoch_length
        + (2 * 4)                         // twap_window, max_staleness
        + (7 * 2)                         // band..pending_spins (7 u16)
        + 16 + 16 + 8 + 8 + 16            // token_balance, reserved_tokens, escrowed_sol, div_pool_sol, total_shares
        + 16 + 8                          // acc_sol_per_share, earmarked_sol
        + 16 + 8 + 1 + 1                  // smoothed_value, smoothed_last_slot, paused, bump
        + 16 + 8                          // withdraw_snapshot_price, withdraw_snapshot_epoch
        + Self::RESERVED_LEN;
    pub fn epoch_length_eff(&self) -> u64 {
        if self.epoch_length == 0 { DEFAULT_EPOCH_LENGTH_SLOTS } else { self.epoch_length }
    }
    pub fn epoch_of(&self, slot: u64) -> u64 { slot / self.epoch_length_eff() }
    /// Free (unreserved) tokens available to withdrawals in H6b-2.
    pub fn free_tokens(&self) -> u128 { self.token_balance.saturating_sub(self.reserved_tokens) }
}

// SCALE-2 carved the withdrawal snapshot fields from the reserved tails; the on-disk
// SIZE must be BYTE-IDENTICAL so live accounts (e.g. dual-chip-1 at 409 bytes) keep
// reading. These lock it at compile time.
const _: () = assert!(Machine::SIZE == 218, "Machine SIZE changed — would break live accounts");
const _: () = assert!(DualMachine::SIZE == 409, "DualMachine SIZE changed — would break live accounts");

/// A dual-asset LP's stake. PDA `["dual-lp", machine, owner]`. The pending-
/// withdrawal + dividend-ledger fields are sized NOW so H6b-2 needs no layout
/// change (spec §5): `sol_debt` is the reward-debt marker of the pro-rata SOL
/// dividend ledger, `reward_mode` selects accrue-vs-compound.
#[account]
pub struct DualLpPosition {
    pub machine: Pubkey,
    pub owner: Pubkey,
    pub shares: u128,
    // epoch-gated withdrawal queue (H3 pattern, dual-asset)
    pub pending_shares: u128,
    pub pending_epoch: u64,
    // SOL dividend ledger (H6b-2)
    pub sol_debt: u128,      // MasterChef reward debt (== entitlement at last settle)
    pub reward_mode: u8,     // REWARD_MODE_SOL (0) pays SOL; REWARD_MODE_SPL (1) earmarks it
    pub earmarked_sol: u64,  // SPL-mode SOL set aside for this position (compound_epoch swaps it)
    pub last_compound_epoch: u64, // epoch of this position's last compound (H6b-3)
    pub bump: u8,
    pub reserved: [u8; 16],
}
impl DualLpPosition {
    // earmarked_sol(8) + last_compound_epoch(8) carved from the former 32-byte
    // reserved tail; SIZE unchanged.
    pub const SIZE: usize = 8 + 32 + 32 + 16 + 16 + 8 + 16 + 1 + 8 + 8 + 1 + 16;
}

/// Reward modes on a dual-asset LP position (spec §5).
pub const REWARD_MODE_SOL: u8 = 0; // claim pays pending SOL to the owner
pub const REWARD_MODE_SPL: u8 = 1; // pending SOL earmarked for a later swap-to-token (H6b-3)

/// A committed dual-asset spin. PDA `["dual-spin", machine, player, nonce]`.
/// Holds the frozen odds+price snapshot and the randomness binding.
#[account]
pub struct DualPendingSpin {
    pub machine: Pubkey,
    pub player: Pubkey,
    pub nonce: u64,
    pub wager: u64, // SOL lamports
    // snapshot frozen at commit (spec §3)
    pub k_bp: u128,
    pub tier_is_deep: bool,
    pub price_at_commit_1e12: u128, // TWAP, token-per-SOL × 1e12
    pub max_payout_tokens: u128,    // reserve basis (JACKPOT³)
    pub reserved_tokens: u128,      // max_payout × (1 + haircut)
    // randomness binding (shared seam)
    pub randomness: Pubkey,
    pub rand_seed_slot: u64,
    pub commit_slot: u64,
    pub bump: u8,
    pub reserved: [u8; 16],
}
impl DualPendingSpin {
    pub const SIZE: usize = 8 + 32 + 32 + 8 + 8   // machine, player, nonce, wager
        + 16 + 1 + 16 + 16 + 16                   // k, tier, price, max_payout, reserved
        + 32 + 8 + 8 + 1 + 16;                    // randomness, seed_slot, commit_slot, bump, reserved
}

/// TEST-ONLY price source (mock-price feature). Program-owned so the price
/// seam's owner check passes; never compiled into the deployable build. Set
/// directly (twap, spot, age) — no clock math, so tests control staleness.
#[cfg(feature = "mock-price")]
#[account]
pub struct MockPrice {
    pub authority: Pubkey,
    pub twap_1e12: u128,
    pub spot_1e12: u128,
    pub age_secs: u32,
    pub bump: u8,
}
#[cfg(feature = "mock-price")]
impl MockPrice {
    pub const SIZE: usize = 8 + 32 + 16 + 16 + 4 + 1;
}

/// TEST-ONLY randomness source (mock-randomness feature). Program-owned so the
/// seam's owner check passes; never compiled into the deployable build.
#[cfg(feature = "mock-randomness")]
#[account]
pub struct MockRandomness {
    pub authority: Pubkey,
    pub slot: u64,
    pub bytes: [u8; 32],
    pub filled: bool,
    pub bump: u8,
}
#[cfg(feature = "mock-randomness")]
impl MockRandomness {
    pub const SIZE: usize = 8 + 32 + 8 + 32 + 1 + 1;
}

// -------------------- contexts --------------------

#[derive(Accounts)]
pub struct InitializeHouseConfig<'info> {
    #[account(init, payer = payer, space = HouseConfig::SIZE, seeds = [b"house-config"], bump)]
    pub config: Account<'info, HouseConfig>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAdmin<'info> {
    #[account(mut, seeds = [b"house-config"], bump = config.bump,
              has_one = admin @ HouseError::NotAdmin)]
    pub config: Account<'info, HouseConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(machine_id: [u8; 16])]
pub struct CreateMachine<'info> {
    // admin gate: signer must equal HouseConfig.admin.
    #[account(seeds = [b"house-config"], bump = config.bump,
              has_one = admin @ HouseError::NotAdmin)]
    pub config: Account<'info, HouseConfig>,
    #[account(init, payer = admin, space = Machine::SIZE,
              seeds = [b"machine", machine_id.as_ref()], bump)]
    pub machine: Account<'info, Machine>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(mut, seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump,
              has_one = curator @ HouseError::NotCurator)]
    pub machine: Account<'info, Machine>,
    pub curator: Signer<'info>,
}

#[derive(Accounts)]
pub struct LpDeposit<'info> {
    #[account(mut, seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(init_if_needed, payer = owner, space = LpPosition::SIZE,
              seeds = [b"lp", machine.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Account<'info, LpPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestWithdraw<'info> {
    #[account(seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(mut, has_one = owner, has_one = machine,
              seeds = [b"lp", machine.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, LpPosition>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelWithdraw<'info> {
    #[account(seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(mut, has_one = owner, has_one = machine,
              seeds = [b"lp", machine.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Account<'info, LpPosition>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProcessWithdrawals<'info> {
    #[account(mut, seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(mut, has_one = machine,
              seeds = [b"lp", machine.key().as_ref(), position.owner.as_ref()], bump = position.bump)]
    pub position: Account<'info, LpPosition>,
    /// CHECK: receives the payout and (on a fully-emptied position) the rent;
    /// constrained to equal position.owner.
    #[account(mut, address = position.owner)]
    pub owner: UncheckedAccount<'info>,
    pub cranker: Signer<'info>, // literally anyone
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wager: u64, nonce: u64)]
pub struct SpinCommit<'info> {
    #[account(mut, seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(init, payer = player, space = PendingSpin::SIZE,
              seeds = [b"spin", machine.key().as_ref(), player.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub pending_spin: Account<'info, PendingSpin>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: randomness account bound to this spin; its key is recorded and
    /// verified at settle through the randomness seam. Not read at commit.
    pub randomness: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct SpinSettle<'info> {
    #[account(mut, seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(mut, has_one = machine, has_one = player,
              seeds = [b"spin", machine.key().as_ref(), pending_spin.player.as_ref(), &nonce.to_le_bytes()],
              bump = pending_spin.bump,
              close = player)]
    pub pending_spin: Account<'info, PendingSpin>,
    /// CHECK: receives payout + spin rent; validated by `has_one = player`.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: revealed randomness, validated in the seam against pending_spin.randomness.
    pub randomness: UncheckedAccount<'info>,
    pub cranker: Signer<'info>, // literally anyone
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct SpinExpire<'info> {
    #[account(mut, seeds = [b"machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Account<'info, Machine>,
    #[account(mut, has_one = machine, has_one = player,
              seeds = [b"spin", machine.key().as_ref(), pending_spin.player.as_ref(), &nonce.to_le_bytes()],
              bump = pending_spin.bump,
              close = player)]
    pub pending_spin: Account<'info, PendingSpin>,
    /// CHECK: receives refund + spin rent; validated by `has_one = player`.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    pub cranker: Signer<'info>, // literally anyone
    pub system_program: Program<'info, System>,
}

// -------------------- dual-asset contexts (H6b-1) --------------------

#[derive(Accounts)]
#[instruction(machine_id: [u8; 16])]
pub struct CreateMachineDual<'info> {
    #[account(seeds = [b"house-config"], bump = config.bump, has_one = admin @ HouseError::NotAdmin)]
    pub config: Account<'info, HouseConfig>,
    #[account(init, payer = admin, space = DualMachine::SIZE,
              seeds = [b"dual-machine", machine_id.as_ref()], bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    pub token_mint: Box<Account<'info, Mint>>,
    // the machine PDA's associated token account — created here, owned by the PDA.
    #[account(init, payer = admin,
              associated_token::mint = token_mint,
              associated_token::authority = machine)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct LpDepositToken<'info> {
    #[account(mut, seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(init_if_needed, payer = owner, space = DualLpPosition::SIZE,
              seeds = [b"dual-lp", machine.key().as_ref(), owner.key().as_ref()], bump)]
    pub position: Box<Account<'info, DualLpPosition>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, token::mint = machine.token_mint, token::authority = owner)]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = machine.token_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(wager: u64, nonce: u64)]
pub struct SpinCommitDual<'info> {
    #[account(mut, seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(init, payer = player, space = DualPendingSpin::SIZE,
              seeds = [b"dual-spin", machine.key().as_ref(), player.key().as_ref(), &nonce.to_le_bytes()], bump)]
    pub pending_spin: Box<Account<'info, DualPendingSpin>>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: randomness account; verified in the randomness seam at settle.
    pub randomness: UncheckedAccount<'info>,
    /// CHECK: price pool (Raydium PoolState or the MockPrice account); verified in the price seam.
    pub price_pool: UncheckedAccount<'info>,
    /// CHECK: Raydium ObservationState; verified in the price seam (unused under mock-price).
    pub price_observation: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct SpinSettleDual<'info> {
    #[account(mut, seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(mut, has_one = machine, has_one = player,
              seeds = [b"dual-spin", machine.key().as_ref(), pending_spin.player.as_ref(), &nonce.to_le_bytes()],
              bump = pending_spin.bump, close = player)]
    pub pending_spin: Box<Account<'info, DualPendingSpin>>,
    /// CHECK: receives the spin rent; validated by has_one = player.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    /// CHECK: revealed randomness, validated in the seam against pending_spin.randomness.
    pub randomness: UncheckedAccount<'info>,
    #[account(mut, address = machine.token_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    // any token account the player owns for this mint receives the payout.
    #[account(mut, token::mint = machine.token_mint, token::authority = player)]
    pub player_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub cranker: Signer<'info>, // literally anyone
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct SpinExpireDual<'info> {
    #[account(mut, seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(mut, has_one = machine, has_one = player,
              seeds = [b"dual-spin", machine.key().as_ref(), pending_spin.player.as_ref(), &nonce.to_le_bytes()],
              bump = pending_spin.bump, close = player)]
    pub pending_spin: Box<Account<'info, DualPendingSpin>>,
    /// CHECK: receives refund + spin rent; validated by has_one = player.
    #[account(mut)]
    pub player: UncheckedAccount<'info>,
    pub cranker: Signer<'info>, // literally anyone
    pub system_program: Program<'info, System>,
}

// ---- dual-asset LP ledger + withdrawal contexts (H6b-2) ----

/// Used by claim_sol, earmark_sol, and set_reward_mode — all owner-signed and may
/// move SOL to the owner, so `owner` is a mutable signer.
#[derive(Accounts)]
pub struct ClaimDividend<'info> {
    #[account(mut, seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(mut, has_one = owner, has_one = machine,
              seeds = [b"dual-lp", machine.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, DualLpPosition>>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct RequestWithdrawToken<'info> {
    #[account(seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(mut, has_one = owner, has_one = machine,
              seeds = [b"dual-lp", machine.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, DualLpPosition>>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelWithdrawToken<'info> {
    #[account(seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(mut, has_one = owner, has_one = machine,
              seeds = [b"dual-lp", machine.key().as_ref(), owner.key().as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, DualLpPosition>>,
    pub owner: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProcessWithdrawalToken<'info> {
    #[account(mut, seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(mut, has_one = machine,
              seeds = [b"dual-lp", machine.key().as_ref(), position.owner.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, DualLpPosition>>,
    /// CHECK: receives the SOL dividend + (on close) rent; constrained to position.owner.
    #[account(mut, address = position.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, address = machine.token_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = machine.token_mint, token::authority = owner)]
    pub owner_token_account: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub cranker: Signer<'info>, // literally anyone
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompoundEpoch<'info> {
    #[account(mut, seeds = [b"dual-machine", machine.machine_id.as_ref()], bump = machine.bump)]
    pub machine: Box<Account<'info, DualMachine>>,
    #[account(mut, has_one = machine,
              seeds = [b"dual-lp", machine.key().as_ref(), position.owner.as_ref()], bump = position.bump)]
    pub position: Box<Account<'info, DualLpPosition>>,
    #[account(mut, address = machine.token_vault)]
    pub token_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: price pool (Raydium PoolState or MockPrice); verified in the price seam.
    pub price_pool: UncheckedAccount<'info>,
    /// CHECK: Raydium ObservationState; verified in the price seam.
    pub price_observation: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub cranker: Signer<'info>, // literally anyone
    // swap accounts (mock counterparty / real Raydium set) arrive via remaining_accounts.
}

#[cfg(feature = "mock-price")]
#[derive(Accounts)]
#[instruction(id: [u8; 16])]
pub struct MockSetPrice<'info> {
    #[account(init_if_needed, payer = authority, space = MockPrice::SIZE,
              seeds = [b"mock-price", id.as_ref()], bump)]
    pub price: Account<'info, MockPrice>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "mock-randomness")]
#[derive(Accounts)]
#[instruction(id: [u8; 16])]
pub struct MockFillRandomness<'info> {
    #[account(init_if_needed, payer = authority, space = MockRandomness::SIZE,
              seeds = [b"mock-rand", id.as_ref()], bump)]
    pub randomness: Account<'info, MockRandomness>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum HouseError {
    #[msg("Signer is not the house admin")] NotAdmin,
    #[msg("Signer is not the machine curator")] NotCurator,
    #[msg("Invalid machine parameters")] InvalidParams,
    #[msg("Machine is paused")] MachinePaused,
    #[msg("Wager/amount must be > 0")] InvalidWager,
    #[msg("Wager exceeds solvency-derived max bet")] BetExceedsMax,
    #[msg("Deposit too small to mint any shares")] DepositTooSmall,
    #[msg("Arithmetic overflow")] MathOverflow,
    #[msg("Randomness account is wrong, foreign, malformed, or re-seeded")] InvalidRandomnessAccount,
    #[msg("Randomness commitment is not fresh (must be the prior slot)")] RandomnessExpired,
    #[msg("Randomness not yet resolved (reveal not landed this slot)")] RandomnessNotResolved,
    #[msg("Spin has not passed its expiry window")] SpinNotExpired,
    #[msg("Settlement would make the pool insolvent")] InsolventSettlement,
    #[msg("Withdrawal share amount must be > 0")] InvalidWithdrawAmount,
    #[msg("Not enough active shares to withdraw")] InsufficientShares,
    #[msg("No pending withdrawal to process or cancel")] NothingToWithdraw,
    #[msg("Withdrawal epoch has not elapsed yet")] EpochNotElapsed,
    // dual-asset (H6b-1)
    #[msg("Dual-asset params cross the margin floor")] MarginFloorViolation,
    #[msg("Price account is wrong, foreign, or malformed")] InvalidPriceAccount,
    #[msg("CLMM price backend not implemented yet (H6b-3)")] PriceNotImplemented,
    #[msg("Price observations are stale")] PriceStale,
    #[msg("Spot has drifted too far from TWAP (band gate)")] PriceUnstable,
    #[msg("Machine has too many pending spins")] TooManyPendingSpins,
    #[msg("Not enough free token liquidity to reserve payout")] InsufficientTokenLiquidity,
    #[msg("Instruction does not match the position's reward mode")] WrongRewardMode,
    #[msg("twap_window_secs exceeds the observation ring's max coverage (1485s)")] TwapWindowExceedsRingCoverage,
}

// ---------------------------------------------------------------------------
// Unit coverage for the Switchboard randomness verification, without a live
// oracle: we craft RandomnessAccountData bytes and drive the seam functions
// directly. Compiled only in the default (Switchboard) build — the mock build
// replaces these functions. The live end-to-end path is exercised on devnet by
// scripts/devnet-spin.ts.
#[cfg(all(test, not(feature = "mock-randomness")))]
mod switchboard_seam_tests {
    use super::*;
    use anchor_lang::solana_program::account_info::AccountInfo;

    // RandomnessAccountData is #[repr(C)]; these are its field byte offsets
    // (add 8 for the account discriminator prefix). Guarded by a size assert.
    const DISC: [u8; 8] = [10, 66, 229, 135, 220, 239, 217, 114];
    const OFF_SEED_SLOT: usize = 8 + 96;
    const OFF_REVEAL_SLOT: usize = 8 + 136;
    const OFF_VALUE: usize = 8 + 144;
    const ACCT_LEN: usize = 8 + 400;

    // 8-byte aligned backing store so bytemuck's from_bytes accepts data[8..].
    #[repr(C, align(8))]
    struct Aligned([u8; ACCT_LEN]);

    fn build(seed_slot: u64, reveal_slot: u64, value: [u8; 32]) -> Aligned {
        assert_eq!(core::mem::size_of::<RandomnessAccountData>(), 400, "SB layout drifted");
        let mut b = Aligned([0u8; ACCT_LEN]);
        b.0[..8].copy_from_slice(&DISC);
        b.0[OFF_SEED_SLOT..OFF_SEED_SLOT + 8].copy_from_slice(&seed_slot.to_le_bytes());
        b.0[OFF_REVEAL_SLOT..OFF_REVEAL_SLOT + 8].copy_from_slice(&reveal_slot.to_le_bytes());
        b.0[OFF_VALUE..OFF_VALUE + 32].copy_from_slice(&value);
        b
    }

    fn sb_owner() -> Pubkey { Pubkey::new_from_array(ON_DEMAND_DEVNET_PID.to_bytes()) }

    fn code(e: anchor_lang::error::Error) -> u32 {
        match e {
            anchor_lang::error::Error::AnchorError(a) => a.error_code_number,
            _ => panic!("expected AnchorError"),
        }
    }
    fn want(err: HouseError) -> u32 { code(error!(err)) }

    /// commit: a randomness account committed in the immediately prior slot is
    /// accepted and its seed_slot returned.
    #[test]
    fn commit_accepts_fresh_seed_slot() {
        let buf = build(100, 0, [0u8; 32]);
        let key = Pubkey::new_unique();
        let owner = sb_owner();
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        assert_eq!(commit_seed_slot(&info, 101).unwrap(), 100);
    }

    /// commit: a stale commitment (not the prior slot) is rejected.
    #[test]
    fn commit_rejects_stale_seed_slot() {
        let buf = build(100, 0, [0u8; 32]);
        let key = Pubkey::new_unique();
        let owner = sb_owner();
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        // clock 200 => expected seed_slot 199, but it is 100
        let e = commit_seed_slot(&info, 200).unwrap_err();
        assert_eq!(code(e), want(HouseError::RandomnessExpired));
    }

    /// commit: a foreign-owned account (not the Switchboard program) is rejected.
    #[test]
    fn commit_rejects_wrong_owner() {
        let buf = build(100, 0, [0u8; 32]);
        let key = Pubkey::new_unique();
        let owner = Pubkey::new_unique(); // not Switchboard
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        let e = commit_seed_slot(&info, 101).unwrap_err();
        assert_eq!(code(e), want(HouseError::InvalidRandomnessAccount));
    }

    /// commit: a malformed account (bad discriminator) is rejected.
    #[test]
    fn commit_rejects_malformed() {
        let mut buf = build(100, 0, [0u8; 32]);
        buf.0[0] ^= 0xFF; // corrupt discriminator
        let key = Pubkey::new_unique();
        let owner = sb_owner();
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        let e = commit_seed_slot(&info, 101).unwrap_err();
        assert_eq!(code(e), want(HouseError::InvalidRandomnessAccount));
    }

    /// settle: matching key + seed_slot, revealed this slot -> returns the value.
    #[test]
    fn settle_reads_revealed_value() {
        let value = [7u8; 32];
        let buf = build(100, 555, value);
        let key = Pubkey::new_unique();
        let owner = sb_owner();
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        assert_eq!(revealed_bytes(&info, key, 100, 555).unwrap(), value);
    }

    /// settle: the presented account's key must match the snapshot.
    #[test]
    fn settle_rejects_wrong_key() {
        let buf = build(100, 555, [7u8; 32]);
        let key = Pubkey::new_unique();
        let owner = sb_owner();
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        let e = revealed_bytes(&info, Pubkey::new_unique(), 100, 555).unwrap_err();
        assert_eq!(code(e), want(HouseError::InvalidRandomnessAccount));
    }

    /// settle: a swapped/re-seeded account (seed_slot != snapshot) is rejected.
    #[test]
    fn settle_rejects_seed_slot_mismatch() {
        let buf = build(100, 555, [7u8; 32]);
        let key = Pubkey::new_unique();
        let owner = sb_owner();
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        let e = revealed_bytes(&info, key, 999, 555).unwrap_err();
        assert_eq!(code(e), want(HouseError::InvalidRandomnessAccount));
    }

    /// settle: value not revealed this slot (reveal_slot != clock) -> not resolved.
    #[test]
    fn settle_rejects_unrevealed() {
        let buf = build(100, 0, [0u8; 32]); // reveal_slot 0
        let key = Pubkey::new_unique();
        let owner = sb_owner();
        let mut data = buf.0;
        let mut lam = 0u64;
        let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false);
        let e = revealed_bytes(&info, key, 100, 555).unwrap_err();
        assert_eq!(code(e), want(HouseError::RandomnessNotResolved));
    }
}

// ---------------------------------------------------------------------------
// Deployable-build wiring check for compound_epoch's real Raydium CLMM swap CPI.
// Compiled ONLY in the default (non-mock-swap) build — the same build that ships
// — so `cargo test --workspace` forces the real `amm_swap_sol_to_token` to
// compile and guards the pinned `swap_v2` discriminator against the anchor
// derivation. The CPI's on-chain CORRECTNESS is proven live on devnet by
// scripts/devnet-compound.ts (mirroring how the CLMM price reader was proven via
// a real dual spin, not in LiteSVM which has no Raydium program).
#[cfg(all(test, not(feature = "mock-swap")))]
mod compound_swap_wiring_tests {
    use super::*;

    /// GROUND TRUTH: encode a `swap_v2` instruction body the way the seam does and
    /// assert it byte-reproduces the pinned LIVE reference tx's 41-byte data
    /// (5XcKLeGcHVc… on devnet, log "Instruction: SwapV2"). Its decoded args were
    /// amount 2_000_000_000, other_amount_threshold 1_850_366, sqrt_price_limit 0,
    /// is_base_input true. This forces the real (non-mock-swap) seam to compile
    /// under `cargo test --workspace` and pins the exact on-wire layout.
    #[test]
    fn swap_v2_encoding_matches_live_tx() {
        let (amount, threshold): (u64, u64) = (2_000_000_000, 1_850_366);
        let mut data = Vec::with_capacity(41);
        data.extend_from_slice(&SWAP_V2_DISCRIMINATOR);
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&threshold.to_le_bytes());
        data.extend_from_slice(&0u128.to_le_bytes()); // sqrt_price_limit_x64
        data.push(1); // is_base_input

        let live = hex_to_bytes(
            "2b04ed0b1ac91e620094357700000000fe3b1c00000000000000000000000000000000000000000001",
        );
        assert_eq!(data.len(), 41, "swap_v2 data is 8 disc + 33 args");
        assert_eq!(data, live, "seam encoding reproduces the live swap_v2 tx byte-for-byte");
        assert_eq!(SWAP_V2_DISCRIMINATOR, live[..8], "pinned discriminator == live tx prefix");
    }

    fn hex_to_bytes(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
}
