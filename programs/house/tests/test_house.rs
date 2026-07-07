//! LiteSVM integration tests for the House H1 program, under the
//! `mock-randomness` feature (the whole file is cfg-gated, so plain
//! `cargo test --workspace` skips it — run with:
//!
//!   cargo build-sbf --features mock-randomness   # test .so with the mock
//!   cargo test -p house --features mock-randomness
//!
//! Books-balance discipline: every settlement/expiry is reconciled to the
//! lamport against house-math's own predicted payout — no hardcoded outcome
//! numbers. Harness style mirrors the Yvone-Protocol arbiter tests.
#![cfg(feature = "mock-randomness")]

use {
    anchor_lang::{
        solana_program::instruction::Instruction, solana_program::pubkey::Pubkey,
        solana_program::system_program, AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    yvone_house_math as hm,
};

// machine params shared by the tests
const D_LOW: u64 = 1_000_000_000; // 1 SOL
const D_MID: u64 = 10_000_000_000; // 10 SOL
const D_HIGH: u64 = 100_000_000_000; // 100 SOL
const EXPO_BP: u64 = 100; // 1%
const EPOCH_LENGTH: u64 = 1_000; // slots per withdrawal epoch (test scale)
fn window() -> u64 { hm::SMOOTH_WINDOW_SLOTS }

// -------------------- tx plumbing --------------------

fn try_send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let bh = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &bh);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("err={:?} logs={:#?}", e.err, e.meta.logs))
}
fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair, signers: &[&Keypair]) -> bool {
    try_send(svm, ix, payer, signers).is_ok()
}
fn pid() -> Pubkey { house::id() }
fn boot() -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.add_program(pid(), include_bytes!("../../../target/deploy/house.so")).unwrap();
    svm
}
fn funded(svm: &mut LiteSVM) -> Keypair {
    let kp = Keypair::new();
    svm.airdrop(&kp.pubkey(), 500_000_000_000).unwrap(); // 500 SOL
    kp
}
fn lamports(svm: &LiteSVM, k: &Pubkey) -> u64 { svm.get_account(k).map(|a| a.lamports).unwrap_or(0) }

// -------------------- PDAs --------------------

fn config_pda() -> Pubkey { Pubkey::find_program_address(&[b"house-config"], &pid()).0 }
fn machine_pda(id: &[u8; 16]) -> Pubkey { Pubkey::find_program_address(&[b"machine", id.as_ref()], &pid()).0 }
fn lp_pda(machine: &Pubkey, owner: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"lp", machine.as_ref(), owner.as_ref()], &pid()).0
}
fn spin_pda(machine: &Pubkey, player: &Pubkey, nonce: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"spin", machine.as_ref(), player.as_ref(), &nonce.to_le_bytes()], &pid()).0
}
fn mock_pda(id: &[u8; 16]) -> Pubkey { Pubkey::find_program_address(&[b"mock-rand", id.as_ref()], &pid()).0 }

// -------------------- instruction builders --------------------

fn ix_init(admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::InitializeHouseConfig { admin: *admin }.data(),
        house::accounts::InitializeHouseConfig { config: config_pda(), payer: *admin, system_program: system_program::ID }
            .to_account_metas(None),
    )
}
#[allow(clippy::too_many_arguments)]
fn ix_create(id: [u8; 16], admin: &Pubkey, curator: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::CreateMachine {
            machine_id: id, d_low: D_LOW, d_mid: D_MID, d_high: D_HIGH,
            max_exposure_bp: EXPO_BP, smooth_window: window(), epoch_length: EPOCH_LENGTH, curator,
        }.data(),
        house::accounts::CreateMachine { config: config_pda(), machine: machine_pda(&id), admin: *admin, system_program: system_program::ID }
            .to_account_metas(None),
    )
}
fn ix_set_paused(id: [u8; 16], curator: &Pubkey, paused: bool) -> Instruction {
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::SetPaused { paused }.data(),
        house::accounts::SetPaused { machine: machine_pda(&id), curator: *curator }.to_account_metas(None),
    )
}
fn ix_deposit(id: [u8; 16], owner: &Pubkey, amount: u64) -> Instruction {
    let m = machine_pda(&id);
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::LpDeposit { amount }.data(),
        house::accounts::LpDeposit { machine: m, position: lp_pda(&m, owner), owner: *owner, system_program: system_program::ID }
            .to_account_metas(None),
    )
}
fn ix_commit(id: [u8; 16], player: &Pubkey, randomness: Pubkey, wager: u64, nonce: u64) -> Instruction {
    let m = machine_pda(&id);
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::SpinCommit { wager, nonce }.data(),
        house::accounts::SpinCommit {
            machine: m, pending_spin: spin_pda(&m, player, nonce), player: *player,
            randomness, system_program: system_program::ID,
        }.to_account_metas(None),
    )
}
fn ix_settle(id: [u8; 16], player: &Pubkey, randomness: Pubkey, nonce: u64, cranker: &Pubkey) -> Instruction {
    let m = machine_pda(&id);
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::SpinSettle { nonce }.data(),
        house::accounts::SpinSettle {
            machine: m, pending_spin: spin_pda(&m, player, nonce), player: *player,
            randomness, cranker: *cranker, system_program: system_program::ID,
        }.to_account_metas(None),
    )
}
fn ix_expire(id: [u8; 16], player: &Pubkey, nonce: u64, cranker: &Pubkey) -> Instruction {
    let m = machine_pda(&id);
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::SpinExpire { nonce }.data(),
        house::accounts::SpinExpire {
            machine: m, pending_spin: spin_pda(&m, player, nonce), player: *player,
            cranker: *cranker, system_program: system_program::ID,
        }.to_account_metas(None),
    )
}
fn ix_fill(id: [u8; 16], authority: &Pubkey, bytes: [u8; 32]) -> Instruction {
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::MockFillRandomness { id, bytes }.data(),
        house::accounts::MockFillRandomness { randomness: mock_pda(&id), authority: *authority, system_program: system_program::ID }
            .to_account_metas(None),
    )
}
fn ix_request_withdraw(id: [u8; 16], owner: &Pubkey, shares: u128) -> Instruction {
    let m = machine_pda(&id);
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::RequestWithdraw { shares }.data(),
        house::accounts::RequestWithdraw { machine: m, position: lp_pda(&m, owner), owner: *owner }.to_account_metas(None),
    )
}
fn ix_cancel_withdraw(id: [u8; 16], owner: &Pubkey) -> Instruction {
    let m = machine_pda(&id);
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::CancelWithdraw {}.data(),
        house::accounts::CancelWithdraw { machine: m, position: lp_pda(&m, owner), owner: *owner }.to_account_metas(None),
    )
}
fn ix_process(id: [u8; 16], owner: &Pubkey, cranker: &Pubkey) -> Instruction {
    let m = machine_pda(&id);
    Instruction::new_with_bytes(
        pid(),
        &house::instruction::ProcessWithdrawals {}.data(),
        house::accounts::ProcessWithdrawals {
            machine: m, position: lp_pda(&m, owner), owner: *owner, cranker: *cranker, system_program: system_program::ID,
        }.to_account_metas(None),
    )
}
fn position_closed(svm: &LiteSVM, machine: &Pubkey, owner: &Pubkey) -> bool {
    lamports(svm, &lp_pda(machine, owner)) == 0
}

// -------------------- account readers --------------------

fn read_machine(svm: &LiteSVM, id: &[u8; 16]) -> house::Machine {
    let a = svm.get_account(&machine_pda(id)).unwrap();
    house::Machine::try_deserialize(&mut &a.data[..]).unwrap()
}
fn read_position(svm: &LiteSVM, machine: &Pubkey, owner: &Pubkey) -> house::LpPosition {
    let a = svm.get_account(&lp_pda(machine, owner)).unwrap();
    house::LpPosition::try_deserialize(&mut &a.data[..]).unwrap()
}
fn read_spin(svm: &LiteSVM, machine: &Pubkey, player: &Pubkey, nonce: u64) -> house::PendingSpin {
    let a = svm.get_account(&spin_pda(machine, player, nonce)).unwrap();
    house::PendingSpin::try_deserialize(&mut &a.data[..]).unwrap()
}
fn spin_closed(svm: &LiteSVM, machine: &Pubkey, player: &Pubkey, nonce: u64) -> bool {
    lamports(svm, &spin_pda(machine, player, nonce)) == 0
}

// -------------------- house-math mirrors (the single source of truth) --------------------

/// Snapshot the program will compute for a FULLY CONVERGED machine at `depth`.
/// Returns (is_deep, k_bp, max_bet).
fn converged_snapshot(depth: u128) -> (bool, u128, u128) {
    let is_deep = depth >= D_MID as u128;
    let tier = if is_deep { &hm::DEEP } else { &hm::SHALLOW };
    let (kmin, kmax) = hm::k_bounds_const(is_deep);
    let k = hm::k_of_depth(depth, D_LOW as u128, D_HIGH as u128, kmin, kmax);
    let max_bet = hm::max_bet(depth, EXPO_BP as u128, tier, k);
    (is_deep, k, max_bet)
}
fn tier_of(is_deep: bool) -> &'static hm::Tier { if is_deep { &hm::DEEP } else { &hm::SHALLOW } }

/// Mirror of the program's process_withdrawals share/lamport math for the FIRST
/// crank of an epoch (SCALE-2 conservative snapshot). Prices at
/// `(pool − reserved)/total` frozen for the epoch; the fill is capped by current
/// free. Returns (fill_shares, payout). For later cranks in the SAME epoch, pass the
/// FROZEN price to `process_at_snapshot` instead.
fn expected_process(pool: u128, reserved: u128, total: u128, pending: u128) -> (u128, u128) {
    let free = pool.saturating_sub(reserved);
    let snap = hm::snapshot::snapshot_price(free, total);
    process_at_snapshot(pool, reserved, pending, snap)
}
/// Mirror at an already-frozen snapshot price (any crank of the epoch).
fn process_at_snapshot(pool: u128, reserved: u128, pending: u128, snap: u128) -> (u128, u128) {
    let free = pool.saturating_sub(reserved);
    let fill = hm::snapshot::fill_shares(pending, free, snap);
    (fill, hm::snapshot::payout(fill, snap))
}

/// Boot an initialized machine funded to `pool` lamports, warped past the
/// smoothing window so the next commit's snapshot reads smoothed == pool.
/// Returns (svm, machine_id, admin, curator, lp).
fn boot_converged(seed: u8, pool: u64) -> (LiteSVM, [u8; 16], Keypair, Keypair, Keypair) {
    let mut svm = boot();
    let admin = funded(&mut svm);
    let curator = funded(&mut svm);
    let lp = funded(&mut svm);
    let id = [seed; 16];
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_create(id, &admin.pubkey(), curator.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_deposit(id, &lp.pubkey(), pool), &lp, &[&lp]));
    svm.warp_to_slot(window() * 3); // converge smoothing on the next commit
    (svm, id, admin, curator, lp)
}

// ============================================================================
// (a) happy spin — exact reconciliation of pool_value, player, vault vs house-math
// ============================================================================
#[test]
fn a_happy_spin_reconciles_exactly() {
    let pool = 50_000_000_000; // 50 SOL -> DEEP
    let (mut svm, id, _admin, _cur, _lp) = boot_converged(0xA1, pool);
    let m = machine_pda(&id);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);

    let (is_deep, k, max_bet) = converged_snapshot(pool as u128);
    let wager = (max_bet / 2) as u64;
    // 1 cherry (indices: 13=CHERRY, 22/23=BLANK) -> a net house win, payout < wager, payout > 0
    let bytes = { let mut b = [0u8; 32]; b[0] = 13; b[1] = 22; b[2] = 23; b };
    let reels = hm::reels_from_randomness(&bytes);
    let expected_payout = u64::try_from(hm::spin_payout(wager as u128, tier_of(is_deep), k, reels)).unwrap();
    assert!(expected_payout > 0 && expected_payout < wager, "want a nonzero house-win outcome");

    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));

    // snapshot recorded exactly what house-math predicts
    let s = read_spin(&svm, &m, &player.pubkey(), 0);
    assert_eq!(s.k_bp, k, "snapshot k");
    assert_eq!(s.tier_is_deep, is_deep, "snapshot tier");
    let mach = read_machine(&svm, &id);
    assert_eq!(mach.reserved_exposure, s.max_payout, "reserve == snapshot max_payout");
    assert_eq!(mach.pool_value, pool, "commit must NOT credit pool_value");

    // reconcile the settle
    let vault_before = lamports(&svm, &m);
    let player_before = lamports(&svm, &player.pubkey());
    let spin_rent = lamports(&svm, &spin_pda(&m, &player.pubkey(), 0));

    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));

    let mach2 = read_machine(&svm, &id);
    assert_eq!(mach2.pool_value, pool + wager - expected_payout, "pool_value += wager - payout");
    assert_eq!(mach2.reserved_exposure, 0, "reserve fully released");
    assert_eq!(vault_before - lamports(&svm, &m), expected_payout, "vault debited exactly the payout");
    assert_eq!(lamports(&svm, &player.pubkey()) - player_before, expected_payout + spin_rent, "player += payout + spin rent");
    assert!(spin_closed(&svm, &m, &player.pubkey(), 0), "spin closed");
}

// ============================================================================
// (b) crafted JACKPOT^3 — payout equals snapshot max_payout, reserves release
// ============================================================================
#[test]
fn b_jackpot_pays_exactly_max_payout() {
    let pool = 60_000_000_000; // DEEP
    let (mut svm, id, _a, _c, _lp) = boot_converged(0xB2, pool);
    let m = machine_pda(&id);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);

    let (_is_deep, _k, max_bet) = converged_snapshot(pool as u128);
    let wager = max_bet as u64; // bet the boundary
    let bytes = [0u8; 32]; // STRIP[0]=JACKPOT on every reel -> JACKPOT^3

    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    let s = read_spin(&svm, &m, &player.pubkey(), 0);

    let vault_before = lamports(&svm, &m);
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));

    // the jackpot is the max outcome: payout == the escrowed reserve exactly
    assert_eq!(vault_before - lamports(&svm, &m), s.max_payout, "jackpot pays exactly max_payout");
    let mach = read_machine(&svm, &id);
    assert_eq!(mach.reserved_exposure, 0, "reserve released after jackpot");
    assert_eq!(mach.pool_value, pool + wager - s.max_payout, "pool_value folds the (negative) net edge");
}

// ============================================================================
// (c) max_bet boundary — both sides
// ============================================================================
#[test]
fn c_max_bet_boundary_both_sides() {
    let pool = 40_000_000_000;
    let (mut svm, id, _a, _c, _lp) = boot_converged(0xC3, pool);
    let player = funded(&mut svm);
    let (_d, _k, max_bet) = converged_snapshot(pool as u128);
    let max_bet = max_bet as u64;

    // exactly max_bet: allowed
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), Pubkey::new_unique(), max_bet, 0), &player, &[&player]));
    // max_bet + 1: rejected (smoothing unchanged at the same slot => identical bound)
    let err = try_send(&mut svm, ix_commit(id, &player.pubkey(), Pubkey::new_unique(), max_bet + 1, 1), &player, &[&player]).unwrap_err();
    assert!(err.contains("BetExceedsMax"), "expected BetExceedsMax, got {err}");
}

// ============================================================================
// (d) k-snapshot honored when pool state changes between commit and settle
// ============================================================================
#[test]
fn d_k_snapshot_survives_pool_change() {
    let pool = 2_000_000_000; // 2 SOL -> SHALLOW, cold (k near k_max)
    let (mut svm, id, _a, _c, lp) = boot_converged(0xD4, pool);
    let m = machine_pda(&id);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);

    let (is_deep, k1, max_bet) = converged_snapshot(pool as u128);
    assert!(!is_deep, "start shallow");
    let wager = (max_bet / 2) as u64;
    // 3 cherries (13=CHERRY) — an outcome whose payout depends on k and tier
    let bytes = { let mut b = [0u8; 32]; b[0] = 13; b[1] = 13; b[2] = 13; b };
    let reels = hm::reels_from_randomness(&bytes);

    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    let s = read_spin(&svm, &m, &player.pubkey(), 0);
    assert_eq!(s.k_bp, k1);

    // pool state changes drastically before settle: a whale deposits 300 SOL
    assert!(send(&mut svm, ix_deposit(id, &lp.pubkey(), 300_000_000_000), &lp, &[&lp]));
    let now_pool = read_machine(&svm, &id).pool_value as u128; // 302 SOL -> DEEP, k_min

    let payout_snapshot = u64::try_from(hm::spin_payout(wager as u128, tier_of(is_deep), k1, reels)).unwrap();
    // what a (wrongly) re-priced settle at current state would pay — must differ
    let (now_deep, now_k, _) = converged_snapshot(now_pool);
    let payout_if_repriced = u64::try_from(hm::spin_payout(wager as u128, tier_of(now_deep), now_k, reels)).unwrap();
    assert_ne!(payout_snapshot, payout_if_repriced, "test is only meaningful if the two differ");

    let vault_before = lamports(&svm, &m);
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));
    // settle honored the SNAPSHOT k/tier, not current state
    assert_eq!(vault_before - lamports(&svm, &m), payout_snapshot, "paid the snapshot payout, not the re-priced one");
}

// ============================================================================
// (e) expiry refund
// ============================================================================
#[test]
fn e_expiry_refunds_and_releases() {
    let pool = 30_000_000_000;
    let (mut svm, id, _a, _c, _lp) = boot_converged(0xE5, pool);
    let m = machine_pda(&id);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    let (_d, _k, max_bet) = converged_snapshot(pool as u128);
    let wager = (max_bet / 2) as u64;

    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    let reserved = read_machine(&svm, &id).reserved_exposure;
    assert!(reserved > 0);

    // settle cannot succeed (randomness never resolved), and expire is premature
    assert!(!send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));
    svm.expire_blockhash();
    let err = try_send(&mut svm, ix_expire(id, &player.pubkey(), 0, &cranker.pubkey()), &cranker, &[&cranker]).unwrap_err();
    assert!(err.contains("SpinNotExpired"), "premature expire must fail, got {err}");

    // warp past the expiry window and crank expire (fresh blockhash so the
    // now-valid expire isn't deduped against the premature attempt above)
    svm.warp_to_slot(window() * 3 + house::EXPIRE_SLOTS + 10);
    svm.expire_blockhash();
    let vault_before = lamports(&svm, &m);
    let player_before = lamports(&svm, &player.pubkey());
    let spin_rent = lamports(&svm, &spin_pda(&m, &player.pubkey(), 0));
    let pool_before = read_machine(&svm, &id).pool_value;

    assert!(send(&mut svm, ix_expire(id, &player.pubkey(), 0, &cranker.pubkey()), &cranker, &[&cranker]));

    assert_eq!(vault_before - lamports(&svm, &m), wager, "vault refunds exactly the wager");
    assert_eq!(lamports(&svm, &player.pubkey()) - player_before, wager + spin_rent, "player += wager + spin rent");
    let mach = read_machine(&svm, &id);
    assert_eq!(mach.reserved_exposure, 0, "reserve released on expiry");
    assert_eq!(mach.pool_value, pool_before, "no edge taken on expiry");
    assert!(spin_closed(&svm, &m, &player.pubkey(), 0), "spin closed");
}

// ============================================================================
// (f) smoothing on-chain — snapshot k reflects SMOOTHED, not spot, depth
// ============================================================================
#[test]
fn f_commit_snapshot_uses_smoothed_depth() {
    let mut svm = boot();
    let admin = funded(&mut svm);
    let curator = funded(&mut svm);
    let lp = funded(&mut svm);
    let player = funded(&mut svm);
    let id = [0xF6; 16];
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_create(id, &admin.pubkey(), curator.pubkey()), &admin, &[&admin]));
    let m = machine_pda(&id);

    // small deposit, converge, and a first commit to seat smoothed == A
    let a_pool: u64 = 2_000_000_000; // 2 SOL, SHALLOW
    assert!(send(&mut svm, ix_deposit(id, &lp.pubkey(), a_pool), &lp, &[&lp]));
    let base_slot = window() * 2;
    svm.warp_to_slot(base_slot);
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), Pubkey::new_unique(), 1_000, 0), &player, &[&player]));
    let mach = read_machine(&svm, &id);
    assert_eq!(mach.smoothed_value, a_pool as u128, "smoothed seated at A");
    assert_eq!(mach.smoothed_last_slot, base_slot);

    // whale deposit, then a commit ONE slot later
    assert!(send(&mut svm, ix_deposit(id, &lp.pubkey(), 300_000_000_000), &lp, &[&lp]));
    let spot = read_machine(&svm, &id).pool_value as u128; // 302 SOL
    svm.warp_to_slot(base_slot + 1);
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), Pubkey::new_unique(), 1_000, 1), &player, &[&player]));
    let s = read_spin(&svm, &m, &player.pubkey(), 1);

    // reproduce the on-chain smoothing with house-math and assert the snapshot matches it
    let mut sd = hm::SmoothedDepth { value: a_pool as u128, last_slot: base_slot };
    let smoothed = sd.update(spot, base_slot + 1, window());
    let (sm_deep, sm_k, _) = converged_snapshot(smoothed);
    assert_eq!(s.tier_is_deep, sm_deep, "tier from smoothed depth");
    assert_eq!(s.k_bp, sm_k, "k from smoothed depth");

    // and that this is NOT the spot answer (smoothed stays SHALLOW/cold; spot is DEEP/floor)
    let (spot_deep, spot_k, _) = converged_snapshot(spot);
    assert!(spot_deep && !sm_deep, "spot is DEEP, smoothed still SHALLOW");
    assert_ne!(s.k_bp, spot_k, "snapshot k must not be the spot k");
}

// ============================================================================
// (g) share minting — 1:1 first, then at a drifted price, exact lamports
// ============================================================================
#[test]
fn g_share_minting_first_and_drifted() {
    let mut svm = boot();
    let admin = funded(&mut svm);
    let curator = funded(&mut svm);
    let lp1 = funded(&mut svm);
    let lp2 = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    let id = [0x67; 16];
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_create(id, &admin.pubkey(), curator.pubkey()), &admin, &[&admin]));
    let m = machine_pda(&id);

    // first deposit: 1:1 at 1e6 scale
    let a: u64 = 20_000_000_000; // 20 SOL -> DEEP
    assert!(send(&mut svm, ix_deposit(id, &lp1.pubkey(), a), &lp1, &[&lp1]));
    let pos1 = read_position(&svm, &m, &lp1.pubkey());
    assert_eq!(pos1.shares, a as u128 * house::SHARE_SCALE, "first deposit mints amount * 1e6");
    let mach = read_machine(&svm, &id);
    assert_eq!(mach.total_shares, a as u128 * house::SHARE_SCALE);
    assert_eq!(mach.pool_value, a);

    // drift the price up: a losing spin (3 blanks -> payout 0) accrues the wager to the pool
    svm.warp_to_slot(window() * 3);
    let (_d, _k, max_bet) = converged_snapshot(a as u128);
    let wager = (max_bet / 2) as u64;
    let blanks = { let mut b = [0u8; 32]; b[0] = 22; b[1] = 23; b[2] = 24; b }; // all BLANK
    assert_eq!(hm::reels_from_randomness(&blanks), [hm::BLANK, hm::BLANK, hm::BLANK]);
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), blanks), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));

    let mach2 = read_machine(&svm, &id);
    assert_eq!(mach2.pool_value, a + wager, "losing spin accrues wager to the pool");
    assert_eq!(mach2.total_shares, a as u128 * house::SHARE_SCALE, "spins never mint shares");

    // drifted deposit: shares = amount * total_shares / pool_value, exact
    let b: u64 = 5_000_000_000; // 5 SOL
    assert!(send(&mut svm, ix_deposit(id, &lp2.pubkey(), b), &lp2, &[&lp2]));
    let expected = b as u128 * mach2.total_shares / mach2.pool_value as u128;
    let pos2 = read_position(&svm, &m, &lp2.pubkey());
    assert_eq!(pos2.shares, expected, "drifted-price shares are exact");
    assert!(pos2.shares < b as u128 * house::SHARE_SCALE, "drifted price mints fewer shares than 1:1");
    let mach3 = read_machine(&svm, &id);
    assert_eq!(mach3.pool_value, a + wager + b, "pool_value tracks deposits + edge to the lamport");
}

// ============================================================================
// (h) pause blocks commits, never settle/expire
// ============================================================================
#[test]
fn h_pause_blocks_commit_only() {
    let pool = 30_000_000_000;
    let (mut svm, id, _a, curator, _lp) = boot_converged(0x88, pool);
    let m = machine_pda(&id);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    let (_d, _k, max_bet) = converged_snapshot(pool as u128);
    let wager = (max_bet / 4) as u64;

    // two spins committed before pausing; fill randomness for spin 0
    let bytes = { let mut b = [0u8; 32]; b[0] = 22; b[1] = 23; b[2] = 24; b }; // losing, payout 0
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), Pubkey::new_unique(), wager, 1), &player, &[&player]));

    // a non-curator cannot pause
    let rando = funded(&mut svm);
    let err = try_send(&mut svm, ix_set_paused(id, &rando.pubkey(), true), &rando, &[&rando]).unwrap_err();
    assert!(err.contains("NotCurator"), "expected NotCurator, got {err}");

    // curator pauses
    assert!(send(&mut svm, ix_set_paused(id, &curator.pubkey(), true), &curator, &[&curator]));
    assert!(read_machine(&svm, &id).paused);

    // new commits are blocked
    let err = try_send(&mut svm, ix_commit(id, &player.pubkey(), Pubkey::new_unique(), wager, 2), &player, &[&player]).unwrap_err();
    assert!(err.contains("MachinePaused"), "commit must be blocked while paused, got {err}");

    // but settle of spin 0 still works while paused
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]),
        "settle must never be blocked by pause");

    // and expire of spin 1 still works while paused (after the window)
    svm.warp_to_slot(window() * 3 + house::EXPIRE_SLOTS + 10);
    assert!(send(&mut svm, ix_expire(id, &player.pubkey(), 1, &cranker.pubkey()), &cranker, &[&cranker]),
        "expire must never be blocked by pause");
    assert!(spin_closed(&svm, &m, &player.pubkey(), 1));
}

// ============================================================================
// (cold-start fix) a fresh machine offers full max_bet immediately after
// seeding — smoothed depth is initialized to the founding bankroll, not zero.
// ============================================================================
#[test]
fn coldstart_fresh_machine_has_full_max_bet() {
    let mut svm = boot();
    let admin = funded(&mut svm);
    let curator = funded(&mut svm);
    let lp = funded(&mut svm);
    let player = funded(&mut svm);
    let id = [0xC0; 16];
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));
    // production-scale smoothing window (ix_create uses window() = 9000)
    assert!(send(&mut svm, ix_create(id, &admin.pubkey(), curator.pubkey()), &admin, &[&admin]));
    let m = machine_pda(&id);

    let pool = 50_000_000_000u64; // 50 SOL -> DEEP
    assert!(send(&mut svm, ix_deposit(id, &lp.pubkey(), pool), &lp, &[&lp]));
    // the founding deposit seats smoothed depth at the pool, NOT zero
    assert_eq!(read_machine(&svm, &id).smoothed_value, pool as u128, "smoothed seeded to founding bankroll");

    // only a handful of slots later (far inside the window) the snapshot already
    // reads full depth: a max-bet-sized wager is accepted right away.
    svm.warp_to_slot(50);
    let (_d, _k, max_bet) = converged_snapshot(pool as u128);
    let player2 = &player;
    assert!(send(&mut svm, ix_commit(id, &player2.pubkey(), Pubkey::new_unique(), max_bet as u64, 0), player2, &[player2]),
        "fresh machine must accept a full max_bet wager without waiting a window");
    let s = read_spin(&svm, &m, &player2.pubkey(), 0);
    // snapshot equals the CONVERGED (full-depth) snapshot, not a near-zero one
    assert_eq!(s.k_bp, _k);
    assert_eq!(s.tier_is_deep, _d);
}

// helpers for the withdrawal matrix — all machines start at slot 27000 (epoch
// 27000/1000 = 27) via boot_converged; requests stamp epoch 27.
const E0_SLOT: u64 = 27_000;
const E1_SLOT: u64 = 28_000; // epoch 28

// ============================================================================
// (w-a) SCALE-2 UPDATE. Was "full withdrawal while a spin is pending → partial
// fill capped by free, remainder queued". Under the conservative snapshot the free
// cap no longer forces a partial fill: the exit is priced at (pool − reserved)/total,
// and free at that price covers exactly all shares, so the LP FULLY exits in one
// crank at the conservative price, leaving the reserved in the pool for STAYERS. The
// core invariant (reserved untouched by the withdrawal) is unchanged. Justification:
// price-at-processing / partial-fill were the asserted behaviors that SCALE-2 revises.
// ============================================================================
#[test]
fn w_a_reserved_untouched_during_pending_spin() {
    let pool = 50_000_000_000u64; // per LP
    let (mut svm, id, _a, _c, lp_out) = boot_converged(0xE1, pool);
    let m = machine_pda(&id);
    let lp_stay = funded(&mut svm); // an equal LP who does NOT withdraw
    assert!(send(&mut svm, ix_deposit(id, &lp_stay.pubkey(), pool), &lp_stay, &[&lp_stay]));
    let total_pool = 2 * pool;
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);

    // a pending spin reserves exposure (a HOUSE-WIN outcome — the reserve is never
    // actually needed, so its full value becomes surplus for stayers).
    let (is_deep, k, max_bet) = converged_snapshot(total_pool as u128);
    let wager = (max_bet / 2) as u64;
    let bytes = { let mut b = [0u8; 32]; b[0] = 13; b[1] = 22; b[2] = 23; b }; // 1 cherry
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    let reserved = read_machine(&svm, &id).reserved_exposure;
    assert!(reserved > 0);

    // lp_out requests a full exit, processed WHILE the spin is pending.
    let shares = read_position(&svm, &m, &lp_out.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp_out.pubkey(), shares), &lp_out, &[&lp_out]));
    svm.warp_to_slot(E1_SLOT);
    let vault_before = lamports(&svm, &m); // vault delta == payout (no rent/fee pollution)
    assert!(send(&mut svm, ix_process(id, &lp_out.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));

    // reserved untouched; lp_out FULLY exits (no partial fill) at the CONSERVATIVE
    // snapshot — below its naive share value (pool), because the pending reserve is
    // deducted from the price. Reconciled against the machine's stored frozen price.
    let snap = read_machine(&svm, &id).withdraw_snapshot_price;
    let payout = hm::snapshot::payout(shares, snap);
    assert_eq!(read_machine(&svm, &id).reserved_exposure, reserved, "reserved exposure untouched by withdrawal");
    assert!(position_closed(&svm, &m, &lp_out.pubkey()), "fully filled in one crank at the conservative price — position closed");
    assert_eq!(vault_before - lamports(&svm, &m), payout as u64, "lp_out exits at the conservative snapshot");
    assert!(payout < pool as u128, "priced below the naive pool value — the pending reserve is deducted");

    // the spin settles (house win) — reserve releases into the pool.
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));
    assert_eq!(read_machine(&svm, &id).reserved_exposure, 0);

    // CONSERVATISM FAVORS STAYERS: lp_stay never withdrew, and its position is now
    // worth MORE than its deposit — it captured the reserve surplus lp_out left behind
    // plus the house-win edge.
    let mf = read_machine(&svm, &id);
    let stay_sh = read_position(&svm, &m, &lp_stay.pubkey()).shares;
    let stay_value = stay_sh * mf.pool_value as u128 / mf.total_shares;
    assert!(stay_value > pool as u128, "the staying LP's position grew: {stay_value} > {pool}");
}

// ============================================================================
// (w-b) jackpot between request and processing — LP eats the share-price drop
// (priced at processing, not request).
// ============================================================================
#[test]
fn w_b_lp_eats_price_drop_from_jackpot() {
    let pool = 50_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xE2, pool);
    let m = machine_pda(&id);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);

    let shares = read_position(&svm, &m, &lp.pubkey()).shares;
    let request_time_value = shares * pool as u128 / read_machine(&svm, &id).total_shares; // == pool
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares), &lp, &[&lp]));

    // JACKPOT^3 lands (player wins max_payout) — pool drops
    let (_d, _k, max_bet) = converged_snapshot(pool as u128);
    let wager = (max_bet / 2) as u64;
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));
    let pool2 = read_machine(&svm, &id).pool_value;
    assert!((pool2 as u128) < request_time_value, "jackpot dropped the pool");

    // process at the LOWER (processing-time) price
    let mb = read_machine(&svm, &id);
    let (_f, payout) = expected_process(mb.pool_value as u128, 0, mb.total_shares, shares);
    svm.warp_to_slot(E1_SLOT);
    let vault_before = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
    // vault delta isolates the payout from the LpPosition rent returned on close
    assert_eq!(vault_before - lamports(&svm, &m), payout as u64, "priced at processing time");
    assert_eq!(payout, pool2 as u128, "sole LP receives the post-jackpot pool exactly");
    assert!(payout < request_time_value, "LP ate the drop — anti-pool-hopping");
    assert!(position_closed(&svm, &m, &lp.pubkey()));
}

// ============================================================================
// (w-c) pool grows between request and processing — LP gains (same mechanism).
// ============================================================================
#[test]
fn w_c_lp_gains_from_pool_growth() {
    let pool = 50_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xE3, pool);
    let m = machine_pda(&id);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);

    let shares = read_position(&svm, &m, &lp.pubkey()).shares;
    let request_time_value = shares * pool as u128 / read_machine(&svm, &id).total_shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares), &lp, &[&lp]));

    // a losing spin (3 blanks) grows the pool by the full wager
    let (_d, _k, max_bet) = converged_snapshot(pool as u128);
    let wager = (max_bet / 2) as u64;
    let blanks = { let mut b = [0u8; 32]; b[0] = 22; b[1] = 23; b[2] = 24; b };
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), blanks), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));
    let pool2 = read_machine(&svm, &id).pool_value;
    assert_eq!(pool2, pool + wager, "losing spin grew the pool");

    let mb = read_machine(&svm, &id);
    let (_f, payout) = expected_process(mb.pool_value as u128, 0, mb.total_shares, shares);
    svm.warp_to_slot(E1_SLOT);
    let vault_before = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
    assert_eq!(vault_before - lamports(&svm, &m), payout as u64);
    assert!(payout > request_time_value, "LP gained the edge accrued after the request");
    assert_eq!(payout, pool2 as u128, "sole LP receives the grown pool exactly");
}

// ============================================================================
// (w-d) two LPs same epoch — order honored, second fill priced after the first.
// ============================================================================
#[test]
fn w_d_two_lps_sequential_pricing() {
    let pool = 40_000_000_000u64;
    let (mut svm, id, _a, _c, lp1) = boot_converged(0xE4, pool);
    let m = machine_pda(&id);
    let lp2 = funded(&mut svm);
    let cranker = funded(&mut svm);
    // second LP deposits the same amount in the same epoch
    assert!(send(&mut svm, ix_deposit(id, &lp2.pubkey(), pool), &lp2, &[&lp2]));

    let s1 = read_position(&svm, &m, &lp1.pubkey()).shares;
    let s2 = read_position(&svm, &m, &lp2.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp1.pubkey(), s1), &lp1, &[&lp1]));
    assert!(send(&mut svm, ix_request_withdraw(id, &lp2.pubkey(), s2), &lp2, &[&lp2]));

    svm.warp_to_slot(E1_SLOT);
    // process lp1 first
    let m1 = read_machine(&svm, &id);
    let (_f1, pay1) = expected_process(m1.pool_value as u128, 0, m1.total_shares, s1);
    let v1 = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp1.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
    assert_eq!(v1 - lamports(&svm, &m), pay1 as u64);

    // lp2 priced at the state LEFT BY lp1 (read machine after lp1's fill)
    let m2 = read_machine(&svm, &id);
    let (_f2, pay2) = expected_process(m2.pool_value as u128, 0, m2.total_shares, s2);
    let v2 = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp2.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
    assert_eq!(v2 - lamports(&svm, &m), pay2 as u64, "second fill priced after the first");
    // both equal LPs recover ~their deposit; pool fully drained
    assert_eq!(read_machine(&svm, &id).pool_value, 0);
}

// ============================================================================
// (w-e) withdrawal to exactly zero shares closes cleanly (rent back to owner).
// ============================================================================
#[test]
fn w_e_full_withdraw_closes_position() {
    let pool = 30_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xE5, pool);
    let m = machine_pda(&id);
    let cranker = funded(&mut svm);
    let shares = read_position(&svm, &m, &lp.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares), &lp, &[&lp]));

    svm.warp_to_slot(E1_SLOT);
    let pos_rent = lamports(&svm, &lp_pda(&m, &lp.pubkey()));
    let lp_before = lamports(&svm, &lp.pubkey());
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
    // sole LP, no spins: payout == pool; plus the position rent on close
    assert_eq!(lamports(&svm, &lp.pubkey()) - lp_before, pool + pos_rent, "payout + reclaimed rent");
    assert!(position_closed(&svm, &m, &lp.pubkey()));
}

// ============================================================================
// (w-f) a request in epoch N cannot process in epoch N — must cross a boundary.
// ============================================================================
#[test]
fn w_f_epoch_boundary_enforced() {
    let pool = 20_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xE6, pool);
    let m = machine_pda(&id);
    let cranker = funded(&mut svm);
    let shares = read_position(&svm, &m, &lp.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares), &lp, &[&lp]));

    // same epoch (slot 27000, epoch 27): rejected
    let err = try_send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]).unwrap_err();
    assert!(err.contains("EpochNotElapsed"), "same-epoch process must fail, got {err}");

    // after the boundary: allowed
    svm.warp_to_slot(E1_SLOT);
    svm.expire_blockhash();
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
}

// ============================================================================
// (w-g) cancel before processing restores shares exactly.
// ============================================================================
#[test]
fn w_g_cancel_restores_shares() {
    let pool = 20_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xE7, pool);
    let m = machine_pda(&id);
    let cranker = funded(&mut svm);
    let shares = read_position(&svm, &m, &lp.pubkey()).shares;

    // request a portion, then cancel
    let part = shares / 3;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), part), &lp, &[&lp]));
    let p = read_position(&svm, &m, &lp.pubkey());
    assert_eq!(p.shares, shares - part);
    assert_eq!(p.pending_shares, part);

    assert!(send(&mut svm, ix_cancel_withdraw(id, &lp.pubkey()), &lp, &[&lp]));
    let p = read_position(&svm, &m, &lp.pubkey());
    assert_eq!(p.shares, shares, "cancel restored shares exactly");
    assert_eq!(p.pending_shares, 0);

    // a cancelled request cannot be processed
    svm.warp_to_slot(E1_SLOT);
    assert!(!send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
}

// ============================================================================
// (w-h) books balance across a full lifecycle: seed -> spins (win + loss) ->
// partial withdraw -> more spins -> full withdraw. Every lamport accounted:
// the vault returns to rent-only and the pool empties.
// ============================================================================
#[test]
fn w_h_books_balance_full_lifecycle() {
    let mut svm = boot();
    let admin = funded(&mut svm);
    let curator = funded(&mut svm);
    let lp = funded(&mut svm);
    let cranker = funded(&mut svm);
    let id = [0xE8; 16];
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_create(id, &admin.pubkey(), curator.pubkey()), &admin, &[&admin]));
    let m = machine_pda(&id);
    let vault_rent = lamports(&svm, &m); // Machine PDA rent, before any deposit

    let pool = 40_000_000_000u64;
    assert!(send(&mut svm, ix_deposit(id, &lp.pubkey(), pool), &lp, &[&lp]));
    svm.warp_to_slot(E0_SLOT);

    // helper closure would need &mut svm borrow gymnastics; inline the spins.
    let (_d, _k, max_bet) = converged_snapshot(pool as u128);
    let wager = (max_bet / 4) as u64;

    // spin 1: a loss (3 blanks) — pool grows
    let p1 = funded(&mut svm);
    let blanks = { let mut b = [0u8; 32]; b[0] = 22; b[1] = 23; b[2] = 24; b };
    assert!(send(&mut svm, ix_fill(id, &p1.pubkey(), blanks), &p1, &[&p1]));
    assert!(send(&mut svm, ix_commit(id, &p1.pubkey(), mock_pda(&id), wager, 0), &p1, &[&p1]));
    assert!(send(&mut svm, ix_settle(id, &p1.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));

    // spin 2: a win (3 cherries) — pool shrinks
    let p2 = funded(&mut svm);
    let cherries = { let mut b = [0u8; 32]; b[0] = 13; b[1] = 13; b[2] = 13; b };
    assert!(send(&mut svm, ix_fill(id, &p2.pubkey(), cherries), &p2, &[&p2]));
    assert!(send(&mut svm, ix_commit(id, &p2.pubkey(), mock_pda(&id), wager, 1), &p2, &[&p2]));
    assert!(send(&mut svm, ix_settle(id, &p2.pubkey(), mock_pda(&id), 1, &cranker.pubkey()), &cranker, &[&cranker]));

    // partial withdraw (a third of shares)
    let shares = read_position(&svm, &m, &lp.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares / 3), &lp, &[&lp]));
    svm.warp_to_slot(E1_SLOT);
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));

    // one more spin (loss) after the partial withdraw
    let p3 = funded(&mut svm);
    assert!(send(&mut svm, ix_fill(id, &p3.pubkey(), blanks), &p3, &[&p3]));
    assert!(send(&mut svm, ix_commit(id, &p3.pubkey(), mock_pda(&id), wager, 2), &p3, &[&p3]));
    assert!(send(&mut svm, ix_settle(id, &p3.pubkey(), mock_pda(&id), 2, &cranker.pubkey()), &cranker, &[&cranker]));

    // full withdraw of the remainder
    let rest = read_position(&svm, &m, &lp.pubkey()).shares;
    svm.warp_to_slot(E1_SLOT + 2_000); // a later epoch
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), rest), &lp, &[&lp]));
    svm.warp_to_slot(E1_SLOT + 4_000);
    svm.expire_blockhash(); // this process ix is byte-identical to the partial one above
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));

    // books balance: the sole LP has withdrawn every share; the pool drains to at
    // most a few lamports of SCALE-2 snapshot flooring dust (which rounds TOWARD the
    // pool). Every lamport is still accounted — the vault holds exactly rent + that
    // dust, nothing is lost.
    assert!(position_closed(&svm, &m, &lp.pubkey()));
    let mf = read_machine(&svm, &id);
    assert_eq!(mf.total_shares, 0, "all shares burned");
    assert!(mf.pool_value <= 2, "pool drained to at most flooring dust: {}", mf.pool_value);
    assert_eq!(lamports(&svm, &m), vault_rent + mf.pool_value, "vault == rent + pool dust — books balance to the lamport");
}

// ============================================================================
// SCALE-1 analysis demonstrations (single-asset). See SCALE.md.
// ============================================================================

// (SCALE-2) WITHDRAWAL CRANK ORDERING — now FIXED by the per-epoch conservative
// snapshot. The exact scenario SCALE-1 proved unfair (scale_a of SCALE-1): two
// IDENTICAL LPs both queue full exits for the same epoch and a JACKPOT settles
// BETWEEN their two cranks, with an adversarial cranker (lp1) front-running its own
// exit + the settle + the victim's crank. Before: the later LP ate the entire net
// jackpot cost. Now: both are priced at the SAME frozen snapshot, so they receive
// IDENTICAL amounts to the lamport regardless of order — the jackpot's cost is in
// the SNAPSHOT (both exit lower), not dumped on whoever was cranked last. See
// SCALE.md §1b (MITIGATED) and house-math `snapshot`.
#[test]
fn scale_a_crank_order_is_now_price_identical() {
    let pool = 40_000_000_000u64; // each LP; 80 SOL total -> DEEP
    let (mut svm, id, _a, _c, lp1) = boot_converged(0xF1, pool);
    let m = machine_pda(&id);
    let lp2 = funded(&mut svm);
    assert!(send(&mut svm, ix_deposit(id, &lp2.pubkey(), pool), &lp2, &[&lp2]));
    let total_pool = 2 * pool;

    let s1 = read_position(&svm, &m, &lp1.pubkey()).shares;
    let s2 = read_position(&svm, &m, &lp2.pubkey()).shares;
    assert_eq!(s1, s2, "identical LPs hold identical shares");

    // a pending spin that WILL jackpot between the two cranks.
    let player = funded(&mut svm);
    let (is_deep, k, max_bet) = converged_snapshot(total_pool as u128);
    let wager = (max_bet / 2) as u64;
    let jack_reels = hm::reels_from_randomness(&[0u8; 32]);
    let max_payout = u64::try_from(hm::spin_payout(wager as u128, tier_of(is_deep), k, jack_reels)).unwrap();
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));

    assert!(send(&mut svm, ix_request_withdraw(id, &lp1.pubkey(), s1), &lp1, &[&lp1]));
    assert!(send(&mut svm, ix_request_withdraw(id, &lp2.pubkey(), s2), &lp2, &[&lp2]));
    svm.warp_to_slot(E1_SLOT);

    // crank #1: lp1 (also the cranker) processes itself first — freezes the epoch
    // snapshot at (pool − reserved)/total, priced conservatively for the pending jackpot.
    let v1 = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp1.pubkey(), &lp1.pubkey()), &lp1, &[&lp1]));
    let pay1 = v1 - lamports(&svm, &m);
    let snap = read_machine(&svm, &id).withdraw_snapshot_price;
    assert!(snap != 0, "snapshot frozen on the first crank");
    assert_eq!(pay1, hm::snapshot::payout(s1, snap) as u64, "lp1 paid at the frozen snapshot");
    assert!(position_closed(&svm, &m, &lp1.pubkey()), "lp1 fully filled at the conservative price");

    // the interleaved JACKPOT — the very move that used to dump the cost on lp2.
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &lp1.pubkey()), &lp1, &[&lp1]));

    // crank #2: lp2, SAME epoch → SAME frozen snapshot, despite the pool having moved.
    let v2 = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp2.pubkey(), &lp1.pubkey()), &lp1, &[&lp1]));
    let pay2 = v2 - lamports(&svm, &m);
    assert_eq!(read_machine(&svm, &id).withdraw_snapshot_price, snap, "same frozen snapshot in the same epoch");
    assert_eq!(pay2, hm::snapshot::payout(s2, snap) as u64, "lp2 paid at the SAME frozen snapshot");

    // THE FIX: identical requests, IDENTICAL payouts, regardless of the interleaved
    // jackpot or the processing order the cranker chose.
    assert_eq!(pay1, pay2, "order-independent to the lamport: {pay1} == {pay2}");
    // and each exits at the conservative price (below the naive pre-jackpot pool) —
    // the jackpot cost is shared via the snapshot, not dumped on the later LP.
    assert!((pay1 as u128) < pool as u128, "both exit at the conservative snapshot, sharing the pending-jackpot cost");
    let _ = max_payout;
}

// (scale-1) NO INDEFINITE STARVATION. The crank is permissionless and the payout
// always goes to `owner` regardless of who signs, so a hostile cranker that simply
// refuses to process a victim cannot starve them: the victim cranks ITSELF and is
// paid to the lamport. (Ordering can still shift interleaved variance — that is
// scale_a — but liveness is never at a third party's mercy.)
#[test]
fn scale_b_no_starvation_victim_self_cranks() {
    let pool = 30_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xF2, pool);
    let m = machine_pda(&id);
    let _griefer = funded(&mut svm); // exists, but never cranks the victim
    let shares = read_position(&svm, &m, &lp.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares), &lp, &[&lp]));
    svm.warp_to_slot(E1_SLOT);

    let pos_rent = lamports(&svm, &lp_pda(&m, &lp.pubkey()));
    let before = lamports(&svm, &lp.pubkey());
    // the victim is its OWN cranker — no third party needed.
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &lp.pubkey()), &lp, &[&lp]));
    let gained = lamports(&svm, &lp.pubkey()) as i128 - before as i128; // payout + rent - tx fee
    assert!(gained > (pool as i128) + (pos_rent as i128) - 100_000, "victim self-cranked and was paid: {gained}");
    assert!(position_closed(&svm, &m, &lp.pubkey()), "position closed on self-crank");
}

// (SCALE-2) MULTI-EPOCH: the snapshot invalidates at the epoch boundary, and a loss
// landing BETWEEN two withdrawal epochs lowers the NEXT epoch's exit price — the
// anti-pool-hopping property the conservative snapshot preserves. An LP can't lock in
// a request-time price and escape a subsequent loss.
#[test]
fn scale2_multi_epoch_snapshot_invalidates_and_preserves_anti_hopping() {
    let pool = 60_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xF5, pool);
    let m = machine_pda(&id);
    let cranker = funded(&mut svm);
    let player = funded(&mut svm);
    let shares = read_position(&svm, &m, &lp.pubkey()).shares;

    // withdraw HALF in epoch 28 → snapshot A (no pending spin ⇒ A = pool/total).
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares / 2), &lp, &[&lp]));
    svm.warp_to_slot(E1_SLOT);
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
    let ma = read_machine(&svm, &id);
    let (snap_a, epoch_a) = (ma.withdraw_snapshot_price, ma.withdraw_snapshot_epoch);
    assert!(snap_a != 0);

    // a JACKPOT lands and SETTLES (a realized loss) between the two withdrawal epochs.
    let (is_deep, k, max_bet) = converged_snapshot(ma.pool_value as u128);
    let wager = (max_bet / 2) as u64;
    let _ = (is_deep, k);
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), wager, 0), &player, &[&player]));
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &cranker.pubkey()), &cranker, &[&cranker]));

    // withdraw the REMAINDER in the NEXT epoch → snapshot recomputed at the lower pool.
    // (fresh blockhash: this request is byte-identical to the first one for shares/2.)
    let rest = read_position(&svm, &m, &lp.pubkey()).shares;
    svm.expire_blockhash();
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), rest), &lp, &[&lp]));
    svm.warp_to_slot(E1_SLOT + 1_000); // epoch 29
    svm.expire_blockhash();
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
    let mb = read_machine(&svm, &id);
    let (snap_b, epoch_b) = (mb.withdraw_snapshot_price, mb.withdraw_snapshot_epoch);

    assert!(epoch_b > epoch_a, "snapshot invalidated at the boundary (recomputed for the new epoch)");
    assert!(snap_b < snap_a, "the loss between epochs lowered the next exit price — no hopping: {snap_b} < {snap_a}");
}

// (SCALE-2) LEGACY COMPATIBILITY: a machine whose snapshot fields are ZERO (every
// account created before SCALE-2, and every fresh one until the first withdrawal)
// computes + stores the snapshot on the FIRST crank and pays correctly — zero means
// "no snapshot yet", never a real (zero) price.
#[test]
fn scale2_legacy_zeroed_snapshot_cranks_on_first_use() {
    let pool = 20_000_000_000u64;
    let (mut svm, id, _a, _c, lp) = boot_converged(0xF6, pool);
    let m = machine_pda(&id);
    let cranker = funded(&mut svm);

    let m0 = read_machine(&svm, &id);
    assert_eq!(m0.withdraw_snapshot_price, 0, "fresh/legacy machine has a zeroed snapshot");
    assert_eq!(m0.withdraw_snapshot_epoch, 0);

    let shares = read_position(&svm, &m, &lp.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(id, &lp.pubkey(), shares), &lp, &[&lp]));
    svm.warp_to_slot(E1_SLOT);
    let vault_before = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));

    let m1 = read_machine(&svm, &id);
    assert!(m1.withdraw_snapshot_price != 0, "snapshot computed on first use from zeroed state");
    assert_eq!(m1.withdraw_snapshot_epoch, m1.epoch_of(E1_SLOT), "stamped with the processing epoch");
    // sole LP, no pending spin → paid its full principal (snapshot == pool/total).
    assert_eq!(vault_before - lamports(&svm, &m), pool, "legacy machine paid the full principal");
    assert!(position_closed(&svm, &m, &lp.pubkey()));
}

// ============================================================================
// REDTEAM-1 adversarial pass (single-asset). Each test ATTEMPTS an exploit and
// asserts it is rejected/bounded. See REDTEAM.md.
// ============================================================================

// (1) CROSS-MACHINE LP — a position from machine A cannot be processed against B
// (`has_one = machine` + `seeds=[b"lp", machine.key(), position.owner]`). Attempt:
// drain B's vault against A's shares.
#[test]
fn redteam_cross_machine_lp_rejected() {
    let (mut svm, ida, admin, _cur, lp) = boot_converged(0xA1, 40_000_000_000);
    let cranker = funded(&mut svm);
    // machine B under the same config/admin.
    let idb = [0xA2u8; 16];
    let curb = funded(&mut svm);
    assert!(send(&mut svm, ix_create(idb, &admin.pubkey(), curb.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_deposit(idb, &lp.pubkey(), 40_000_000_000), &lp, &[&lp]));
    // queue a withdrawal on A.
    let sh = read_position(&svm, &machine_pda(&ida), &lp.pubkey()).shares;
    assert!(send(&mut svm, ix_request_withdraw(ida, &lp.pubkey(), sh), &lp, &[&lp]));
    svm.warp_to_slot(E1_SLOT);
    // ATTACK: process against B, pointing at A's lp position.
    let ma = machine_pda(&ida); let mb = machine_pda(&idb);
    let ix = Instruction::new_with_bytes(pid(), &house::instruction::ProcessWithdrawals {}.data(),
        house::accounts::ProcessWithdrawals {
            machine: mb, position: lp_pda(&ma, &lp.pubkey()), owner: lp.pubkey(),
            cranker: cranker.pubkey(), system_program: system_program::ID,
        }.to_account_metas(None));
    let err = try_send(&mut svm, ix, &cranker, &[&cranker]).unwrap_err();
    assert!(err.contains("Seeds") || err.contains("2006") || err.contains("has_one") || err.contains("2001") || err.contains("Constraint"),
            "cross-machine LP must be rejected: {err}");
}

// (5) SETTLE WITH SWAPPED RANDOMNESS — the seam checks
// `require_keys_eq!(account.key(), pending_spin.randomness)`. Attempt: settle a
// committed spin with a DIFFERENT (attacker-filled JACKPOT) randomness account.
#[test]
fn redteam_settle_swapped_randomness_rejected() {
    let (mut svm, id, _a, _c, _lp) = boot_converged(0xA3, 50_000_000_000);
    let player = funded(&mut svm);
    let attacker = funded(&mut svm);
    // commit against this machine's mock randomness (a losing fill).
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), { let mut b=[0u8;32]; b[0]=22;b[1]=23;b[2]=24; b }), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), 100_000, 0), &player, &[&player]));
    // a foreign machine's mock randomness, filled with JACKPOT, that the attacker points settle at.
    let evil = [0xAEu8; 16];
    // create the evil machine so its mock-rand PDA is program-owned & fillable.
    let curx = funded(&mut svm);
    assert!(send(&mut svm, ix_create(evil, &_a.pubkey(), curx.pubkey()), &_a, &[&_a]));
    assert!(send(&mut svm, ix_fill(evil, &player.pubkey(), [0u8; 32]), &player, &[&player]));
    let m = machine_pda(&id);
    let ix = Instruction::new_with_bytes(pid(), &house::instruction::SpinSettle { nonce: 0 }.data(),
        house::accounts::SpinSettle {
            machine: m, pending_spin: spin_pda(&m, &player.pubkey(), 0), player: player.pubkey(),
            randomness: mock_pda(&evil), // SWAPPED
            cranker: attacker.pubkey(), system_program: system_program::ID,
        }.to_account_metas(None));
    let err = try_send(&mut svm, ix, &attacker, &[&attacker]).unwrap_err();
    assert!(err.contains("InvalidRandomnessAccount") || err.contains("6008") || err.contains("Randomness"),
            "swapped randomness must be rejected: {err}");
}

// (4) MAX_BET / EXPOSURE CAP EDGE — a wager one lamport above the solvency-derived
// max_bet is rejected; the max legal wager reserves ≤ MAX_EXPOSURE_BP (1%) of the
// pool. Attempt: escape the exposure cap by sizing the wager to the boundary.
#[test]
fn redteam_max_bet_cap_holds_at_the_edge() {
    let pool = 50_000_000_000u64;
    let (mut svm, id, _a, _c, _lp) = boot_converged(0xA4, pool);
    let player = funded(&mut svm);
    let (_is_deep, _k, max_bet) = converged_snapshot(pool as u128);
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), { let mut b=[0u8;32]; b[0]=22;b[1]=23;b[2]=24; b }), &player, &[&player]));
    // wager = max_bet + 1 → rejected.
    let err = try_send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), max_bet as u64 + 1, 0), &player, &[&player]).unwrap_err();
    assert!(err.contains("BetExceedsMax") || err.contains("6005"), "over-max wager rejected: {err}");
    // wager = max_bet → accepted; the reserved exposure stays within ~1% of the pool.
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), max_bet as u64, 1), &player, &[&player]), "max wager accepted");
    let reserved = read_machine(&svm, &id).reserved_exposure;
    assert!((reserved as u128) <= pool as u128 * (EXPO_BP as u128) / 10_000 + 1, "reserved ≤ 1% of pool: {reserved}");
}

// (4) DUST ROUND-TRIP — deposit then immediately withdraw. The snapshot floors TOWARD
// the pool, so a round-trip nets ≤ 0 for the attacker: dust favors the pool/stayers,
// never the attacker. Attempt: harvest flooring dust via repeated deposit/withdraw.
#[test]
fn redteam_dust_roundtrip_never_profits() {
    let pool = 40_000_000_000u64;
    let (mut svm, id, _a, _c, _seed) = boot_converged(0xA5, pool);
    let m = machine_pda(&id);
    let attacker = funded(&mut svm);
    let cranker = funded(&mut svm);
    let dep = 7_000_000_001u64; // odd amount to court rounding
    let mut slot = E1_SLOT;
    for cycle in 0..3 {
        let before = lamports(&svm, &attacker.pubkey());
        assert!(send(&mut svm, ix_deposit(id, &attacker.pubkey(), dep), &attacker, &[&attacker]));
        let sh = read_position(&svm, &m, &attacker.pubkey()).shares;
        assert!(send(&mut svm, ix_request_withdraw(id, &attacker.pubkey(), sh), &attacker, &[&attacker]));
        slot += 2_000; svm.warp_to_slot(slot); svm.expire_blockhash();
        assert!(send(&mut svm, ix_process(id, &attacker.pubkey(), &cranker.pubkey()), &cranker, &[&cranker]));
        let net = lamports(&svm, &attacker.pubkey()) as i128 - before as i128;
        assert!(net <= 0, "cycle {cycle}: round-trip never profits (dust favors the pool): net {net}");
    }
}

// (3) SNAPSHOT / HOSTILE CRANKER — the cranker chooses WHEN in the epoch to freeze
// the snapshot, but every withdrawer of that epoch is priced at the SAME frozen
// value, so a cranker cannot advantage one identical request over another by
// ordering. (The freeze-timing lever — a cranker-LP timing a favorable pool moment
// vs stayers — is bounded per spin by the exposure cap; see REDTEAM.md §3.) Attempt:
// a hostile cranker freezes, then reorders to pay two identical LPs differently.
#[test]
fn redteam_snapshot_cranker_cannot_split_identical_lps() {
    let pool = 40_000_000_000u64;
    let (mut svm, id, _a, _c, lp1) = boot_converged(0xA6, pool);
    let m = machine_pda(&id);
    let lp2 = funded(&mut svm);
    let player = funded(&mut svm);
    assert!(send(&mut svm, ix_deposit(id, &lp2.pubkey(), pool), &lp2, &[&lp2]));
    let s1 = read_position(&svm, &m, &lp1.pubkey()).shares;
    let s2 = read_position(&svm, &m, &lp2.pubkey()).shares;
    // a pending spin whose settle the cranker will interleave to try to split them.
    let (is_deep, k, max_bet) = converged_snapshot(2 * pool as u128);
    let _ = (is_deep, k);
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), mock_pda(&id), (max_bet / 2) as u64, 0), &player, &[&player]));
    assert!(send(&mut svm, ix_request_withdraw(id, &lp1.pubkey(), s1), &lp1, &[&lp1]));
    assert!(send(&mut svm, ix_request_withdraw(id, &lp2.pubkey(), s2), &lp2, &[&lp2]));
    svm.warp_to_slot(E1_SLOT);
    // cranker (lp2) freezes on lp1, jackpots, then cranks itself — the SCALE-1 attack.
    let v1 = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp1.pubkey(), &lp2.pubkey()), &lp2, &[&lp2]));
    let pay1 = v1 - lamports(&svm, &m);
    let snap = read_machine(&svm, &id).withdraw_snapshot_price;
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mock_pda(&id), 0, &lp2.pubkey()), &lp2, &[&lp2]));
    let v2 = lamports(&svm, &m);
    assert!(send(&mut svm, ix_process(id, &lp2.pubkey(), &lp2.pubkey()), &lp2, &[&lp2]));
    let pay2 = v2 - lamports(&svm, &m);
    assert_eq!(pay1, pay2, "hostile cranker cannot split identical LPs: {pay1} == {pay2}");
    assert_eq!(pay1 as u128, hm::snapshot::payout(s1, snap), "both at the frozen snapshot");
}
