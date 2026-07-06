//! Security-gate proof (test i): the default / deployable build must NOT contain
//! the mock randomness instruction or account. A fillable randomness source is a
//! drain-everything backdoor (settle any spin to JACKPOT^3), so its absence from
//! the shipped artifact is a security invariant, not a nicety.
//!
//! This reads the anchor-generated IDL at target/idl/house.json, which is
//! produced by the default `anchor build` (the `mock-randomness` feature OFF).
//! It runs under plain `cargo test --workspace` — the build everyone ships — and
//! needs no mock feature. Requires `anchor build` first (same convention as the
//! Yvone-Protocol arbiter tests).

use serde_json::Value;

#[test]
fn default_build_idl_has_no_mock_surface() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/idl/house.json");
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|e| panic!("read {path}: {e}\nrun `anchor build` before the tests"));
    let idl: Value = serde_json::from_str(&raw).expect("house.json is valid JSON");

    let instrs: Vec<String> = idl["instructions"]
        .as_array()
        .expect("idl.instructions is an array")
        .iter()
        .map(|i| i["name"].as_str().unwrap().to_string())
        .collect();
    assert!(!instrs.is_empty(), "default-build IDL has no instructions — stale/empty build?");

    // Generic gate: NO instruction may contain "mock". This covers both seams —
    // mock_fill_randomness (H1) and mock_set_price (H6b-1) — automatically.
    for n in &instrs {
        assert!(
            !n.to_lowercase().contains("mock"),
            "SECURITY GATE FAILED: mock instruction '{n}' present in the default-build IDL"
        );
    }
    // Belt-and-suspenders: both mock instructions named explicitly.
    for banned in ["mock_set_price", "mock_fill_randomness"] {
        assert!(!instrs.iter().any(|n| n == banned),
            "SECURITY GATE FAILED: {banned} present in the default-build IDL");
    }

    if let Some(accts) = idl["accounts"].as_array() {
        for a in accts {
            let n = a["name"].as_str().unwrap();
            assert!(
                !n.to_lowercase().contains("mock"),
                "SECURITY GATE FAILED: mock account '{n}' present in the default-build IDL"
            );
        }
    }

    // Positive check: the REAL dual-asset surface must be present — the clmm price
    // backend ships even though its reader is stubbed until H6b-3. Includes the
    // H6b-2 LP dividend-ledger + price-free withdrawal instructions.
    for needed in [
        "create_machine_dual", "lp_deposit_token", "spin_commit_dual", "spin_settle_dual", "spin_expire_dual",
        "claim_sol", "earmark_sol", "set_reward_mode",
        "request_withdraw_token", "cancel_withdraw_token", "process_withdrawal_token",
    ] {
        assert!(instrs.iter().any(|n| n == needed),
            "dual-asset instruction '{needed}' missing from the default-build IDL");
    }

    eprintln!("gate ok: {} default-build instructions, none mock: {:?}", instrs.len(), instrs);
}
