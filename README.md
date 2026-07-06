# Scotti — Yvone House Module

Scotti is peer-to-house games backed by liquidity pools, where the odds are a
**published, deterministic function of pool state** — an AMM for luck. Each
machine is a bankroll that LPs fund; a spin's RTP, volatility tier, and maximum
bet are all read off the pool's own depth through a function anyone can inspect
and recompute. The house edge accrues to LPs as share-price drift; players can
audit any spin from chain data alone. [`HOUSE-SPEC.md`](./HOUSE-SPEC.md) is the
design source of truth; [`H6-DUAL-ASSET-SPEC.md`](./H6-DUAL-ASSET-SPEC.md) covers
the dual-asset (SOL-in / token-out) extension.

**What is proven.** The program is live on devnet with real Switchboard
On-Demand randomness. Every economic claim is a machine-checked proof or a
recompute-verified on-chain artifact: `house-math` enumerates the full outcome
space and holds the RTP band by construction (48 proofs), and each live spin,
withdrawal, dual-asset spin, and compound reconciles to the base unit against an
independent recomputation from chain data (see *What's live on devnet*).

> **Legal posture (fixed).** This is a **devnet demonstration only.** Real-money
> operation is a **licensed-casino activity AND a pooled investment product** —
> and the dual-asset machines add a **token-issuance / market** dimension on top.
> This is not a "consult counsel" gray zone; it is the regulated thing itself,
> and nothing here pretends otherwise. Out of scope by design.

## How it works

- **Machines.** A v0 machine is 3 reels × 32 stops (32³ = 32,768 equally-likely
  triples), one payline, paytable expressed in basis points of the wager so
  fractional multipliers stay integer-exact. Two tiers, engineered to
  near-identical base RTP: **SHALLOW** (max 50×, frequent small wins) and **DEEP**
  (max 500×, rare jackpots).
- **LPs and yield.** LPs deposit into a machine's vault and hold pro-rata shares.
  The edge on every spin accrues to the pool, so share price drifts up with
  volume and down with jackpot variance. Yield is share-price appreciation —
  **never a promised APY.**
- **RTP band by depth.** Realized RTP = `RTP_base × k(D)`, where `k` is a
  piecewise-linear function of pool depth `D`: cold/shallow machines pay near the
  ceiling, hot/deep machines compress toward the floor. The band
  `[92%, 97%]` holds at both curve extremes for both tiers — a proof obligation,
  not a tuning goal. Player flow is the arbitrage that rebalances machines.
- **Volatility by depth.** Deeper vaults unlock the higher-multiplier tier; max
  bet is solvency-derived so one spin's worst case is capped at **≤ 1% of the
  pool** (`MAX_EXPOSURE_BP = 100`). Every pending spin escrows its max payout, so
  concurrent spins cannot jointly breach solvency.
- **Randomness.** Switchboard On-Demand TEE-backed commit/reveal, read through
  one narrow compile-time seam. Every input to an outcome is public — strips,
  the commit snapshot, the revealed VRF bytes — so any spin recomputes from
  chain alone.

**The invariant that makes it a casino and not a faucet:** RTP < 100% in every
reachable state. `house-math` enumerates all 32³ outcomes and asserts it;
anything the proofs cannot establish does not ship.

## The discipline

**House-math as proof.** The program **never reimplements** odds, exposure, or
smoothing math — every such value comes from `crates/house-math`, a
dependency-free, integer-exact crate whose tests *are* the solvency proofs: the
RTP band at the curve extremes, worst-case spin ≤ 1% of pool, and books that
balance to the lamport over the full outcome space (Σ payouts + Σ retained =
Σ wagers exactly). `base_rtp`/`k_bounds` enumerate all 32³ outcomes — far too
expensive for BPF — so the program reads pinned O(1) k-bound constants
(`SHALLOW_K`/`DEEP_K`) that a proof asserts equal to the enumeration. **48 proofs
green.**

**The seam pattern.** Every source of trust — randomness, price, AMM swap — is
read through one narrow compile-time boundary with two backends: the real one
(deployable) and a mock (test-only, behind a non-default feature). A deployable,
fillable randomness or price source would be a drain-everything / mint-arbitrary
backdoor, so the mock code is **absent from the shipped program and IDL**. This
is *enforced*, not merely intended: `tests/test_mock_gate.rs` reads the
default-build IDL and fails if any mock surface (`mock_fill_randomness`,
`mock_set_price`, `MockRandomness`, …) appears. The three mock features
(`mock-randomness`, `mock-price`, `mock-swap`) are compiled in only for the
LiteSVM suites.

The randomness seam is two functions — a commit-side freshness check and a
settle-side read:

```rust
fn commit_seed_slot(account, clock_slot) -> Result<u64>                 // freshness + snapshot
fn revealed_bytes(account, expected_key, expected_seed_slot, clock_slot) -> Result<[u8; 32]>
```

The deployable **switchboard** backend parses Switchboard On-Demand
`RandomnessAccountData`: at commit it enforces `seed_slot == clock − 1` (the
Switchboard commit ix is bundled in the same tx) and snapshots the slot; at
settle it re-checks the account key **and** seed slot against the snapshot (a
swapped or re-seeded account fails), then `get_value(clock)` — which requires the
reveal to have landed this slot, so the reveal ix is bundled in the settle tx. A
spin that never reveals is unreadable and routes to `spin_expire`'s refund. The
seam has direct unit coverage crafting `RandomnessAccountData` bytes
(malformed / wrong-owner / stale-seed / wrong-key / seed-mismatch / unrevealed
rejected, revealed accepted — `switchboard_seam_tests` in `programs/house/src/lib.rs`).

*Dependency note:* `switchboard-on-demand` (solana-v3 feature, client crates off)
resolves cleanly against anchor-lang 1.0.1 / Agave-3.x; the only friction was its
transitive `switchboard-protos` dragging `getrandom` 0.2 into the on-chain tree
with an unsupported OS backend, fixed with the standard
`getrandom = { features = ["custom"] }` shim (on-chain code never calls it). The
`.so` grew ~2 KB — the protobuf/client code stays out of the program.

**Ground-truth before trust.** Nothing trusts an external byte layout it has not
watched move on the live chain first:

- *Raydium CLMM layout.* The deployed `PoolState`/`ObservationState` are
  `#[repr(C, packed)]` zero-copy accounts. Offsets were pinned in
  `scripts/layouts.ts` and proven against the *live* accounts by executing known
  swaps and watching them move (`scripts/prove-layouts-with-swaps.ts`): tick @269
  and sqrt_price @253 shifted on every swap and stayed mutually consistent
  (`1.0001^tick ≈ price`); observation index @17 advanced once per >15 s window;
  the new observation's `tick_cumulative` accrued exactly `prior_tick × Δt`
  (e.g. `ΔtickCum/Δt = 68912.0`, the standing tick). **The packed layout is the
  trap:** a naive `#[repr(C)]` CPI struct mis-places `recent_epoch` /
  `observation_index` and reads `tick_cumulative` at +8 instead of +4. Confirmed
  from bytes: **observations store cumulative tick only** (block_timestamp u32 +
  tick_cumulative i64 + 32 zero pad — no Uniswap-style sqrt/secondsPerLiq), and
  the ring is **100** wide with the index living in ObservationState, not
  PoolState. `scripts/verify-layouts.ts` re-checks every pin and exits non-zero on
  drift.
- *swap_v2 CPI.* Before wiring the real Raydium `swap_v2` into `compound_epoch`,
  the instruction was ground-truthed against a live devnet keeper swap
  ([`5XcKLe…`](https://solscan.io/tx/5XcKLeGcHVcdDf8faCutjZ1BH22dgWYgjE49Dg56S6MoE4iSPMdzc6DcC2xF1m26jkEoTjETN4KhAV9XWehKXFVk?cluster=devnet),
  log `Instruction: SwapV2`) — accounts and discriminator confirmed on chain, then
  reproduced as a signed CPI.

## What's live on devnet

The program is deployed and live on **devnet** (upgrade authority
`9Nib5TbPssDvvpuBBS8e4U7EPNoPtx5azExiUgbLPFfF`, the deploy wallet):

| thing | address |
|---|---|
| House program | `EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ` |
| HouseConfig PDA (`["house-config"]`) | `EdQAnjaMztwffrfDVPszqQDcdkUvw97Qb8Fz9fcVS1yk` |
| Switchboard On-Demand (devnet) | `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` |

**The floor — three single-asset machines** placed at visibly different points on
their k-curves so the depth↔RTP economics are legible at a glance: two shallow
(50× frequent-win) at the ceiling and mid-band, one deep (500× jackpot) at the
floor.

| machine | address | placement |
|---|---|---|
| `house-demo-1` | `9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1` | near ceiling · SHALLOW · **~96.7%** |
| `Cold Comfort` | `4Tb4cW8vn4P1aR4Wwnfd1pLZ7hF942FmrLaKWPogzmeD` | mid-band · SHALLOW · **~94.5%** |
| `Leviathan` | `6zsjba9sbx7v8fPrnvyrUDoL1dDaaWcXaigq9swsF2uC` | at the floor · DEEP · **~92%** · 500× jackpot |

`scripts/machines.ts` is the source of truth for each machine's band and founding
seed; `npm run bootstrap` creates and seeds any that are missing (idempotent). The
two newer machines use the production `smooth_window` of 9000 slots — H3's
cold-start fix seeds the smoothed depth to the founding bankroll, so they offer
full `max_bet` immediately with no ramp. `house-demo-1` keeps its original
150-slot window and `epoch_length = 0` (→ 1350-slot default); it and its H2 spins
keep working untouched.

**The dual-asset machine** (SOL in, CHIP out) runs against the live Raydium
CHIP/WSOL CLMM pool — see *Dual-asset machines* below for the design.

| machine | address |
|---|---|
| `dual-chip-1` | `6vyARZoi4Kc81ZLHYxYDhE4JGH5Db4zf1u8xvLJEvYzL` |

### Verified artifacts (each reconciled to the base unit by independent recompute)

| artifact | proof link | what it proves |
|---|---|---|
| H2 spin — BAR · BELL · CHERRY (partial win) | [`2pxdF6…owP3d`](https://solscan.io/tx/2pxdF6FNLw1H9po6tcUs6REDT6LWifVPDxcD4MTcGvFL6jAJ7tKRYji48WPe65eBPvGP17abbFVHzeZvtf1owP3d?cluster=devnet) | wager 59410 → payout 50108, pool Δ +9302; recompute matches |
| H2 spin — BLANK · BAR · BAR (house full win) | [`2FMmYd…gHR1XT`](https://solscan.io/tx/2FMmYdbYNCehjsfoSka53cvAzBWyK7uFcwZ56m3T1Yw4KpqVqRwGVkYTtVShsTrUvNjNLQciwsZvKBDZbDgHR1XT?cluster=devnet) | wager 94994 → payout 0, pool Δ +94994 |
| H2 spin — BELL · BELL · BELL (12× player win) | [`3PN2YB…v8jQ6`](https://solscan.io/tx/3PN2YBiPYHG76Uc6J4gzqbn7PJn5M9BLXZ1A89kwBZvEuM5DVAkxwRvBwCfZmag6wNfpykeBN9XDFRiYMF1v8jQ6?cluster=devnet) | wager 95003 → payout 1200115, pool Δ −1105112 |
| H3 extend + upgrade | [`2owZ3p…njnrC3L`](https://solscan.io/tx/2owZ3pt5HFdjPeUFeAQaiJnnrKu7taaHfskwSVcC4YjvgfEfqGiqBFiJboxWnmFgW5ijQMQpiCLLxdjSonjnrC3L?cluster=devnet) | in-place upgrade added the withdrawal side, same program id; legacy machine unaffected |
| H3 live withdrawal (`process_withdrawals`) | [`3BT9ez…fjAfPe`](https://solscan.io/tx/3BT9ezJT6kV5eag8ypLc7WaedcyKBdrgHZUHrBfRUrrVJ6tyXjs18ju7fPM5vRZztvxFDN1i2eJ3zaR8s4fjAfPe?cluster=devnet) | epoch-gated crank paid predicted == vault-debited to the lamport (49,999,999) |
| H6b-3 program upgrade | [`54YAPz…`](https://solscan.io/tx/54YAPz3Y4PBkgDfB3QfKXwGLbi5D4CyBRBW37e6CMEmjsKb3u646tYj8ZVPGEaYSHEjjAdZ2L7eJrHVEQzBdnKUU?cluster=devnet) | in-place upgrade (extend 240 KB + redeploy) added dual-asset core; legacy machines still spin |
| H6b-3 `spin_commit_dual` | [`5m6FfG…`](https://solscan.io/tx/5m6FfGYuHHJDLoFqPNLFHkgHSsFQLRSz8RYvZxUiUQa7oh7D1RxsCKqJgNdE7MVGjpqosQ5JaTCb1j1c3E8eWewS?cluster=devnet) | SOL wager priced by the real on-chain CLMM TWAP (972.00 CHIP/SOL, spot within 18bp) |
| H6b-3 `spin_settle_dual` | [`5ATign…`](https://solscan.io/tx/5ATignq4R8L4PoXSWm15fPQW1w8AxbnRo7nKFfGdMU12Aer43FdAAzgFcZ1Esyptq8sh8VQJe2NSEhsEGE22Adr5?cluster=devnet) | Switchboard-settled CHIP payout matched recompute to the base unit (803805307) |
| H6b-3 `claim_sol` | [`46y4nJ…`](https://solscan.io/tx/46y4nJtBM6EYJvgbo7mVyCfy2yMXdhnDe3h1iz2DiJENrp9vnQqBQE4z9ZrKrLLkaFbpRGe7u9fbsnKkxsWfyKZ2?cluster=devnet) | SOL dividend paid from the MasterChef ledger |
| H6c-1 live `compound_epoch` | [`5P8zLq…`](https://solscan.io/tx/5P8zLq6tqBtX35xvH2k8VeksddoJ6VoXmkjnKKsubc2JTGm4mJ5j95xBn9ALCndv1UWPbYL6cPUsTDov7KF9zWQP?cluster=devnet) | real `swap_v2` CPI (174,732 CU): machine SOL −earmark, vault CHIP +3,913,661,140 (≥ TWAP×(1−band)), shares minted non-dilutively |
| H6c-2 UI dual spin (`spin_settle_dual`) | [`Gc874Z…`](https://solscan.io/tx/Gc874Zcxrh37PWL9mpce8NWTUx7pYtjPfW1BpB9B8C7ynfmcKSoCkrUTVXMdApg7skKWnpwhoVZoAhc6LGZ5Uv2?cluster=devnet) | CHERRY · BLANK · CHERRY, 3.83 CHIP, recompute == paid; price independently recomputed from the ring at 977.67 vs the 977.65 snapshot (0.15 bp) |

The three H2 spins' full commit/settle signatures and revealed randomness live in
`scripts/spins/`. `spin_expire` (reveal-never-arrives refund) needs a ~9000-slot
(~1 h) abandonment, impractical to stage live in one session — it is covered by
the LiteSVM test `e_expiry_refunds_and_releases`.

**H3 upgrade economics.** The binary grew 289,128 → 318,176 bytes, so ProgramData
was `solana program extend`-ed by 40,960 bytes first (cost **0.285 SOL**); the
upgrade itself cost ~0.0016 SOL (buffer rent reclaimed). The pre-H3 demo machine
predates the `epoch_length` field, reads it as 0, and falls back to the 1350-slot
default — backward compatible.

**H3 live withdrawal detail.** A throwaway LP deposited 0.05 SOL (50,000,000
lamports → 50,050,090,931,806 shares, worth 49,999,999 at the drifted price),
issued a full `request_withdraw`, waited a real epoch boundary (~9 min), and a
permissionless `process_withdrawals` paid **49,999,999** (vault debited exactly
that; LP received 51,900,079 incl. reclaimed rent; position closed). The
1-lamport gap vs the deposit is flooring dust that stays in the pool for the
remaining LPs.

**H6b-3 live dual spin detail.** The commit snapshotted
`price_at_commit = 972.00 CHIP/SOL` (spot within 18bp); the settle's CHIP payout
matched an independent recompute to the base unit (`803805307`); `claim_sol` paid
the accrued dividend. The live H3 single-asset machines still read and spin — the
upgrade is backward-compatible.

**H6c-1 live compound detail.** `compound_epoch`'s AMM CPI is the real Raydium
CLMM `swap_v2`: the machine's earmarked SOL is wrapped to WSOL and swapped into
CHIP straight into the vault (swap signed by the machine PDA), then minted into
shares at the pre-swap price. Independent recompute confirmed machine SOL down by
exactly the earmark (0.004 SOL), vault CHIP up by the swap output (3,913,661,140
base units ≥ `min_out` = TWAP×(1−band)), and shares minted ==
`compound_mint_shares` — on both the machine and the position. The WSOL is
**fronted by the crank** (a program-owned PDA cannot be a system-transfer source)
and reimbursed out of the machine as the swap's last op, so the machine's lamport
delta is exactly the earmark and the only balance check is at instruction return.

## Dual-asset machines (SOL in, SPL out)

A dual-asset machine takes SOL wagers and pays an SPL token, priced by the
token's Raydium CLMM TWAP read **on-chain**. The game math is unchanged; what is
new is a price input, a token vault with CPI transfers, dual-asset LP accounting,
and the manipulation defenses a price input demands. Full design in
[`H6-DUAL-ASSET-SPEC.md`](./H6-DUAL-ASSET-SPEC.md); in brief:

- **TWAP snapshot at commit.** `spin_commit_dual` snapshots
  `price_at_commit = TWAP` (token per SOL, 1e12 fixed point). Settle pays
  `payout_tokens = wager × mult × k ÷ price_at_commit`, deterministic the moment
  the wager locks — player slippage is zero by construction; the reveal window's
  drift lands on LPs as symmetric noise. `house-math::clmm` parses
  PoolState/ObservationState via the pinned offsets; `spot_1e12` and the 5-min
  TWAP `avg_tick` reproduce `twap-status.ts` exactly.
- **Two gates.** *Band gate:* at commit, read both TWAP and spot; if
  `|spot − twap| / twap > band_bp` (default 300 = 3%), refuse (`PriceUnstable`) —
  manipulating the snapshot then requires displacing the whole-window TWAP while
  holding spot near it, self-contradictory. *Staleness gate:* if the newest
  observation is older than `max_staleness`, refuse (`PriceStale`); a keeper (or
  anyone's swap) freshens the ring — operational convenience, not a trust
  component.
- **Haircut reserve.** The pending-spin escrow reserves
  `max_payout × (1 + haircut_bp)` (default 1500 = 15%) so adverse drift during the
  reveal window cannot make settle insolvent; unused haircut releases at settle.
- **Margin floor.** A `house-math` invariant links the band gate to a tighter
  dual RTP band `[92%, 95%]`: `RTP_MAX × (BP + band) ≤ (BP − m) × BP`, i.e.
  **95% × 1.03 = 97.85% ≤ 98%** — with an exhaustive ~15M-config sweep proving no
  accepted parameter set can cross it (the 300bp cap sits 15bp inside the true
  boundary).
- **SOL dividend ledger.** SOL wager accrual is distributed to LPs by a MasterChef
  per-share accumulator (`acc_sol_per_share` + position `sol_debt`), so a new
  deposit is entitled to **zero** prior accrual (no dilution, proven). Accrued SOL
  is dividend income, never at-risk capital — curve depth is **token-side only**.
- **Reward modes.** `claim_sol` (take the SOL dividend) or `earmark_sol` +
  `compound_epoch` (swap earmarked SOL into CHIP via the real `swap_v2`, minting
  shares) — `set_reward_mode` chooses; SPL mode is recurring on-chain buy pressure
  for the token, stated honestly.
- **Price-free deposits and exits.** Deposits are **token-only and price-free**
  (`mint = token_amount × total_shares ÷ token_balance`), so `spin_commit` stays
  the *only* price-touching instruction — strictly safer than value-pricing, which
  would let an attacker inflate the TWAP at deposit to mint excess shares.
  Withdrawals pay `shares/total_shares` of **both** assets, price-free and
  manipulation-immune; "excess SOL evenly distributed between stakers" falls out
  automatically.

### Price infrastructure ground-truth (H6a)

The dual-asset work rests on H6a, the price-infra spike (scripts + pure math, no
program changes) that de-risked the two external unknowns — the deployed CLMM's
*real* account layouts (the ground-truth story above) and devnet pool operability.

**Verified devnet CLMM program id.** Read verbatim from the Raydium SDK v2
`programId.ts` (`DEVNET_PROGRAM_ID` — the remembered `devi51mZ…` id is a
documented trap; Raydium migrated devnet to `DRay…` vanity addresses), then
confirmed on chain: `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH` — owner
`BPFLoaderUpgradeab1e…`, executable, 1,470,141 bytes of bytecode, live upgrade
authority. Not a dead shell.

**Demo market — Scotti Chip (CHIP).** A 9-decimal SPL token (10,000,000 supply)
paired with WSOL in a CLMM pool at **1 CHIP = 0.001 SOL** (pool orientation
mintA = WSOL, mintB = CHIP → internal 1000 CHIP/SOL), seeded with a concentrated
position of **0.3 WSOL + 266 CHIP** over ticks [63970, 74950] (≈ 600–1800
CHIP/SOL, AmmConfig index 2: tickSpacing 10, 0.05% fee).

| thing | address |
|---|---|
| CLMM program (devnet) | `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH` |
| CHIP mint (9 dec) | `75zyWBYdFSNNFKDaTdEu9nZWdHaZCuuCd7tgCCxi2w6p` |
| CLMM pool (PoolState) | `9n6LAVickwVAnDL4rHUZXAXkoMSG5794fKRgrXSfXn1n` |
| ObservationState (TWAP ring) | `7nPBDXZVazj9w4GsuwjHx3qF5EffQCpvSKPj9p55QsgU` |
| AmmConfig (tickSpacing 10) | `FZdkW5jiYsjTnCVqFqPrxrQisQkCYrohd7ArZhoKnM8q` |
| pool vaults (WSOL / CHIP) | `3EUFyDquUtefjCbBzVb4u489XULqedKH14LJxwU57Fi9` / `EhArexxoDzkBeymW5UuJJvRPMLn6AZMTTzZ2nvHMHz1S` |

Costs (devnet, deploy wallet): token mint+ATA+supply **0.0035 SOL**, pool creation
**0.0615 SOL**, seed liquidity + tick-array/position rents **0.4658 SOL** (~0.3
recoverable as position, ~0.16 as reclaimable rent), all swaps net **~0.016 SOL** —
session total **0.547 SOL**.

**TWAP + keeper made observable.** `scripts/twap-status.ts` prints spot (from
sqrt_price), the 5-minute TWAP (`avg_tick = ΔtickCum/Δt`, `price = 1.0001^avg_tick`),
observation freshness vs `max_staleness`, band status vs 300bp, and the
`price_at_commit` a machine would snapshot — with cold-start and staleness as
explicit **STALE** states. `scripts/keeper.ts` is a paced alternating-direction
dust-swap loop that keeps the ring fresh at ≈ break-even (the 0.05% fee returns to
the keeper-as-LP). `scripts/twap-demo.ts` drives the live pool through the full
story — STALE → LIVE → band flip OUT → recovery IN → staleness fires — with the
5-minute TWAP visibly lagging a keeper-induced spot move (960→872 while TWAP holds
~960), the band gate flipping OUT past 300bp and back IN, and staleness firing once
the keeper stops and the newest observation ages past 90 s. The price protection,
observable end to end on devnet (captured run: `scripts/twap-demo-output.txt`).

**The pure-math backing** (`crates/house-math`): `price.rs` (tick→`sqrt_price_x64`
via the 19 per-bit magic multipliers, pinned vectors cross-checked two independent
ways by `proofs/tick_price_crosscheck.py`, boundary ticks matching Raydium's
published MIN/MAX_SQRT_PRICE_X64 and tick 69081 bracketing the live pool),
`twap.rs` (TWAP-from-cumulative with wraparound / single-obs / stale-window edge
cases), and `margin.rs` (the margin-floor invariant + the ~15M-config sweep). At
H6a this crate stood at **30 proofs**; the dual-asset program work carried it to
the **48** it holds today.

## The app — Scotti frontend

`app/` is **Scotti**, a standalone Vite + React + TypeScript site — its own brand,
its own `package.json`, no shared identity or code with Showdown. It reads the
chain directly (no backend): it enumerates machines via `getProgramAccounts`,
renders the live `machineStatus` data contract, runs the spin flow against a
wallet-adapter wallet, and recomputes any spin's outcome in the browser. The lib
layer (`app/src/lib/`) is a browser port of `scripts/common.ts` — house-math,
PDAs, decoders, the CLMM offsets + TWAP math (`lib/clmm.ts`, mirroring
`scripts/layouts.ts` + `scripts/twap.ts`), the spin flow, and the verifier — using
a browser `sha256` and node polyfills for the Switchboard SDK; the `scripts/` are
untouched. Every page carries the persistent devnet banner.

**Pages.** *The Floor* (all machines sorted by realized RTP — the glow runs hotter
as odds improve; the dual `dual-chip-1` renders as its own card paying CHIP with a
SOL-value at the TWAP, RTP band [92,95], and a live PRICE-STATUS chip
LIVE / PRICE UNSTABLE / STALE computed client-side). *Machine* (three-reel spin,
payout math, Solscan links, per-spin in-browser Verify). *Dual machine*
(`/dual/:pubkey`: SOL wager in / CHIP out, payouts shown in CHIP with a live
SOL-value, the committed price snapshot per result, and an effective-RTP-at-spot
readout — spins disabled with the exact on-chain refusal reason when a gate would
reject, so no fees burn on a sure refusal). *Liquidity* (single-asset position +
epoch-gated request/cancel + permissionless crank + honest yield display: share
price, EV calculator, variance warning — `edge × volume ÷ pool`, explicitly not an
APY; and a dual section: price-free CHIP deposit, position value + pending SOL
dividend, reward-mode choice with the SPL-buy-pressure side effect stated,
price-free both-asset withdrawals, and the third disclosure — token-denominated
risk on top of bankroll variance). *Fair?* (the trust story, the three H2 spins
verifiable in-browser, and a dual-asset section: TWAP-not-spot, the two gates, the
haircut reserve, the margin-floor invariant, effective-RTP-at-spot).

**Session chips (one confirmation per sitting).** By default a spin needs two
wallet prompts. **Buy chips** to skip them: one wallet-signed transfer funds an
ephemeral browser key (in `localStorage`) that plays as player + payer — spins and
settles are promptless and auto-settle on reveal. **Cash out** sweeps the balance
(minus base fee) back to your wallet and clears storage; **Top up** adds more.
Client-side only, no program change. The sharp edges are handled: an uncoverable
wager is refused with a top-up nudge; a pending spin blocks cash-out (never strand
a `PendingSpin`); reconnecting a different main wallet shows provenance and asks
where to sweep; the sweep drains the 0-data session account to exactly zero (no
rent dust). The honesty is stated in the buy-in modal and on Fair: the chips live
behind a browser-stored key — anyone with this browser profile can spend them,
clearing site data without cashing out loses them, and the loss is bounded by the
buy-in.

**Verified.** Headless (Playwright) against the live floor: all three single-asset
machines render with the RTP spread (`96.74 / 94.5 / 92`), sorted descending, the
DEEP 500× badge on `Leviathan`, the mechanic explainer, the persistent banner, the
chips honesty text; in-browser **Verify** recomputes an H2 artifact to the lamport
(`50108 == 50108`); no horizontal overflow at 380px; console clean; `npm run build`
clean. The paths a headless browser can't drive without a human were exercised
against devnet with node harnesses reusing the app's own code: the ported
`spin_commit`/`spin_settle` builders settled a real spin (reconciled to the
lamport); the promptless chips flow (buy-in → three session-key spins → cash-out
sweep) reconciled exactly; and the **H6c-2 dual spin** ran through the app's
session-key dual-spin code (`app/_dualspin-harness.ts` → `src/lib/dualspin.ts`) —
CHERRY · BLANK · CHERRY, 3.83 CHIP, recompute == paid to the base unit — with the
extended `verify-spin.ts` independently recomputing `price_at_commit` from the
observation ring at 977.67 vs the 977.65 snapshot (0.15bp), the implied k in range
for SHALLOW only. The only step still needing a human is the single wallet-signature
popup (connect, then buy-in or a wallet-mode spin) — standard wallet-adapter
plumbing.

## The indexer (optional off-chain service)

The app is pure chain-reads, which is why it honestly *deferred* a trailing
share-price chart: that needs history, and history needs something to record it.
`indexer/` is that something — a **standalone** TypeScript/node service (its own
`package.json`) that samples every machine's share price on an interval and walks
the program's settle history into a spin feed, served over a small read-only JSON
API. It is the **first non-chain-read data path** in the project, and it is built
to earn that trust rather than assume it.

- **Reuses, never re-derives.** All decoding and house-math come from `../scripts`
  (the exact code `verify-spin.ts` runs) plus the DualMachine offsets ported from
  the app — a single `reuse.ts` boundary. The indexer defines no layout of its own.
- **Every spin is recomputed at ingest.** Reels from the randomness account, wager
  from the commit tx, payout from the settle tx's balance/token delta — checked
  against house-math, exactly like `verify-spin`. Each row is stored with its
  status: **verified** (recompute matched), **partial** (reels + payout confirmed
  but a dual price aged out of the 100-slot observation ring), **unverifiable**
  (randomness closed / commit aged out of RPC), or **mismatch**. A mismatch is a
  loud stop condition, never silently stored as ok.
- **Share-price semantics, kept separate.** Single-asset = pool_value / total_shares
  (lamports per share). Dual-asset: the **primary** series is token-per-share
  (price-free, manipulation-immune); a **secondary**, clearly-labeled series adds
  the pending SOL dividend and the token value at the TWAP (price-dependent, shown
  only when the CLMM price is LIVE). They are never blended into one number.
- **Backfill honesty.** It records the earliest indexed slot/time per machine and
  serves it, so the app says "history begins &lt;date&gt;" instead of implying
  completeness — devnet RPC history is finite.
- **Storage + serving.** SQLite via `node:sqlite` (one file, one migration — no
  native deps, no external services); HTTP via `node:http`, CORS wide open (public
  devnet data). No writes, no auth, no state beyond the file.

**The trust model, stated where it renders.** Indexed data is convenient and
recompute-checked, but it is served by an operator who could omit or reorder rows —
so wherever it appears (the LP chart, the machine spin feed) the app marks it *"from
the Scotti indexer — an off-chain service… you can verify any spin yourself
in-browser,"* every spin row shows its recompute badge, and the Fair page carries a
note distinguishing trustless chain-reads from this convenient-but-operator-served
layer (same register as the session-chips custody disclosure). Set
`VITE_INDEXER_URL` to switch it on; **leave it unset and the app behaves exactly as
before** — the chart stays deferred, no indexer calls fire.

```sh
cd indexer && npm install
cp .env.example .env             # optional; every value has a default
npm run ingest -- --once         # a single pass (backfill + one price sample); CI-friendly, exits non-zero on a mismatch
npm run dev                      # ingest loop + API together
npm run serve                    # API only          → http://localhost:8787
npm test                         # 20 tests: parsers + recompute + idempotency + share-price math (offline fixtures)
# API: GET /health · /machines · /machines/:pk/price?from&to&resolution · /machines/:pk/spins?limit&before
```

Then point the app at it: `VITE_INDEXER_URL=http://localhost:8787 npm run dev` in
`app/`.

## Repo map

| path | what | status |
|---|---|---|
| `HOUSE-SPEC.md` | module design v0 (single-asset) | source of truth |
| `H6-DUAL-ASSET-SPEC.md` | dual-asset design (SOL in, SPL out) | source of truth |
| `crates/house-math` | dependency-free integer-exact machine math: paytables, RTP curve `k(D)`, exposure cap, depth smoothing, books-balance, tick→price fixed point, TWAP-from-cumulative-ticks, margin-floor invariant, token payout + value-RTP-invariance + haircut-solvency, MasterChef SOL dividend ledger, CLMM byte parser + compound share-minting — with full 32³ enumeration proofs | 48 proofs (`cargo test`) |
| `programs/house` | House program: config / machine / LP / spin accounts, spin commit/settle/expire, epoch-gated withdrawals, and dual-asset `DualMachine` (SOL in / SPL out): token vault, on-chain CLMM price reader + band/staleness gates, haircut reserve, price-free token deposits, SOL dividend ledger + SOL/SPL reward modes, price-free dual-asset withdrawals, `compound_epoch` (real `swap_v2`) | live on devnet |
| `scripts` | devnet ops: bootstrap, live spin + verifier, machine/LP status read layer, live withdrawal, CLMM pool + layout ground-truth + TWAP/keeper, dual spin + compound | live on devnet |
| `app` | Scotti frontend (Vite + React + TS) | live |
| `indexer` | standalone off-chain service: share-price sampling + spin feed (each spin recomputed at ingest), SQLite + read-only JSON API | tests green; opt-in via `VITE_INDEXER_URL` |

## Reproduce it

**Build and test.** The LiteSVM integration tests load the compiled `.so` via
`include_bytes!`, and the mock suites need their mock features compiled *into* the
`.so`. The default `anchor build` deliberately does **not** — that is the
deployable artifact.

```sh
# 1. deployable build: clean .so + IDL (no mocks)
anchor build

# 2. pure-math proofs (48) + switchboard seam unit tests + the mock-gate check
cargo test --workspace                      # green with NO feature flags

# 3. the single-asset LiteSVM suite (needs the randomness mock in the .so)
cd programs/house && cargo build-sbf --features mock-randomness && cd ../..
cargo test -p house --features mock-randomness              # test_house.rs (17)

# 4. the FULL LiteSVM suite incl. dual-asset + compound (all three mock seams)
cd programs/house && cargo build-sbf --features mock-randomness,mock-price,mock-swap && cd ../..
cargo test -p house --features mock-randomness,mock-price,mock-swap   # + test_dual.rs (17)
```

`cargo test --workspace` stays green with no feature: it runs the 48 house-math
proofs, the switchboard seam unit tests, and the mock-gate test; the LiteSVM
suites are `#![cfg]`-gated on their mock features and skipped there (they need the
mock `.so` anyway). The dual/compound tests (`test_dual.rs`) are gated on all three
mock features — build-sbf with fewer and they silently do not run.

The program keypair lives in `keys/` (gitignored, backed up out of
`target/deploy/` so `cargo clean` cannot destroy it), mirroring the Yvone-Protocol
convention.

**Devnet scripts.**

```sh
cd scripts && npm install
npm run bootstrap                 # config + create/seed every machine in machines.ts (idempotent)
npm run spin                      # throwaway player: commit → reveal → settle
npm run verify spins/<sig>.json   # recompute a spin's outcome from chain data (single or dual)
npm run status [lpOwnerPubkey]    # live machineStatus (+ lpStatus for an owner)
npm run withdraw                  # throwaway LP: deposit → request → epoch wait → crank

# dual-asset + price infra
npm run create-pool && npm run seed-pool    # create + seed the CHIP/WSOL CLMM pool
npm run prove-layouts                       # ground-truth the offsets against live swaps
npm run verify-layouts                      # regression guard (exit ≠ 0 on drift)
npm run twap [--watch]                      # spot / TWAP / band / staleness
npm run keeper                              # keep observations fresh
npm run twap-demo                           # the full STALE→LIVE→band→stale artifact
node keeper.ts --interval 16 & node devnet-dual-spin.ts   # freshen TWAP, then a live dual spin
node devnet-compound.ts                     # a live compound (freshen TWAP first)
```

`spin` bundles the Switchboard create+commit with `spin_commit` in one tx, waits
for the oracle reveal (~2–4 s observed), bundles reveal + `spin_settle`, and prints
the reels, payout, exact `pool_value` delta, and Solscan URLs. `verify` re-reads
the randomness account and the settle tx from chain and asserts the house-math
recomputation equals the lamports paid — the "anyone can audit any spin" claim as
runnable code, extended in H6c-2 to recompute a dual spin's `price_at_commit`
independently from the observation ring.

**Run the app.**

```sh
cd app
cp .env.example .env       # set VITE_RPC_URL to a devnet RPC (public is fine, rate-limited)
npm install
npm run dev                # http://localhost:5173
npm run build              # tsc + vite build → dist/  (clean)
npm run preview            # serve the production build
```

`VITE_RPC_URL` is the only config and is never committed (`.env` is gitignored;
`.env.example` documents it). There is no server — it's all chain reads — so
deploy `dist/` as static files. The app uses hash routing (`/#/machine/…`), so
**no SPA rewrite rule is needed**: point the host at `app/` with build command
`npm run build`, output directory `dist`, and `VITE_RPC_URL` as an env var.

## Production-scale analysis

[`SCALE.md`](./SCALE.md) analyzes how the design behaves at volume — withdrawal
crank ordering, pending-spin contention, epoch-drain latency, per-position
compounding, keeper/TWAP-window economics, the realization horizon, and off-chain
scans — with every claimed failure mode demonstrated by a named `scale_*` LiteSVM
test or a pinned house-math model. Findings are triaged real-bug (A) / scale-limit
(B) / mainnet-only (C). **It surfaced one (A), now FIXED (FIX-1):**
`process_withdrawal_token` reverted (`UnbalancedInstruction`) for a SOL-mode LP that
withdrew while holding an unclaimed SOL dividend — a lamport surgery before the token
CPI. FIX-1 reordered the surgery to last (mirroring `compound_epoch`), upgraded the
program in place ([`3hPp33d3…`](https://solscan.io/tx/3hPp33d33TN2uUXNfpjHynHGZkswM5bifVDRctuWKpregsMvP4ewspXkLC3BTLd7xudnXjkVKucb2NWWqpzfeXFT?cluster=devnet)),
and proved the once-reverting combined withdrawal live on `dual-chip-1`
([`3faxnxiW…`](https://solscan.io/tx/3faxnxiWmQBPe1UBHH7faWEZKuDvLrQTwJR1TJ5ZBFEZ5xgqWFgrpY5vvaVujsv6YRS9Vf9HqcZ7BqfnfrK1sSYh?cluster=devnet)) —
both assets paid, exact by recompute. Everything else is a bounded (B) or precluded (C).

## Known deferrals

- **`spin_expire` live.** Needs a ~1 h abandonment to stage on devnet; covered by
  the LiteSVM test `e_expiry_refunds_and_releases`.
- **Share-price history in the app with no indexer running.** The trailing chart
  requires the optional indexer (see *The indexer* above); with `VITE_INDEXER_URL`
  unset the LP dashboard still shows current share price + EV and marks the trailing
  series as deferred rather than faking it.
- **Everything mainnet.** Precluded by the legal posture above, not by
  engineering — see [`HOUSE-SPEC.md`](./HOUSE-SPEC.md) §7 for the full v0
  exclusion list (multi-line reels, volume-EMA curve term, progressive jackpots,
  entry fees, LP share transferability).
