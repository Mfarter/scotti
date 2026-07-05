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
| `programs/house` | House program: config/machine/LP/spin accounts, LP share minting, spin commit/settle/expire, epoch-gated withdrawals | **H3 shipped** — upgraded in place on devnet |
| `scripts` | devnet ops: bootstrap, live spin + verifier, machine/LP status read layer, live withdrawal | live on devnet (see below) |

H1 shipped the on-chain skeleton (mock randomness); **H2** wired in real
Switchboard On-Demand randomness on devnet; **H3** adds the LP withdrawal side
(epoch-gated `request_withdraw` / `cancel_withdraw` / `process_withdrawals`), a
cold-start smoothing fix, and the `machineStatus` / `lpStatus` read layer for the
frontend, upgraded in place on devnet. The mock backend remains a non-default,
test-only feature — absent from the deployed program and IDL
(`tests/test_mock_gate.rs`).

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
| Switchboard On-Demand (devnet) | `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` |

The floor is **three machines** placed at visibly different points on their
k-curves so the depth↔RTP economics are legible at a glance — two shallow
(50× frequent-win) at the ceiling and mid-band, one deep (500× jackpot) at the
floor:

| machine | address | placement |
|---|---|---|
| `house-demo-1` | `9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1` | near ceiling · SHALLOW · **~96.7%** |
| `Cold Comfort` | `4Tb4cW8vn4P1aR4Wwnfd1pLZ7hF942FmrLaKWPogzmeD` | mid-band · SHALLOW · **~94.5%** |
| `Leviathan` | `6zsjba9sbx7v8fPrnvyrUDoL1dDaaWcXaigq9swsF2uC` | at the floor · DEEP · **~92%** · 500× jackpot |

The floor manifest (`scripts/machines.ts`) is the source of truth for each
machine's band and founding seed; `npm run bootstrap` creates and seeds any that
are missing (idempotent). The two new machines use the production `smooth_window`
of 9000 slots — H3's cold-start fix seeds the smoothed depth to the founding
bankroll, so they offer full `max_bet` immediately, no 150-slot hack. `house-demo-1`
keeps its original 150-slot window and 0 `epoch_length` (→ 1350-slot default); it
and its H2 spins keep working untouched.

### Run a spin (and audit it)

```sh
cd scripts && npm install
npm run bootstrap              # config + create/seed every machine in machines.ts (idempotent)
npm run spin                   # a throwaway player: commit → reveal → settle
npm run verify spins/<sig>.json  # recompute the outcome from chain data
npm run status [lpOwnerPubkey] # live machine status (the frontend data contract)
npm run withdraw               # throwaway LP: deposit → request → epoch wait → crank
```

`status` prints `machineStatus` (pool + smoothed depth, k, tier, realized RTP,
max_bet, reserved, free liquidity, share price, epoch + next boundary) — the
exact data contract H4's floor UI renders — plus `lpStatus` for an owner. These
live in `scripts/common.ts`, promoted toward SDK shape.

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

### H3 upgrade + live withdrawal

The withdrawal side and read layer were shipped as an **in-place program upgrade**
(same program id). The binary grew 289,128 → 318,176 bytes, so the ProgramData
account was `solana program extend`-ed by 40,960 bytes first (cost **0.285 SOL**);
the upgrade itself then cost ~0.0016 SOL (the buffer rent is reclaimed).

- extend + upgrade tx: [`2owZ3p…njnrC3L`](https://solscan.io/tx/2owZ3pt5HFdjPeUFeAQaiJnnrKu7taaHfskwSVcC4YjvgfEfqGiqBFiJboxWnmFgW5ijQMQpiCLLxdjSonjnrC3L?cluster=devnet)

The pre-H3 demo machine account keeps working unchanged: it predates the
`epoch_length` field, reads it as 0, and falls back to the default (1350 slots).

Live withdrawal on the demo machine — a throwaway LP deposited 0.05 SOL
(50,000,000 lamports → 50,050,090,931,806 shares, worth 49,999,999 at the drifted
price), issued a full `request_withdraw`, waited a real epoch boundary (~9 min),
and a permissionless `process_withdrawals` (cranked by the deploy wallet) paid:

| predicted (price at processing) | vault debited | LP received (payout + rent) | position |
|---|---|---|---|
| 49,999,999 | 49,999,999 ✓ | 51,900,079 | closed, rent reclaimed |

Exact to the lamport; the 1-lamport gap vs the deposit is flooring dust that
stays in the pool (accrues to the remaining LP). Process tx:
[`3BT9ez…fjAfPe`](https://solscan.io/tx/3BT9ezJT6kV5eag8ypLc7WaedcyKBdrgHZUHrBfRUrrVJ6tyXjs18ju7fPM5vRZztvxFDN1i2eJ3zaR8s4fjAfPe?cluster=devnet).

## App (H4/H5 — the Scotti frontend)

`app/` is **Scotti**, a standalone Vite + React + TypeScript site — its own brand,
its own `package.json`, no shared identity or code with Showdown. It reads the
chain directly (no backend): it enumerates machines via `getProgramAccounts`,
renders the live `machineStatus` data contract, runs the spin flow ported from
`scripts/devnet-spin.ts` against a wallet-adapter wallet, and recomputes any
spin's outcome in the browser (the `verify-spin` logic). Every page carries the
persistent devnet banner.

Pages: **The Floor** (the three machines above, sorted by realized RTP — the glow
runs hotter as the odds improve, with a one-line explainer of the depth↔odds
mechanic), **Machine** (three-reel spin, payout math, Solscan links, per-spin
in-browser Verify), **Liquidity** (position, deposit, epoch-gated request/cancel,
a permissionless process crank, and an honest yield display — share price + an EV
calculator + variance warning, `edge × volume ÷ pool`, explicitly not an APY),
and **Fair?** (the trust story + the three H2 spins, each verifiable in-browser).

### Session chips (H5 — one confirmation per sitting)

By default a spin needs two wallet prompts (place wager, settle). **Buy chips** to
skip them: one wallet-signed transfer funds an ephemeral browser key (stored in
`localStorage`), which then plays as player + payer — spins and settles are
**promptless and auto-settle** on reveal. The header shows the live chip balance;
**Cash out** sweeps the balance (minus the base fee) back to your wallet, signed
by the session key, and clears storage; **Top up** adds more. Client-side only,
no program change. The sharp edges are handled: a wager the chips can't cover is
refused with a top-up nudge; a pending spin blocks cash-out (never strand a
`PendingSpin`); reconnecting a different main wallet shows provenance and asks
where to sweep (original vs current) rather than silently redirecting; and the
sweep drains the 0-data session account to exactly zero (no rent dust). The
honesty is stated in the buy-in modal and on the Fair page: the chips live behind
a browser-stored key — anyone with this browser profile can spend them, clearing
site data without cashing out loses them, and the loss is bounded by the buy-in.

### Run it

```sh
cd app
cp .env.example .env       # set VITE_RPC_URL to a devnet RPC (public is fine, rate-limited)
npm install
npm run dev                # http://localhost:5173
npm run build              # tsc + vite build → dist/  (clean)
npm run preview            # serve the production build
```

`VITE_RPC_URL` is the only config and is never committed (`.env` is gitignored;
`.env.example` documents it). The lib layer (`app/src/lib/`) is a browser port of
`scripts/common.ts` — house-math, PDAs, decoders, `machineStatus`/`lpStatus`, the
spin flow, and the verifier — using a browser `sha256` and node polyfills for the
Switchboard SDK (`vite-plugin-node-polyfills`); the `scripts/` are untouched.

### Static deploy (Vercel / Netlify / any static host)

There is no server — it's all chain reads — so deploy `dist/` as static files.
The app uses hash routing (`/#/machine/…`), so **no SPA rewrite rule is needed**;
point the host at `app/` with build command `npm run build` and output directory
`dist`, set `VITE_RPC_URL` as an environment variable, and that's it.

### Verified (H4/H5)

Headless (Playwright) against the live devnet floor: it renders all **three**
machines with the RTP spread (`96.74 / 94.5 / 92`), correctly sorted descending,
the DEEP 500× badge on `Leviathan`, the mechanic explainer, and the persistent
banner; the buy-in modal shows the chips honesty text; the in-browser **Verify**
recomputes an H2 artifact and matches the on-chain payout to the lamport
(`50108 == 50108`); no horizontal overflow at 380px; console clean; `npm run
build` clean.

The two paths a headless browser can't drive without a human were exercised
against devnet with node harnesses reusing the app's own code: the ported
`spin_commit`/`spin_settle` builders settled a real spin (reconciled to the
lamport), and the **promptless chips flow** — buy-in → three session-key spins
(auto-settle) → cash-out sweep — reconciled exactly (session drained to zero,
main wallet received exactly the swept amount). The only step still needing a
human is the single wallet-signature popup (connect, then buy-in or a wallet-mode
spin) — standard wallet-adapter plumbing.
