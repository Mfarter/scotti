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
| `programs/house` | House program: config/machine/LP/spin accounts, LP share minting, spin commit/settle/expire | **H2 shipped** — deployed to devnet, live Switchboard On-Demand randomness |
| `scripts` | devnet ops: config/machine/LP bootstrap, live spin, independent spin verifier | live on devnet (see below) |

H1 shipped the on-chain skeleton settling against a **mock randomness account**.
**H2 replaces the seam's stub with real Switchboard On-Demand randomness, deploys
to devnet, and settles live spins** (see the Devnet section). LP epoch withdrawals
are H3. The mock backend remains a non-default, test-only feature — absent from
the deployed program and IDL (`tests/test_mock_gate.rs`).

## The house-math contract

The program **never reimplements** odds/exposure/smoothing math — every such value
comes from `house-math`, whose tests are the solvency proofs (RTP band `[92%, 97%]`
holds at the curve extremes for both tiers; worst-case spin ≤ 1% of the pool; books
balance to the lamport over the full outcome space). `base_rtp`/`k_bounds` enumerate
all 32³ outcomes — far too expensive for BPF — so the program reads pinned O(1) k-bound
constants (`SHALLOW_K`/`DEEP_K`) that a proof asserts equal to the enumeration.

## The randomness seam

Randomness is read through one narrow compile-time boundary — a commit-side
check and a settle-side read:

```rust
fn commit_seed_slot(account, clock_slot) -> Result<u64>                 // freshness + snapshot
fn revealed_bytes(account, expected_key, expected_seed_slot, clock_slot) -> Result<[u8; 32]>
```

Two backends, selected at compile time:

- **switchboard** (default / deployable, H2) — parses Switchboard On-Demand
  `RandomnessAccountData`. At commit it enforces `seed_slot == clock - 1` (the
  commitment must be one slot old — bundle the Switchboard commit ix in the same
  tx) and snapshots `seed_slot`. At settle it re-checks the account key **and**
  `seed_slot` against the snapshot (a swapped or re-seeded account fails), then
  `get_value(clock)` — which requires the reveal to have landed this slot, so the
  reveal ix is bundled in the settle tx. A spin that never reveals is unreadable
  and routes to `spin_expire`'s refund. Switchboard's `OnDemandError`s map to
  `InvalidRandomnessAccount` / `RandomnessExpired` / `RandomnessNotResolved`.
- **mock** (`mock-randomness` feature) — reads a program-owned `MockRandomness`
  account, fillable via `mock_fill_randomness`. Used by LiteSVM tests only.

The Switchboard verification has unit coverage that crafts `RandomnessAccountData`
bytes directly (malformed / wrong-owner / stale-seed / wrong-key / seed-mismatch /
unrevealed rejected, revealed accepted) — see `switchboard_seam_tests` in
`programs/house/src/lib.rs`.

**Security invariant:** a deployable, fillable randomness source is a
drain-everything backdoor (settle any spin to JACKPOT³). The mock feature is
**non-default and OFF in the deployable build**, so `mock_fill_randomness` and
`MockRandomness` are absent from the shipped program and IDL — enforced by
`tests/test_mock_gate.rs`, which reads the default-build IDL and fails if any
mock surface appears, and re-verified after the H2 changes.

### Dependency note (Switchboard on BPF)

`switchboard-on-demand` (solana-v3 feature, client crates off) resolves cleanly
against our anchor-lang 1.0.1 / Agave-3.x tree — the only friction was its
transitive `switchboard-protos` dragging `getrandom` 0.2 into the on-chain tree
with an OS backend unsupported on the Solana target, fixed with the standard
`getrandom = { features = ["custom"] }` shim (on-chain code never calls it). The
`.so` grew ~2 KB — the protobuf/client code stays out of the program.

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

## Devnet (H2 — live)

The program is deployed and live on **devnet** (upgrade authority
`9Nib5TbPssDvvpuBBS8e4U7EPNoPtx5azExiUgbLPFfF`, the deploy wallet):

| thing | address |
|---|---|
| House program | `EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ` |
| HouseConfig PDA (`["house-config"]`) | `EdQAnjaMztwffrfDVPszqQDcdkUvw97Qb8Fz9fcVS1yk` |
| Demo machine `house-demo-1` | `9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1` |
| Switchboard On-Demand (devnet) | `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` |

Demo machine params: `d_low/d_mid/d_high = 0.5 / 2 / 10 SOL`, `max_exposure_bp =
100` (1%), founding LP bankroll **1 SOL**. Its `smooth_window` is **150 slots**
(~1 min) rather than the production ~9000 (~1h): a fresh machine's *smoothed*
depth starts at zero and would otherwise force near-zero max bets for an hour —
a small window lets the devnet demo reach meaningful bets in a minute. The curve
math is identical; only how fast smoothing converges differs.

### Run a spin (and audit it)

```sh
cd scripts && npm install
npm run init-config            # once: HouseConfig, admin = deploy wallet
SMOOTH_WINDOW=150 npm run create-machine
npm run seed-lp                # deposit ~1 SOL as the founding LP
npm run spin                   # a throwaway player: commit → reveal → settle
npm run verify spins/<sig>.json  # recompute the outcome from chain data
```

`spin` bundles the Switchboard create+commit with `spin_commit` in one tx, waits
for the oracle reveal (~2–4 s observed), then bundles reveal + `spin_settle`, and
prints the reels, payout, exact `pool_value` delta and Solscan URLs. `verify`
re-reads the randomness account and the settle tx from chain and asserts the
house-math recomputation equals the lamports actually paid — the "anyone can
audit any spin" claim as runnable code.

### Three live spins (the H2 artifact)

Real Switchboard randomness, one machine, three outcomes (house partial win,
house full win, 12× player win) — each reconciled to the lamport and
independently re-verified:

| reels | wager | payout | pool Δ | settle tx |
|---|---|---|---|---|
| BAR · BELL · CHERRY | 59410 | 50108 | +9302 | [`2pxdF6…owP3d`](https://solscan.io/tx/2pxdF6FNLw1H9po6tcUs6REDT6LWifVPDxcD4MTcGvFL6jAJ7tKRYji48WPe65eBPvGP17abbFVHzeZvtf1owP3d?cluster=devnet) |
| BLANK · BAR · BAR | 94994 | 0 | +94994 | [`2FMmYd…gHR1XT`](https://solscan.io/tx/2FMmYdbYNCehjsfoSka53cvAzBWyK7uFcwZ56m3T1Yw4KpqVqRwGVkYTtVShsTrUvNjNLQciwsZvKBDZbDgHR1XT?cluster=devnet) |
| BELL · BELL · BELL | 95003 | 1200115 | −1105112 | [`3PN2YB…v8jQ6`](https://solscan.io/tx/3PN2YBiPYHG76Uc6J4gzqbn7PJn5M9BLXZ1A89kwBZvEuM5DVAkxwRvBwCfZmag6wNfpykeBN9XDFRiYMF1v8jQ6?cluster=devnet) |

Full commit/settle signatures and the revealed randomness for each are in
`scripts/spins/`. `spin_expire` (the reveal-never-arrives refund) needs a
~9000-slot (~1h) abandonment, impractical to stage live in one session — it is
covered by the LiteSVM test `e_expiry_refunds_and_releases`.
