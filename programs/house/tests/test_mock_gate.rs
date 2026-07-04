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

    for n in &instrs {
        assert!(
            !n.to_lowercase().contains("mock"),
            "SECURITY GATE FAILED: mock instruction '{n}' present in the default-build IDL"
        );
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

    eprintln!("gate ok: {} default-build instructions, none mock: {:?}", instrs.len(), instrs);
}
