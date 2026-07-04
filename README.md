# Scotti — Yvone House Module

Peer-to-house games backed by liquidity pools, where the odds are a **published,
deterministic function of pool state** (an AMM for luck). Read
[`HOUSE-SPEC.md`](./HOUSE-SPEC.md) first — it is the source of truth.

**Legal posture (fixed):** a devnet demonstration only. Real-money operation is a
licensed-casino activity *and* a pooled investment product — out of scope by design.

## Status

| path | what | status |
|---|---|---|
| `HOUSE-SPEC.md` | module design v0 | draft for review |
| `crates/house-math` | exact machine math: paytables, RTP curve `k(D)`, exposure cap, depth smoothing, books-balance — all integer-exact, with full 32³ enumeration proofs | tested (11 proofs, `cargo test`) |
| `programs/house` | House program: config/machine/LP/spin accounts, LP share minting, spin commit/settle/expire | **H1 shipped** — compiles + tested (LiteSVM, mock randomness) |

H1 delivers the on-chain skeleton settling against a **mock randomness account**.
Switchboard On-Demand integration is H2; LP epoch withdrawals are H3.

## The house-math contract

The program **never reimplements** odds/exposure/smoothing math — every such value
comes from `house-math`, whose tests are the solvency proofs (RTP band `[92%, 97%]`
holds at the curve extremes for both tiers; worst-case spin ≤ 1% of the pool; books
balance to the lamport over the full outcome space). `base_rtp`/`k_bounds` enumerate
all 32³ outcomes — far too expensive for BPF — so the program reads pinned O(1) k-bound
constants (`SHALLOW_K`/`DEEP_K`) that a proof asserts equal to the enumeration.

## The randomness seam (this session's one architectural decision)

Settlement reads revealed randomness through a single narrow boundary:

```rust
fn revealed_bytes(account: &AccountInfo, expected_key: Pubkey, commit_slot: u64) -> Result<[u8; 32]>
```

Two implementations, selected at compile time:

- **mock** (`mock-randomness` feature) — reads a program-owned `MockRandomness`
  account, fillable via `mock_fill_randomness`. Used by LiteSVM tests only.
- **switchboard** (default / deployable) — a stub returning `NotImplemented`,
  filled in H2.

**Security invariant:** a deployable, fillable randomness source is a
drain-everything backdoor (settle any spin to JACKPOT³). The mock feature is
**non-default and OFF in the deployable build**, so `mock_fill_randomness` and
`MockRandomness` are absent from the shipped program and IDL — enforced by
`tests/test_mock_gate.rs`, which reads the default-build IDL and fails if any
mock surface appears.

## Building and testing

The LiteSVM integration tests load the compiled `.so` via `include_bytes!`, and
the mock tests need the mock feature compiled *into* the `.so`. The default
`anchor build` deliberately does **not** — that is the deployable artifact.

```sh
# 1. deployable build: clean .so + IDL (no mock)
anchor build

# 2. pure-math proofs + the mock-gate check (no mock feature)
cargo test --workspace

# 3. build a test .so WITH the mock, then run the LiteSVM suite under it
cd programs/house && cargo build-sbf --features mock-randomness && cd ../..
cargo test -p house --features mock-randomness
```

`cargo test --workspace` stays green without any feature: it runs the 11
house-math proofs and the mock-gate test; the LiteSVM suite is `#![cfg]`-gated on
`mock-randomness` and is skipped there (it needs the mock `.so` anyway).

## Program identity

The program keypair lives in `keys/` (gitignored, backed up out of
`target/deploy/` so `cargo clean` cannot destroy it), mirroring the
Yvone-Protocol convention. Program id:
`EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ`.
