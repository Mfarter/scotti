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
        curator: Pubkey,
    ) -> Result<()> {
        // d_low < d_mid < d_high, all positive; the curve and tier split are
        // only well-defined under this ordering (house-math debug-asserts it).
        require!(0 < d_low && d_low < d_mid && d_mid < d_high, HouseError::InvalidParams);
        // exposure in (0, 100%]; the spec's governance default is 100 bp (1%).
        require!(max_exposure_bp > 0 && max_exposure_bp <= hm::BP as u64, HouseError::InvalidParams);
        require!(smooth_window > 0, HouseError::InvalidParams);

        let now = Clock::get()?.slot;
        let m = &mut ctx.accounts.machine;
        m.machine_id = machine_id;
        m.curator = curator;
        m.d_low = d_low;
        m.d_mid = d_mid;
        m.d_high = d_high;
        m.max_exposure_bp = max_exposure_bp;
        m.smooth_window = smooth_window;
        m.pool_value = 0;
        m.reserved_exposure = 0;
        m.total_shares = 0;
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
        let shares: u128 = if m.total_shares == 0 {
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

        let pos = &mut ctx.accounts.position;
        pos.machine = ctx.accounts.machine.key();
        pos.owner = ctx.accounts.owner.key();
        pos.shares = pos.shares.checked_add(shares).ok_or(HouseError::MathOverflow)?;
        pos.bump = ctx.bumps.position;
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
    pub reserved: [u8; Machine::RESERVED_LEN],
}
impl Machine {
    pub const RESERVED_LEN: usize = 64;
    pub const SIZE: usize = 8 + 16 + 32 + (5 * 8) + 8 + 8 + 16 + 16 + 8 + 1 + 1 + Self::RESERVED_LEN;
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
