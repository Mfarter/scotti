//! LiteSVM integration tests for the DUAL-ASSET machine path (H6b-1), under BOTH
//! mock seams (`mock-randomness` + `mock-price`). The whole file is cfg-gated, so
//! plain `cargo test --workspace` skips it — run with:
//!
//!   cargo build-sbf --features mock-randomness,mock-price
//!   cargo test -p house --features mock-randomness,mock-price
//!
//! Same books-balance discipline as test_house.rs: every payout is reconciled to
//! the base unit against house-math's own prediction at the mock price — no
//! hardcoded outcome numbers. SPL mints/ATAs are seeded by writing raw token
//! account bytes; the vault ATA is created on-chain by create_machine_dual.
#![cfg(all(feature = "mock-randomness", feature = "mock-price"))]

use {
    anchor_lang::{
        solana_program::instruction::Instruction, solana_program::pubkey::Pubkey,
        solana_program::system_program, AccountDeserialize, InstructionData, ToAccountMetas,
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    yvone_house_math as hm,
};

// spl-token 3.5.0 + associated-token 1.1.1 (the programs LiteSVM loads by default)
fn token_program() -> Pubkey { "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA".parse().unwrap() }
fn ata_program() -> Pubkey { "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".parse().unwrap() }
fn rent_sysvar() -> Pubkey { "SysvarRent111111111111111111111111111111111".parse().unwrap() }

// -------------------- tx plumbing (mirrors test_house.rs) --------------------

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
    svm.airdrop(&kp.pubkey(), 5_000_000_000_000).unwrap();
    kp
}
fn lamports(svm: &LiteSVM, k: &Pubkey) -> u64 { svm.get_account(k).map(|a| a.lamports).unwrap_or(0) }

// -------------------- PDAs / ATAs --------------------

fn config_pda() -> Pubkey { Pubkey::find_program_address(&[b"house-config"], &pid()).0 }
fn dmachine(id: &[u8; 16]) -> Pubkey { Pubkey::find_program_address(&[b"dual-machine", id.as_ref()], &pid()).0 }
fn dlp(m: &Pubkey, o: &Pubkey) -> Pubkey { Pubkey::find_program_address(&[b"dual-lp", m.as_ref(), o.as_ref()], &pid()).0 }
fn dspin(m: &Pubkey, p: &Pubkey, n: u64) -> Pubkey {
    Pubkey::find_program_address(&[b"dual-spin", m.as_ref(), p.as_ref(), &n.to_le_bytes()], &pid()).0
}
fn mock_price_pda(id: &[u8; 16]) -> Pubkey { Pubkey::find_program_address(&[b"mock-price", id.as_ref()], &pid()).0 }
fn mock_rand_pda(id: &[u8; 16]) -> Pubkey { Pubkey::find_program_address(&[b"mock-rand", id.as_ref()], &pid()).0 }
fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), token_program().as_ref(), mint.as_ref()], &ata_program()).0
}

// -------------------- raw SPL account seeding --------------------

fn mint_bytes(decimals: u8) -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = decimals;
    d[45] = 1; // is_initialized
    d
}
fn token_acct_bytes(mint: &Pubkey, owner: &Pubkey, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // state = Initialized
    d
}
fn set_mint(svm: &mut LiteSVM, mint: &Pubkey, decimals: u8) {
    svm.set_account(*mint, Account {
        lamports: 10_000_000, data: mint_bytes(decimals), owner: token_program(), executable: false, rent_epoch: 0,
    }).unwrap();
}
fn set_token_acct(svm: &mut LiteSVM, addr: &Pubkey, mint: &Pubkey, owner: &Pubkey, amount: u64) {
    svm.set_account(*addr, Account {
        lamports: 10_000_000, data: token_acct_bytes(mint, owner, amount), owner: token_program(), executable: false, rent_epoch: 0,
    }).unwrap();
}
fn tok_bal(svm: &LiteSVM, addr: &Pubkey) -> u64 {
    let a = svm.get_account(addr).unwrap();
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}

// -------------------- machine params + house-math mirror --------------------

const DEC: u8 = 9;
const CHIP: u128 = 1_000_000_000; // 1 whole CHIP in base units (9 dec)
const PRICE: u128 = 1000 * 1_000_000_000_000; // 1000 CHIP/SOL, ×1e12
const HAIRCUT: u128 = 1500;
const EXPO: u64 = 100; // 1%
const RTP_MAX: u16 = 9500;

fn params(id: &[u8; 16]) -> house::DualParams {
    house::DualParams {
        pool: mock_price_pda(id), observation: mock_price_pda(id), token_decimals: DEC,
        // d_low above D_now (≈2000 SOL) so k pins at k_max; d_mid above it so tier = SHALLOW.
        d_low: 3_000_000_000_000, d_mid: 5_000_000_000_000, d_high: 10_000_000_000_000,
        max_exposure_bp: EXPO, smooth_window: hm::SMOOTH_WINDOW_SLOTS, epoch_length: 1_000,
        twap_window_secs: 300, max_staleness_secs: 90, band_bp: 300, m_bp: 200,
        haircut_bp: HAIRCUT as u16, rtp_max_bp: RTP_MAX, max_pending_spins: 100,
    }
}

/// Mirror the program's FIRST-commit snapshot (smoothed cold-starts at D_now).
/// Returns (is_deep, k, tier, max_payout, reserve).
fn predict(token_balance: u128, sol_yield: u128, wager: u64) -> (bool, u128, &'static hm::Tier, u128, u128) {
    let token_value = hm::payout::payout_value_lamports(token_balance, PRICE, DEC);
    let d = sol_yield + token_value;
    let is_deep = d >= 5_000_000_000_000u128;
    let tier = if is_deep { &hm::DEEP } else { &hm::SHALLOW };
    let num = if is_deep { hm::DEEP_NUM } else { hm::SHALLOW_NUM };
    let (kmin, kmax) = hm::k_bounds_dual(num, RTP_MAX as u128);
    let k = hm::k_of_depth(d, 3_000_000_000_000, 10_000_000_000_000, kmin, kmax);
    let maxp = hm::payout::max_payout_tokens(wager as u128, tier, k, PRICE, DEC).unwrap();
    let reserve = hm::payout::reserve_with_haircut(maxp, HAIRCUT).unwrap();
    (is_deep, k, tier, maxp, reserve)
}

// -------------------- instruction builders --------------------

fn ix_init(admin: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(pid(),
        &house::instruction::InitializeHouseConfig { admin: *admin }.data(),
        house::accounts::InitializeHouseConfig { config: config_pda(), payer: *admin, system_program: system_program::ID }.to_account_metas(None))
}
fn ix_create_dual(id: [u8; 16], admin: &Pubkey, curator: Pubkey, mint: Pubkey, p: house::DualParams) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(),
        &house::instruction::CreateMachineDual { machine_id: id, params: p, curator }.data(),
        house::accounts::CreateMachineDual {
            config: config_pda(), machine: m, token_mint: mint, token_vault: ata(&m, &mint),
            admin: *admin, token_program: token_program(), associated_token_program: ata_program(),
            system_program: system_program::ID, rent: rent_sysvar(),
        }.to_account_metas(None))
}
fn ix_set_price(id: [u8; 16], auth: &Pubkey, twap: u128, spot: u128, age: u32) -> Instruction {
    Instruction::new_with_bytes(pid(),
        &house::instruction::MockSetPrice { id, twap_1e12: twap, spot_1e12: spot, age_secs: age }.data(),
        house::accounts::MockSetPrice { price: mock_price_pda(&id), authority: *auth, system_program: system_program::ID }.to_account_metas(None))
}
fn ix_deposit(id: [u8; 16], owner: &Pubkey, mint: Pubkey, amount: u64) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(),
        &house::instruction::LpDepositToken { amount }.data(),
        house::accounts::LpDepositToken {
            machine: m, position: dlp(&m, owner), owner: *owner,
            owner_token_account: ata(owner, &mint), token_vault: ata(&m, &mint),
            token_program: token_program(), system_program: system_program::ID,
        }.to_account_metas(None))
}
fn ix_commit(id: [u8; 16], player: &Pubkey, wager: u64, nonce: u64) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(),
        &house::instruction::SpinCommitDual { wager, nonce }.data(),
        house::accounts::SpinCommitDual {
            machine: m, pending_spin: dspin(&m, player, nonce), player: *player,
            randomness: mock_rand_pda(&id), price_pool: mock_price_pda(&id), price_observation: mock_price_pda(&id),
            system_program: system_program::ID,
        }.to_account_metas(None))
}
fn ix_settle(id: [u8; 16], player: &Pubkey, mint: Pubkey, nonce: u64, cranker: &Pubkey) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(),
        &house::instruction::SpinSettleDual { nonce }.data(),
        house::accounts::SpinSettleDual {
            machine: m, pending_spin: dspin(&m, player, nonce), player: *player,
            randomness: mock_rand_pda(&id), token_vault: ata(&m, &mint), player_token_account: ata(player, &mint),
            token_program: token_program(), cranker: *cranker, system_program: system_program::ID,
        }.to_account_metas(None))
}
fn ix_expire(id: [u8; 16], player: &Pubkey, nonce: u64, cranker: &Pubkey) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(),
        &house::instruction::SpinExpireDual { nonce }.data(),
        house::accounts::SpinExpireDual {
            machine: m, pending_spin: dspin(&m, player, nonce), player: *player,
            cranker: *cranker, system_program: system_program::ID,
        }.to_account_metas(None))
}
fn ix_fill(id: [u8; 16], authority: &Pubkey, bytes: [u8; 32]) -> Instruction {
    Instruction::new_with_bytes(pid(),
        &house::instruction::MockFillRandomness { id, bytes }.data(),
        house::accounts::MockFillRandomness { randomness: mock_rand_pda(&id), authority: *authority, system_program: system_program::ID }.to_account_metas(None))
}

fn read_machine(svm: &LiteSVM, id: &[u8; 16]) -> house::DualMachine {
    house::DualMachine::try_deserialize(&mut &svm.get_account(&dmachine(id)).unwrap().data[..]).unwrap()
}
fn read_spin(svm: &LiteSVM, id: &[u8; 16], player: &Pubkey, nonce: u64) -> house::DualPendingSpin {
    let m = dmachine(id);
    house::DualPendingSpin::try_deserialize(&mut &svm.get_account(&dspin(&m, player, nonce)).unwrap().data[..]).unwrap()
}
fn spin_closed(svm: &LiteSVM, id: &[u8; 16], player: &Pubkey, nonce: u64) -> bool {
    lamports(svm, &dspin(&dmachine(id), player, nonce)) == 0
}

/// Boot: init, create dual machine, seed LP tokens + deposit them, set an
/// in-band fresh price. Returns (svm, id, mint, admin, lp, deposit_base).
fn boot_dual(seed: u8, deposit_chip: u128) -> (LiteSVM, [u8; 16], Pubkey, Keypair, Keypair, u128) {
    let mut svm = boot();
    let admin = funded(&mut svm);
    let lp = funded(&mut svm);
    let id = [seed; 16];
    let mint = Pubkey::new_unique();
    set_mint(&mut svm, &mint, DEC);
    let deposit_base = deposit_chip * CHIP;
    set_token_acct(&mut svm, &ata(&lp.pubkey(), &mint), &mint, &lp.pubkey(), deposit_base as u64);
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_create_dual(id, &admin.pubkey(), admin.pubkey(), mint, params(&id)), &admin, &[&admin]), "create_machine_dual");
    assert!(send(&mut svm, ix_deposit(id, &lp.pubkey(), mint, deposit_base as u64), &lp, &[&lp]), "deposit");
    assert!(send(&mut svm, ix_set_price(id, &admin.pubkey(), PRICE, PRICE, 5), &admin, &[&admin]), "set_price");
    (svm, id, mint, admin, lp, deposit_base)
}

// ============================================================================
// (a) happy dual spin — SOL in / tokens out reconciles to house-math
// ============================================================================
#[test]
fn a_happy_dual_spin_reconciles() {
    let (mut svm, id, mint, _admin, _lp, dep) = boot_dual(0xA1, 2_000_000);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    set_token_acct(&mut svm, &ata(&player.pubkey(), &mint), &mint, &player.pubkey(), 0);

    let wager: u64 = 100_000_000; // 0.1 SOL
    let (is_deep, k, tier, maxp, reserve) = predict(dep, 0, wager);
    // 1 cherry (net house win): CHERRY at strip 13, BLANK at 22/23
    let bytes = { let mut b = [0u8; 32]; b[0] = 13; b[1] = 22; b[2] = 23; b };
    let reels = hm::reels_from_randomness(&bytes);
    let expected = hm::payout::spin_payout_tokens(wager as u128, tier, k, reels, PRICE, DEC).unwrap();
    assert!(expected > 0, "want a nonzero payout");

    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), wager, 0), &player, &[&player]), "commit");

    // snapshot matches house-math
    let s = read_spin(&svm, &id, &player.pubkey(), 0);
    assert_eq!(s.k_bp, k, "snapshot k");
    assert_eq!(s.tier_is_deep, is_deep, "snapshot tier");
    assert_eq!(s.price_at_commit_1e12, PRICE, "snapshot price");
    assert_eq!(s.max_payout_tokens, maxp, "snapshot max_payout");
    assert_eq!(s.reserved_tokens, reserve, "snapshot reserve");
    let m0 = read_machine(&svm, &id);
    assert_eq!(m0.reserved_tokens, reserve, "reserve booked");
    assert_eq!(m0.escrowed_sol, wager, "wager escrowed");
    assert_eq!(m0.pending_spins, 1);

    let vault = ata(&dmachine(&id), &mint);
    let vault_before = tok_bal(&svm, &vault);
    let spin_rent = lamports(&svm, &dspin(&dmachine(&id), &player.pubkey(), 0));
    let player_sol_before = lamports(&svm, &player.pubkey());

    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 0, &cranker.pubkey()), &cranker, &[&cranker]), "settle");

    // tokens out == prediction, exactly
    assert_eq!(tok_bal(&svm, &ata(&player.pubkey(), &mint)), expected as u64, "player token payout");
    assert_eq!(vault_before - tok_bal(&svm, &vault), expected as u64, "vault debited exactly payout");
    let m1 = read_machine(&svm, &id);
    assert_eq!(m1.token_balance, dep - expected, "token_balance -= payout");
    assert_eq!(m1.reserved_tokens, 0, "reserve released");
    assert_eq!(m1.escrowed_sol, 0, "wager no longer escrowed");
    assert_eq!(m1.pending_sol_yield, wager as u64, "wager accrued to SOL yield");
    assert_eq!(m1.pending_spins, 0);
    // player only regains the spin rent in SOL (payout is token-only)
    assert_eq!(lamports(&svm, &player.pubkey()), player_sol_before + spin_rent, "SOL side: only rent back");
    assert!(spin_closed(&svm, &id, &player.pubkey(), 0));
}

// ============================================================================
// (b) JACKPOT³ — payout equals snapshot max_payout; haircut reserve releases
// ============================================================================
#[test]
fn b_jackpot_pays_max_payout_and_releases_haircut() {
    let (mut svm, id, mint, _a, _lp, dep) = boot_dual(0xB2, 2_000_000);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    set_token_acct(&mut svm, &ata(&player.pubkey(), &mint), &mint, &player.pubkey(), 0);

    let wager: u64 = 80_000_000;
    let (_d, _k, _t, maxp, reserve) = predict(dep, 0, wager);
    assert!(reserve > maxp, "haircut makes reserve exceed max_payout");
    let bytes = [0u8; 32]; // JACKPOT³

    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), wager, 0), &player, &[&player]));
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 0, &cranker.pubkey()), &cranker, &[&cranker]));

    assert_eq!(tok_bal(&svm, &ata(&player.pubkey(), &mint)), maxp as u64, "jackpot pays exactly max_payout");
    let m = read_machine(&svm, &id);
    assert_eq!(m.reserved_tokens, 0, "full haircut reserve released");
    assert_eq!(m.token_balance, dep - maxp, "vault down by max_payout only (haircut was never spent)");
}

// ============================================================================
// (c) band gate — spot 4% off TWAP refused; back in-band allowed
// ============================================================================
#[test]
fn c_band_gate_blocks_and_allows() {
    let (mut svm, id, _mint, admin, _lp, _dep) = boot_dual(0xC3, 2_000_000);
    let player = funded(&mut svm);
    let wager: u64 = 50_000_000;
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));

    // spot 4% below twap (> 300bp band) → PriceUnstable
    let spot_out = PRICE * 9600 / 10000;
    assert!(send(&mut svm, ix_set_price(id, &admin.pubkey(), PRICE, spot_out, 5), &admin, &[&admin]));
    let e = try_send(&mut svm, ix_commit(id, &player.pubkey(), wager, 0), &player, &[&player]).unwrap_err();
    assert!(e.contains("PriceUnstable") || e.contains("6004") || e.contains("drifted"), "expected band gate: {e}");

    // spot 2% off (< 300bp) → allowed. (Nonce 1: a distinct tx from the refused
    // one, so LiteSVM doesn't dedupe it as the same signature.)
    let spot_in = PRICE * 9800 / 10000;
    assert!(send(&mut svm, ix_set_price(id, &admin.pubkey(), PRICE, spot_in, 5), &admin, &[&admin]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), wager, 1), &player, &[&player]), "in-band commit should pass");
}

// ============================================================================
// (d) staleness gate — age past max_staleness refused
// ============================================================================
#[test]
fn d_staleness_gate_blocks() {
    let (mut svm, id, _mint, admin, _lp, _dep) = boot_dual(0xD4, 2_000_000);
    let player = funded(&mut svm);
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));

    // age 120s > max_staleness 90s → PriceStale
    assert!(send(&mut svm, ix_set_price(id, &admin.pubkey(), PRICE, PRICE, 120), &admin, &[&admin]));
    let e = try_send(&mut svm, ix_commit(id, &player.pubkey(), 50_000_000, 0), &player, &[&player]).unwrap_err();
    assert!(e.contains("PriceStale") || e.contains("6003") || e.contains("stale"), "expected staleness gate: {e}");

    // fresh again → allowed (nonce 1: distinct tx from the refused one)
    assert!(send(&mut svm, ix_set_price(id, &admin.pubkey(), PRICE, PRICE, 10), &admin, &[&admin]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), 50_000_000, 1), &player, &[&player]));
}

// ============================================================================
// (e) price snapshot honored — change price between commit and settle; payout
//     uses the COMMITTED price (the FX analog of the k-snapshot test)
// ============================================================================
#[test]
fn e_price_snapshot_honored() {
    let (mut svm, id, mint, admin, _lp, dep) = boot_dual(0xE5, 2_000_000);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    set_token_acct(&mut svm, &ata(&player.pubkey(), &mint), &mint, &player.pubkey(), 0);

    let wager: u64 = 100_000_000;
    let (_d, k, tier, _mp, _r) = predict(dep, 0, wager);
    let bytes = { let mut b = [0u8; 32]; b[0] = 13; b[1] = 13; b[2] = 22; b }; // 2 cherry
    let reels = hm::reels_from_randomness(&bytes);
    // payout the COMMITTED price (1000) predicts:
    let expected_committed = hm::payout::spin_payout_tokens(wager as u128, tier, k, reels, PRICE, DEC).unwrap();

    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), wager, 0), &player, &[&player]));

    // move the mock price WAY up before settle — must be ignored.
    let price2 = PRICE * 3;
    assert!(send(&mut svm, ix_set_price(id, &admin.pubkey(), price2, price2, 5), &admin, &[&admin]));
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 0, &cranker.pubkey()), &cranker, &[&cranker]));

    let paid = tok_bal(&svm, &ata(&player.pubkey(), &mint));
    assert_eq!(paid, expected_committed as u64, "payout uses COMMITTED price, not the changed one");
    // sanity: the changed price would have paid 3× — prove they differ
    assert_ne!(paid, (expected_committed * 3) as u64);
}

// ============================================================================
// (f) margin-floor validation — reject RTP 97 / band 300 / m 200, accept [92,95]
// ============================================================================
#[test]
fn f_margin_floor_validation() {
    let mut svm = boot();
    let admin = funded(&mut svm);
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));

    // rtp_max 9700 with band 300, m 200 crosses the floor → rejected.
    let id_bad = [0xF6u8; 16];
    let mint_bad = Pubkey::new_unique();
    set_mint(&mut svm, &mint_bad, DEC);
    let mut bad = params(&id_bad);
    bad.rtp_max_bp = 9700;
    let e = try_send(&mut svm, ix_create_dual(id_bad, &admin.pubkey(), admin.pubkey(), mint_bad, bad), &admin, &[&admin]).unwrap_err();
    assert!(e.contains("MarginFloor") || e.contains("6000") || e.contains("margin floor"), "expected margin-floor reject: {e}");

    // the spec's [92,95] ceiling is accepted.
    let id_ok = [0xF7u8; 16];
    let mint_ok = Pubkey::new_unique();
    set_mint(&mut svm, &mint_ok, DEC);
    assert!(send(&mut svm, ix_create_dual(id_ok, &admin.pubkey(), admin.pubkey(), mint_ok, params(&id_ok)), &admin, &[&admin]), "9500 ceiling accepted");
}

// ============================================================================
// (g) max_pending_spins boundary — 100 commits allowed, 101st refused, settling
//     one frees a slot
// ============================================================================
#[test]
fn g_max_pending_spins_boundary() {
    let (mut svm, id, mint, _a, _lp, _dep) = boot_dual(0x67, 2_000_000);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    set_token_acct(&mut svm, &ata(&player.pubkey(), &mint), &mint, &player.pubkey(), 0);
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));

    let wager: u64 = 1_000_000; // 0.001 SOL — tiny so 100 reserves fit
    for n in 0..100u64 {
        assert!(send(&mut svm, ix_commit(id, &player.pubkey(), wager, n), &player, &[&player]), "commit {n}");
    }
    assert_eq!(read_machine(&svm, &id).pending_spins, 100);
    // the 101st is refused
    let e = try_send(&mut svm, ix_commit(id, &player.pubkey(), wager, 100), &player, &[&player]).unwrap_err();
    assert!(e.contains("TooManyPendingSpins") || e.contains("6005"), "expected pending cap: {e}");
    // settling one frees a slot
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 0, &cranker.pubkey()), &cranker, &[&cranker]));
    assert_eq!(read_machine(&svm, &id).pending_spins, 99);
    // nonce 101: a fresh tx (nonce 100 was the refused one) → not a dup signature.
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), wager, 101), &player, &[&player]), "slot freed, commit allowed");
    assert_eq!(read_machine(&svm, &id).pending_spins, 100);
}

// ============================================================================
// (h) token-solvency max_bet boundary — the binding constraint, incl. haircut
// ============================================================================
#[test]
fn h_token_solvency_boundary() {
    let dep_chip = 2_000_000u128;
    let (mut svm, id, _mint, _a, _lp, dep) = boot_dual(0x68, dep_chip);
    let player = funded(&mut svm);
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), [0u8; 32]), &player, &[&player]));

    // token cap = token_balance × expo / BP.
    let token_cap = dep * EXPO as u128 / hm::BP;
    // value-curve max_bet at the cold-start depth.
    let d = hm::payout::payout_value_lamports(dep, PRICE, DEC);
    let (kmin, kmax) = hm::k_bounds_dual(hm::SHALLOW_NUM, RTP_MAX as u128);
    let k = hm::k_of_depth(d, 3_000_000_000_000, 10_000_000_000_000, kmin, kmax);
    let value_max_bet = hm::max_bet(d, EXPO as u128, &hm::SHALLOW, k) as u64;

    // largest wager whose reserve ≤ token_cap.
    let reserve_of = |w: u64| -> u128 {
        let mp = hm::payout::max_payout_tokens(w as u128, &hm::SHALLOW, k, PRICE, DEC).unwrap();
        hm::payout::reserve_with_haircut(mp, HAIRCUT).unwrap()
    };
    let (mut lo, mut hi) = (0u64, value_max_bet);
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if reserve_of(mid) <= token_cap { lo = mid; } else { hi = mid - 1; }
    }
    let boundary = lo;
    assert!(boundary < value_max_bet, "token-solvency must be the BINDING constraint here (got {boundary} vs value {value_max_bet})");
    assert!(reserve_of(boundary) <= token_cap && reserve_of(boundary + 1) > token_cap, "boundary is exact");

    // at the boundary: allowed. just above: refused by the token-solvency check.
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), boundary, 0), &player, &[&player]), "boundary wager allowed");
    let e = try_send(&mut svm, ix_commit(id, &player.pubkey(), boundary + 1, 1), &player, &[&player]).unwrap_err();
    assert!(e.contains("BetExceedsMax") || e.contains("6008") || e.contains("6009"), "expected token-solvency reject: {e}");
}

// ============================================================================
// (j) books — SOL accumulator + token vault + reserves reconcile across a
//     mixed win/loss/expire sequence
// ============================================================================
#[test]
fn j_books_reconcile_over_mixed_sequence() {
    let (mut svm, id, mint, _a, _lp, _dep) = boot_dual(0x6A, 2_000_000);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    set_token_acct(&mut svm, &ata(&player.pubkey(), &mint), &mint, &player.pubkey(), 0);
    let m = dmachine(&id);
    let vault = ata(&m, &mint);
    // baseline machine rent (no spins yet): lamports held beyond this are escrow+yield.
    let base_rent = lamports(&svm, &m);

    let check_books = |svm: &LiteSVM| {
        let mach = read_machine(svm, &id);
        // SOL: machine PDA lamports − rent == escrowed_sol + pending_sol_yield.
        assert_eq!(lamports(svm, &m) - base_rent, mach.escrowed_sol + mach.pending_sol_yield, "SOL books");
        // token: internal token_balance == the vault ATA balance.
        assert_eq!(mach.token_balance as u64, tok_bal(svm, &vault), "token books");
        // reserves never exceed the balance.
        assert!(mach.reserved_tokens <= mach.token_balance, "reserve within balance");
    };

    // win
    let bytes_win = [0u8; 32]; // jackpot
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes_win), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), 50_000_000, 0), &player, &[&player]));
    check_books(&svm);
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 0, &cranker.pubkey()), &cranker, &[&cranker]));
    check_books(&svm);

    // loss (all blanks: strip 22 → BLANK) — pays 0 tokens, still accrues the wager.
    let player_tok_before = tok_bal(&svm, &ata(&player.pubkey(), &mint));
    let bytes_loss = { let mut b = [0u8; 32]; b[0] = 22; b[1] = 23; b[2] = 24; b };
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), bytes_loss), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), 40_000_000, 1), &player, &[&player]));
    check_books(&svm);
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 1, &cranker.pubkey()), &cranker, &[&cranker]));
    check_books(&svm);
    assert_eq!(tok_bal(&svm, &ata(&player.pubkey(), &mint)), player_tok_before, "a loss pays 0 tokens");

    // expire: commit then warp past the window and expire → SOL refunded.
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), 30_000_000, 2), &player, &[&player]));
    check_books(&svm);
    svm.warp_to_slot(house::EXPIRE_SLOTS + 100);
    let player_sol_before = lamports(&svm, &player.pubkey());
    let spin_rent = lamports(&svm, &dspin(&m, &player.pubkey(), 2));
    assert!(send(&mut svm, ix_expire(id, &player.pubkey(), 2, &cranker.pubkey()), &cranker, &[&cranker]));
    check_books(&svm);
    // expire refunds the wager AND returns the spin rent.
    assert_eq!(lamports(&svm, &player.pubkey()), player_sol_before + 30_000_000 + spin_rent, "expire refunds wager + rent");
    let mach = read_machine(&svm, &id);
    assert_eq!(mach.pending_spins, 0);
    assert_eq!(mach.reserved_tokens, 0);
    assert_eq!(mach.pending_sol_yield, 50_000_000 + 40_000_000, "only settled wagers accrued (expire refunded)");
}
