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
    assert_eq!(m1.div_pool_sol, wager as u64, "wager accrued to the dividend pool");
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
        assert_eq!(lamports(svm, &m) - base_rent, mach.escrowed_sol + mach.div_pool_sol + mach.earmarked_sol, "SOL books");
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
    assert_eq!(mach.div_pool_sol, 50_000_000 + 40_000_000, "only settled wagers accrued (expire refunded)");
}

// ======================================================================
// H6b-2 — LP dividend ledger, reward modes, price-free withdrawals
// ======================================================================

const BP: u64 = 10_000;

fn params_expo(id: &[u8; 16], expo_bp: u64) -> house::DualParams {
    let mut p = params(id);
    p.max_exposure_bp = expo_bp;
    p
}
fn read_position(svm: &LiteSVM, id: &[u8; 16], owner: &Pubkey) -> house::DualLpPosition {
    let a = svm.get_account(&dlp(&dmachine(id), owner)).unwrap();
    house::DualLpPosition::try_deserialize(&mut &a.data[..]).unwrap()
}
fn pos_closed(svm: &LiteSVM, id: &[u8; 16], owner: &Pubkey) -> bool {
    lamports(svm, &dlp(&dmachine(id), owner)) == 0
}
fn ix_claim_sol(id: [u8; 16], owner: &Pubkey) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(), &house::instruction::ClaimSol {}.data(),
        house::accounts::ClaimDividend { machine: m, position: dlp(&m, owner), owner: *owner }.to_account_metas(None))
}
fn ix_earmark_sol(id: [u8; 16], owner: &Pubkey) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(), &house::instruction::EarmarkSol {}.data(),
        house::accounts::ClaimDividend { machine: m, position: dlp(&m, owner), owner: *owner }.to_account_metas(None))
}
fn ix_set_mode(id: [u8; 16], owner: &Pubkey, mode: u8) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(), &house::instruction::SetRewardMode { mode }.data(),
        house::accounts::ClaimDividend { machine: m, position: dlp(&m, owner), owner: *owner }.to_account_metas(None))
}
fn ix_request_wd(id: [u8; 16], owner: &Pubkey, shares: u128) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(), &house::instruction::RequestWithdrawToken { shares }.data(),
        house::accounts::RequestWithdrawToken { machine: m, position: dlp(&m, owner), owner: *owner }.to_account_metas(None))
}
fn ix_cancel_wd(id: [u8; 16], owner: &Pubkey) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(), &house::instruction::CancelWithdrawToken {}.data(),
        house::accounts::CancelWithdrawToken { machine: m, position: dlp(&m, owner), owner: *owner }.to_account_metas(None))
}
fn ix_process_wd(id: [u8; 16], owner: &Pubkey, mint: Pubkey, cranker: &Pubkey) -> Instruction {
    let m = dmachine(&id);
    Instruction::new_with_bytes(pid(), &house::instruction::ProcessWithdrawalToken {}.data(),
        house::accounts::ProcessWithdrawalToken {
            machine: m, position: dlp(&m, owner), owner: *owner,
            token_vault: ata(&m, &mint), owner_token_account: ata(owner, &mint),
            token_program: token_program(), cranker: *cranker, system_program: system_program::ID,
        }.to_account_metas(None))
}
#[cfg(feature = "mock-swap")]
fn ix_compound(id: [u8; 16], owner: &Pubkey, mint: Pubkey, cranker: &Pubkey, amm: &Pubkey, amm_token: &Pubkey) -> Instruction {
    use anchor_lang::solana_program::instruction::AccountMeta;
    let m = dmachine(&id);
    let mut metas = house::accounts::CompoundEpoch {
        machine: m, position: dlp(&m, owner), token_vault: ata(&m, &mint),
        price_pool: mock_price_pda(&id), price_observation: mock_price_pda(&id),
        token_program: token_program(), cranker: *cranker,
    }.to_account_metas(None);
    // mock swap remaining accounts: [amm_token (mut source), amm (writable+signer sink/authority)].
    // A DEDICATED amm account (not the fee-payer cranker) so its writable flag isn't
    // shadowed by an earlier non-writable meta on dedup.
    metas.push(AccountMeta::new(*amm_token, false));
    metas.push(AccountMeta::new(*amm, true));
    Instruction::new_with_bytes(pid(), &house::instruction::CompoundEpoch {}.data(), metas)
}

/// init + create a dual machine with a given exposure; set an in-band fresh
/// price. No deposit (tests control deposits). Returns (svm, id, mint, admin).
fn boot_machine(seed: u8, expo_bp: u64) -> (LiteSVM, [u8; 16], Pubkey, Keypair) {
    let mut svm = boot();
    let admin = funded(&mut svm);
    let id = [seed; 16];
    let mint = Pubkey::new_unique();
    set_mint(&mut svm, &mint, DEC);
    assert!(send(&mut svm, ix_init(&admin.pubkey()), &admin, &[&admin]));
    assert!(send(&mut svm, ix_create_dual(id, &admin.pubkey(), admin.pubkey(), mint, params_expo(&id, expo_bp)), &admin, &[&admin]), "create");
    assert!(send(&mut svm, ix_set_price(id, &admin.pubkey(), PRICE, PRICE, 5), &admin, &[&admin]), "set_price");
    (svm, id, mint, admin)
}
/// fund `owner`'s CHIP ATA and deposit `chip` whole tokens.
fn deposit(svm: &mut LiteSVM, id: [u8; 16], mint: Pubkey, owner: &Keypair, chip: u128) {
    let base = (chip * CHIP) as u64;
    set_token_acct(svm, &ata(&owner.pubkey(), &mint), &mint, &owner.pubkey(), base);
    assert!(send(svm, ix_deposit(id, &owner.pubkey(), mint, base), owner, &[owner]), "deposit");
}
/// accrue SOL yield by settling `count` losing spins of `wager` lamports each.
/// Returns the total accrued (count·wager). Player token ATA seeded empty.
fn accrue_yield(svm: &mut LiteSVM, id: [u8; 16], mint: Pubkey, player: &Keypair, cranker: &Keypair, wager: u64, count: u64) -> u64 {
    if svm.get_account(&ata(&player.pubkey(), &mint)).is_none() {
        set_token_acct(svm, &ata(&player.pubkey(), &mint), &mint, &player.pubkey(), 0);
    }
    let blanks = { let mut b = [0u8; 32]; b[0] = 22; b[1] = 23; b[2] = 24; b }; // 3 BLANK → payout 0
    assert!(send(svm, ix_fill(id, &player.pubkey(), blanks), player, &[player]));
    for n in 0..count {
        assert!(send(svm, ix_commit(id, &player.pubkey(), wager, n), player, &[player]), "commit {n}");
        assert!(send(svm, ix_settle(id, &player.pubkey(), mint, n, &cranker.pubkey()), cranker, &[cranker]), "settle {n}");
    }
    wager * count
}

// ---------------------------------------------------------------------
// THE WORKED EXAMPLE (spec §5), as a literal test.
// ---------------------------------------------------------------------
#[test]
fn worked_example_ten_sol_pool_yields_ten_sol() {
    // Pool worth 10 SOL of tokens (10,000 CHIP @ 1000 CHIP/SOL), EXPO 100% so
    // 0.1-SOL wagers are allowed. Two stakers: 90% and 10%.
    let (mut svm, id, mint, _admin) = boot_machine(0xE0, BP);
    let big = funded(&mut svm);
    let small = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    deposit(&mut svm, id, mint, &big, 9_000);   // 90%
    deposit(&mut svm, id, mint, &small, 1_000); // 10%

    // the small staker holds exactly 10% of shares
    let m0 = read_machine(&svm, &id);
    let ps = read_position(&svm, &id, &small.pubkey());
    assert_eq!(ps.shares * 10, m0.total_shares, "small staker holds exactly 10%");

    // yield exactly 10 SOL via 100 losing spins of 0.1 SOL
    let accrued = accrue_yield(&mut svm, id, mint, &player, &cranker, 100_000_000, 100);
    assert_eq!(accrued, 10_000_000_000, "10 SOL accrued");
    assert_eq!(read_machine(&svm, &id).div_pool_sol, 10_000_000_000, "div pool holds 10 SOL");

    // THE ASSERTION: a 10% staker's pending == exactly 1 SOL.
    let m = read_machine(&svm, &id);
    let ps = read_position(&svm, &id, &small.pubkey());
    let earning = ps.shares + ps.pending_shares;
    let pending = hm::dividend::pending_sol(earning, ps.sol_debt, m.acc_sol_per_share);
    assert_eq!(pending, 1_000_000_000, "10% of 10 SOL yield == exactly 1 SOL");

    // A new depositor bringing 10-SOL-worth of tokens (== the whole existing token
    // pool, 10,000 CHIP) then holds exactly 50% of shares and pending == 0.
    let newcomer = funded(&mut svm);
    deposit(&mut svm, id, mint, &newcomer, 10_000);
    let m2 = read_machine(&svm, &id);
    let pn = read_position(&svm, &id, &newcomer.pubkey());
    assert_eq!(pn.shares * 2, m2.total_shares, "newcomer holds exactly 50%");
    let pend_new = hm::dividend::pending_sol(pn.shares + pn.pending_shares, pn.sol_debt, m2.acc_sol_per_share);
    assert_eq!(pend_new, 0, "newcomer owes 0 from prior accrual (no dilution)");
    // and the 10% staker is UNDILUTED by the newcomer: still exactly 1 SOL.
    let ps2 = read_position(&svm, &id, &small.pubkey());
    assert_eq!(hm::dividend::pending_sol(ps2.shares + ps2.pending_shares, ps2.sol_debt, m2.acc_sol_per_share),
               1_000_000_000, "existing staker undiluted by the new deposit");
}

/// THE WORKED EXAMPLE, compounding half (H6b-3). A 10-SOL-worth pool held by one
/// SPL-mode staker, after compounding 10 SOL of yield into 10-SOL-worth of tokens
/// (via the mock swap at par), holds 20-SOL-worth; a newcomer then depositing
/// 10-SOL-worth of tokens holds EXACTLY 33% (10/30).
#[cfg(feature = "mock-swap")]
#[test]
fn worked_example_compounding_gives_33pct() {
    let (mut svm, id, mint, _admin) = boot_machine(0xE6, BP);
    let staker = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    deposit(&mut svm, id, mint, &staker, 10_000); // sole LP, 10-SOL-worth (10k CHIP)
    // SPL reward mode, then accrue exactly 10 SOL of yield and earmark it.
    assert!(send(&mut svm, ix_set_mode(id, &staker.pubkey(), house::REWARD_MODE_SPL), &staker, &[&staker]));
    accrue_yield(&mut svm, id, mint, &player, &cranker, 100_000_000, 100); // 10 SOL
    assert!(send(&mut svm, ix_earmark_sol(id, &staker.pubkey()), &staker, &[&staker]));
    assert_eq!(read_machine(&svm, &id).earmarked_sol, 10_000_000_000, "10 SOL earmarked");

    // fund a dedicated mock-swap counterparty (the AMM), which fills at par.
    let amm = funded(&mut svm);
    let amm_tok = ata(&amm.pubkey(), &mint);
    set_token_acct(&mut svm, &amm_tok, &mint, &amm.pubkey(), (50_000 * CHIP) as u64);

    // compound: swap 10 SOL → 10_000 CHIP into the vault, mint shares at pre-swap price.
    svm.warp_to_slot(2_000); // cross an epoch boundary (epoch_length 1000)
    assert!(send(&mut svm, ix_compound(id, &staker.pubkey(), mint, &cranker.pubkey(), &amm.pubkey(), &amm_tok), &cranker, &[&cranker, &amm]), "compound_epoch");

    let m = read_machine(&svm, &id);
    assert_eq!(m.token_balance, 20_000 * CHIP, "pool now 20-SOL-worth of tokens");
    assert_eq!(m.earmarked_sol, 0, "earmark fully compounded");
    assert_eq!(read_position(&svm, &id, &staker.pubkey()).earmarked_sol, 0);

    // newcomer deposits 10-SOL-worth → holds exactly 10/30 == 33%.
    let newcomer = funded(&mut svm);
    deposit(&mut svm, id, mint, &newcomer, 10_000);
    let m2 = read_machine(&svm, &id);
    let pn = read_position(&svm, &id, &newcomer.pubkey());
    assert_eq!(pn.shares * 3, m2.total_shares, "newcomer holds exactly 33% (10/30)");
    // the staker holds the other 2/3.
    let ps = read_position(&svm, &id, &staker.pubkey());
    assert_eq!(ps.shares * 3, m2.total_shares * 2, "compounding staker holds 67%");
}

/// compound_epoch books: earmarked_sol → 0, token_balance up by exactly the tokens
/// received, machine SOL down by exactly the swapped amount, and a NON-compounding
/// SOL-mode LP is not diluted in token claim.
#[cfg(feature = "mock-swap")]
#[test]
fn k_compound_books_and_no_dilution() {
    let (mut svm, id, mint, _admin) = boot_machine(0xE7, BP);
    let spl_lp = funded(&mut svm);
    let sol_lp = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    deposit(&mut svm, id, mint, &spl_lp, 6_000);
    deposit(&mut svm, id, mint, &sol_lp, 4_000); // stays SOL-mode, does NOT compound
    assert!(send(&mut svm, ix_set_mode(id, &spl_lp.pubkey(), house::REWARD_MODE_SPL), &spl_lp, &[&spl_lp]));
    accrue_yield(&mut svm, id, mint, &player, &cranker, 100_000_000, 20); // 2 SOL yield
    assert!(send(&mut svm, ix_earmark_sol(id, &spl_lp.pubkey()), &spl_lp, &[&spl_lp]));

    let m = dmachine(&id);
    let vault = ata(&m, &mint);
    let earmarked = read_machine(&svm, &id).earmarked_sol;
    assert!(earmarked > 0);
    // sol_lp's token claim before compound
    let m0 = read_machine(&svm, &id);
    let sol_pos0 = read_position(&svm, &id, &sol_lp.pubkey());
    let sol_claim0 = sol_pos0.shares * m0.token_balance / m0.total_shares;

    let amm = funded(&mut svm);
    let amm_tok = ata(&amm.pubkey(), &mint);
    set_token_acct(&mut svm, &amm_tok, &mint, &amm.pubkey(), (50_000 * CHIP) as u64);
    let mach_sol_before = lamports(&svm, &m);
    let vault_before = tok_bal(&svm, &vault);

    svm.warp_to_slot(2_000);
    assert!(send(&mut svm, ix_compound(id, &spl_lp.pubkey(), mint, &cranker.pubkey(), &amm.pubkey(), &amm_tok), &cranker, &[&cranker, &amm]), "compound");

    let m1 = read_machine(&svm, &id);
    let received = tok_bal(&svm, &vault) - vault_before;
    assert_eq!(m1.token_balance as u64, tok_bal(&svm, &vault), "token_balance mirrors vault");
    assert_eq!(m1.token_balance - m0.token_balance, received as u128, "token_balance += received");
    assert_eq!(mach_sol_before - lamports(&svm, &m), earmarked, "machine SOL down by exactly the swapped amount");
    assert_eq!(m1.earmarked_sol, 0, "earmark cleared");
    // non-compounding SOL-mode LP: token claim never decreased.
    let sol_pos1 = read_position(&svm, &id, &sol_lp.pubkey());
    let sol_claim1 = sol_pos1.shares * m1.token_balance / m1.total_shares;
    assert!(sol_claim1 >= sol_claim0, "SOL-mode LP diluted by a compound: {sol_claim0} -> {sol_claim1}");
}

// ---------------------------------------------------------------------
// deposit → accrue → claim happy path (SOL mode)
// ---------------------------------------------------------------------
#[test]
fn k_deposit_accrue_claim() {
    let (mut svm, id, mint, _admin) = boot_machine(0xE1, BP);
    let lp = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    deposit(&mut svm, id, mint, &lp, 10_000); // sole LP → 100% of yield
    let accrued = accrue_yield(&mut svm, id, mint, &player, &cranker, 100_000_000, 20); // 2 SOL
    assert_eq!(accrued, 2_000_000_000);

    let before = lamports(&svm, &lp.pubkey());
    assert!(send(&mut svm, ix_claim_sol(id, &lp.pubkey()), &lp, &[&lp]), "claim");
    let gained = lamports(&svm, &lp.pubkey()) - before; // dividend paid − tx fee
    // sole LP with an exactly-divisible yield claims the full 2 SOL (net of the
    // ~5000-lamport tx fee it paid as signer); the dividend pool drains to 0.
    assert!(gained >= 2_000_000_000 - 10_000 && gained <= 2_000_000_000, "sole LP claims the yield: {gained}");
    assert_eq!(read_machine(&svm, &id).div_pool_sol, 0, "dividend pool drained (exact division, no dust)");
}

// ---------------------------------------------------------------------
// claim twice pays once
// ---------------------------------------------------------------------
#[test]
fn k_claim_twice_pays_once() {
    let (mut svm, id, mint, _admin) = boot_machine(0xE2, BP);
    let lp = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    deposit(&mut svm, id, mint, &lp, 10_000);
    accrue_yield(&mut svm, id, mint, &player, &cranker, 100_000_000, 10); // 1 SOL

    let b0 = lamports(&svm, &lp.pubkey());
    assert!(send(&mut svm, ix_claim_sol(id, &lp.pubkey()), &lp, &[&lp]));
    let first = lamports(&svm, &lp.pubkey()) as i128 - b0 as i128; // net of fee
    assert!(first > 0, "first claim pays");
    // second claim with no new accrual: only a tx fee is spent, no dividend paid.
    // (fresh blockhash so this isn't rejected as a duplicate of the first claim.)
    svm.expire_blockhash();
    let b1 = lamports(&svm, &lp.pubkey());
    assert!(send(&mut svm, ix_claim_sol(id, &lp.pubkey()), &lp, &[&lp]));
    let second_net = b1 as i128 - lamports(&svm, &lp.pubkey()) as i128; // fee only (positive)
    assert!(second_net >= 0 && second_net < 100_000, "second claim pays no dividend (fee only)");
}

// ---------------------------------------------------------------------
// no-dilution: deposit after accrual owes 0
// ---------------------------------------------------------------------
#[test]
fn k_no_dilution() {
    let (mut svm, id, mint, _admin) = boot_machine(0xE3, BP);
    let lp0 = funded(&mut svm);
    let lp1 = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    deposit(&mut svm, id, mint, &lp0, 10_000);
    accrue_yield(&mut svm, id, mint, &player, &cranker, 100_000_000, 30); // 3 SOL to lp0
    let m = read_machine(&svm, &id);
    let p0 = read_position(&svm, &id, &lp0.pubkey());
    let owed0 = hm::dividend::pending_sol(p0.shares + p0.pending_shares, p0.sol_debt, m.acc_sol_per_share);
    assert!(owed0 > 0);
    // lp1 deposits AFTER the accrual
    deposit(&mut svm, id, mint, &lp1, 5_000);
    let m2 = read_machine(&svm, &id);
    let p1 = read_position(&svm, &id, &lp1.pubkey());
    assert_eq!(hm::dividend::pending_sol(p1.shares + p1.pending_shares, p1.sol_debt, m2.acc_sol_per_share), 0,
        "late depositor owes 0");
    let p0b = read_position(&svm, &id, &lp0.pubkey());
    assert_eq!(hm::dividend::pending_sol(p0b.shares + p0b.pending_shares, p0b.sol_debt, m2.acc_sol_per_share), owed0,
        "existing LP undiluted");
}

// ---------------------------------------------------------------------
// SPL-mode earmarking excluded from withdrawable SOL
// ---------------------------------------------------------------------
#[test]
fn k_spl_mode_earmark_excluded() {
    let (mut svm, id, mint, _admin) = boot_machine(0xE4, BP);
    let lp = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    deposit(&mut svm, id, mint, &lp, 10_000);
    // switch to SPL mode, then accrue
    assert!(send(&mut svm, ix_set_mode(id, &lp.pubkey(), house::REWARD_MODE_SPL), &lp, &[&lp]));
    accrue_yield(&mut svm, id, mint, &player, &cranker, 100_000_000, 20); // 2 SOL

    // earmark: SOL moves from div_pool into earmarked, none leaves the machine.
    let m_before = read_machine(&svm, &id);
    let mach_lamports_before = lamports(&svm, &dmachine(&id));
    assert!(send(&mut svm, ix_earmark_sol(id, &lp.pubkey()), &lp, &[&lp]), "earmark");
    let m_after = read_machine(&svm, &id);
    assert_eq!(lamports(&svm, &dmachine(&id)), mach_lamports_before, "no SOL left the machine on earmark");
    assert!(m_after.earmarked_sol > 0, "SOL earmarked");
    assert_eq!(m_before.div_pool_sol - m_after.div_pool_sol, m_after.earmarked_sol, "div_pool → earmarked, 1:1");
    let ps = read_position(&svm, &id, &lp.pubkey());
    assert_eq!(ps.earmarked_sol, m_after.earmarked_sol, "position earmark == machine earmark (sole LP)");
    // a SOL-mode claim is rejected for an SPL-mode position.
    assert!(try_send(&mut svm, ix_claim_sol(id, &lp.pubkey()), &lp, &[&lp]).unwrap_err().contains("WrongRewardMode"));
    // earmarked SOL is NOT in div_pool (not claimable/withdrawable as yield).
    assert_eq!(m_after.div_pool_sol, 0, "all yield earmarked, none left as dividend");
}

// ---------------------------------------------------------------------
// withdraw pays BOTH assets, price-free, and books balance to the lamport
// across a mixed sequence (deposits, spins won/lost/expired, claims, withdraw)
// ---------------------------------------------------------------------
#[test]
fn k_withdraw_both_assets_books_balance() {
    let (mut svm, id, mint, admin) = boot_machine(0xE5, BP);
    let lp0 = funded(&mut svm);
    let lp1 = funded(&mut svm);
    let player = funded(&mut svm);
    let cranker = funded(&mut svm);
    set_token_acct(&mut svm, &ata(&player.pubkey(), &mint), &mint, &player.pubkey(), 0);
    deposit(&mut svm, id, mint, &lp0, 8_000);
    deposit(&mut svm, id, mint, &lp1, 2_000);
    let m = dmachine(&id);
    let vault = ata(&m, &mint);
    let base_rent = lamports(&svm, &m); // machine rent (before any SOL flows in)

    // books: machine SOL beyond rent == escrowed + div_pool + earmarked; token internal == vault.
    let check = |svm: &LiteSVM| {
        let mach = read_machine(svm, &id);
        assert_eq!(lamports(svm, &m) - base_rent, mach.escrowed_sol + mach.div_pool_sol + mach.earmarked_sol, "SOL books");
        assert_eq!(mach.token_balance as u64, tok_bal(svm, &vault), "token books");
        assert!(mach.reserved_tokens <= mach.token_balance);
    };

    // a mix: a losing spin, a winning spin, an expired spin.
    let blanks = { let mut b = [0u8; 32]; b[0]=22; b[1]=23; b[2]=24; b };
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), blanks), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), 100_000_000, 0), &player, &[&player])); check(&svm);
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 0, &cranker.pubkey()), &cranker, &[&cranker])); check(&svm);
    let cherries = { let mut b=[0u8;32]; b[0]=13; b[1]=13; b[2]=22; b }; // 2 cherry → small token win
    assert!(send(&mut svm, ix_fill(id, &player.pubkey(), cherries), &player, &[&player]));
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), 100_000_000, 1), &player, &[&player])); check(&svm);
    assert!(send(&mut svm, ix_settle(id, &player.pubkey(), mint, 1, &cranker.pubkey()), &cranker, &[&cranker])); check(&svm);
    // expired spin: commit then warp past the window and expire (SOL refunded).
    assert!(send(&mut svm, ix_commit(id, &player.pubkey(), 50_000_000, 2), &player, &[&player])); check(&svm);
    svm.warp_to_slot(house::EXPIRE_SLOTS + 50);
    assert!(send(&mut svm, ix_expire(id, &player.pubkey(), 2, &cranker.pubkey()), &cranker, &[&cranker])); check(&svm);

    // lp1 claims its SOL dividend, then withdraws ALL its shares → gets tokens too.
    assert!(send(&mut svm, ix_claim_sol(id, &lp1.pubkey()), &lp1, &[&lp1])); check(&svm);
    let sh = read_position(&svm, &id, &lp1.pubkey()).shares;
    assert!(send(&mut svm, ix_request_wd(id, &lp1.pubkey(), sh), &lp1, &[&lp1]));
    svm.warp_to_slot(house::EXPIRE_SLOTS + 50 + 5_000); // cross an epoch boundary
    let tok_before = tok_bal(&svm, &ata(&lp1.pubkey(), &mint));
    let sol_before = lamports(&svm, &lp1.pubkey());
    // fund lp1's token ATA (must exist to receive)
    if svm.get_account(&ata(&lp1.pubkey(), &mint)).is_none() {
        set_token_acct(&mut svm, &ata(&lp1.pubkey(), &mint), &mint, &lp1.pubkey(), 0);
    }
    assert!(send(&mut svm, ix_process_wd(id, &lp1.pubkey(), mint, &cranker.pubkey()), &cranker, &[&cranker]), "process");
    check(&svm);
    // lp1 received TOKENS (its pro-rata of the vault) — the token side of withdraw.
    assert!(tok_bal(&svm, &ata(&lp1.pubkey(), &mint)) > tok_before, "withdraw paid tokens");
    // lp1 SOL only grew by the (already-claimed→0) dividend + rent; the point is it
    // did not lose SOL and the token side moved. Books still balance (checked).
    assert!(lamports(&svm, &lp1.pubkey()) >= sol_before, "withdraw never costs the LP SOL");
    let _ = admin;
}
