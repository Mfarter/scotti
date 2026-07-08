# Scotti House Module — H6: Dual-Asset Machines (SOL in, SPL out) — Spec v0 draft

**Status** — spec text below remains v0 draft for review; the build is complete and live on devnet. Per-milestone detail is in §7.

| milestone | scope | state |
|---|---|---|
| H6a | price-infra ground-truth spike: verified devnet CLMM, demo CHIP/WSOL pool, layout ground-truth + regression guard, twap-status/keeper, house-math tick→price/TWAP/margin proofs | shipped |
| H6b-1 | dual-asset `DualMachine` account + token vault + spin path (mock price seam); house-math token-payout / value-RTP-invariance / haircut-solvency proofs | shipped |
| H6b-2 | LP layer: MasterChef SOL dividend ledger, SOL/SPL reward modes, price-free token deposits, price-free both-asset withdrawals; house-math dividend conservation / no-dilution proofs | shipped |
| H6b-3 | real on-chain CLMM price reader (pinned H6a offsets, ground-truthed to live bytes) + `compound_epoch` behind a swap seam; house-math to 48 proofs | shipped + live |
| H6c-1 | real Raydium CLMM `swap_v2` CPI wired into `compound_epoch` | shipped + live |
| H6c-2 | dual-asset frontend + price-verifying spin verifier (no program change) | shipped + live |

**Extends:** HOUSE-SPEC v0 (H1–H5 shipped) · **Cluster:** devnet only

**Legal posture (fixed):** unchanged from HOUSE-SPEC and amplified. A token-denominated house
adds a **token-issuance / market** dimension on top of the licensed-casino-plus-pooled-investment
question — this is the regulated thing itself, not a gray zone. **Devnet demonstration only.**

---

## 1. Concept and money flow

A **dual-asset machine** takes wagers in SOL and pays winners in an SPL token, with a liquid
AMM pool supplying the token's price. LPs fund the token vault; the SOL wager flow accrues to
the pool and is distributed to LPs pro-rata at withdrawal.

```
player SOL wager ──▶ machine PDA (SOL side accrues to LPs)
machine token vault ──▶ winner (payout_tokens = wager_value × mult × k ÷ price_at_commit)
LP deposit: tokens in ──▶ shares          LP withdraw: pro-rata of BOTH assets (price-free)
```

The game math is unchanged: strips, tiers, k(D), smoothing, snapshot discipline all carry over.
What is new is (a) a price input, (b) a token vault with CPI transfers, (c) dual-asset LP
accounting, and (d) the manipulation defenses a price input requires.

## 2. Price infrastructure — Raydium CLMM ObservationState TWAP

**Decision:** the machine's price source is the token's Raydium CLMM pool (token/WSOL) read
directly on-chain: `PoolState` (spot, via sqrt_price) + `ObservationState` (cumulative-tick
history → TWAP). Rationale: purpose-built on-chain TWAP storage updated on swaps, single-account
reads under the protocol's existing owner-check trust pattern (account owner must be the Raydium
CLMM program), permissionless devnet pool creation, no off-chain oracle job to operate. Orca
Whirlpools' TWAP oracle never became a dependable primitive; Pyth/Switchboard price feeds don't
exist for an arbitrary demo token without running feed infrastructure.

**TWAP computation.** Raydium observations store cumulative tick over time. TWAP over window W:
`avg_tick = (tickCum_now − tickCum_then) / (t_now − t_then)`, then
`price = 1.0001^avg_tick`, computed in fixed point via per-bit multiplier tables (Uniswap
TickMath style), implemented in `house-math` with pinned test vectors. Window: 30 min (devnet
demo may use shorter; a Machine param `twap_window_secs`).

**Field-tested warnings this spec treats as requirements:**
1. **Layout ground-truth first.** Practitioners report the published Raydium CPI structs for
   ObservationState diverge from the deployed program (observations store cumulative tick only;
   index field placement differs). H6a is therefore a layout-verification spike against the LIVE
   devnet program — raw bytes vs known swaps — before any code trusts an offset. Same discipline
   as Sessions 3/4; a regression guard test pins the verified offsets.
2. **Staleness is a gate, not an error.** Observations advance only when swaps move the tick.
   If the newest observation is older than `max_staleness` (param), the machine refuses
   spins/deposits (`PriceStale`). The devnet demo runs a tiny keeper making periodic dust swaps
   to keep the pool observed; that keeper is operational convenience, not a trust component —
   anyone's swap freshens the observations.

## 3. The snapshot discipline, extended to price

`spin_commit` snapshots, alongside k/tier: **`price_at_commit` = TWAP** (token per SOL, fixed
point 1e12). Settle pays `payout_tokens = wager_lamports × mult_bp × k_bp ÷ BP² × 1e12 ÷
price_at_commit` — deterministic the moment the wager locks. Player slippage is zero by
construction; the reveal window's price drift lands on LPs as symmetric noise dwarfed by edge.

**Band gate (the slippage protection, protocol-grade).** At commit, read BOTH TWAP and spot
(from PoolState.sqrt_price). If `|spot − twap| / twap > band_bp` (param, default 300 = 3%),
refuse the spin (`PriceUnstable`). The same gate protects `lp_deposit` (the only other
price-dependent instruction). Consequence: manipulating the snapshot now requires displacing a
TWAP for the whole window while ALSO holding spot near it — self-contradictory; residual cost
scales with AMM liquidity × window.

**Haircut reserve.** The pending-spin escrow reserves
`max_payout_tokens × (1 + haircut_bp)` (default 1500 = 15%) from the token vault, so adverse
drift during the reveal window cannot make settle insolvent. Unused haircut releases at settle,
exactly like the H1 reserve.

## 4. Accounting

**Numeraire:** lamports. Machine tracks `token_balance` (internal, mirrors its vault ATA) and
`sol_balance` (internal, wager accrual net of payout-side zero — payouts are token-only). All
internal, so donations to either side remain inert (HOUSE-SPEC rule).

- **Depth for the k-curve:** total pool VALUE `D = sol_balance + token_balance × TWAP`
  (smoothed exactly as today — SmoothedDepth now smooths value, which also smooths price noise).
- **Solvency binds to tokens** (payouts are tokens): `max_bet` is the largest wager whose
  `max_payout_tokens × (1+haircut) ≤ max_exposure_bp × token_balance`. Both constraints
  (value-curve and token-solvency) apply; the binding one wins.
- **RTP proofs survive intact:** expected payout VALUE at commit price = wager × RTP_base × k
  — the price cancels. house-math gains the proof `value_rtp_invariant_to_price` plus pinned
  tick→price vectors and a haircut-solvency proof over the full enumeration.

## 5. LP mechanics (dual-asset)

- **Deposit: tokens only, PRICE-FREE** (H6b-2 locked decision, superseding this
  section's earlier "priced by TWAP" sketch). Shares are minted pro-rata on the
  token side only: `mint = token_amount × total_shares ÷ token_balance` (first
  deposit 1:1 at 1e6 scale). No TWAP is read — `spin_commit` stays the ONLY
  price-touching instruction. This is strictly SAFER than value-pricing: pricing
  the deposit would let an attacker inflate the TWAP at deposit to mint excess
  shares (the deposit-timing game, threat model §6). The SOL side is made correct
  without a price by the **SOL dividend ledger** (below): a MasterChef per-share
  accumulator `acc_sol_per_share` with position `sol_debt`, so a deposit is
  entitled to ZERO of any prior accrual (no dilution, proven in house-math).
- **Withdraw: pro-rata of BOTH assets, price-free.** A processed request pays
  `shares/total_shares` of the token balance AND of the SOL balance. No price input ⇒ the
  withdrawal path is manipulation-immune, and "excess SOL evenly distributed between stakers"
  falls out automatically. Epoch gating, liquidity floor (now token-side floor = token_balance −
  reserved_tokens; SOL side has no reservations), price-at-processing, cancel, partial fills:
  all carry over from H3 unchanged in shape.
- **Yield display grows a third disclosure:** share price (in value), EV calculator, variance
  warning, AND token-price exposure ("your position holds the token; its SOL value moves with
  the AMM price"). Never an APY.

## 6. Threat model (additions to HOUSE-SPEC §6)

- **TWAP manipulation → mispriced snapshots:** band gate + window economics (§3). Residual:
  accepted and bounded; a manipulated snapshot still pays inside the RTP band *in value at that
  snapshot*; the attacker's edge is the price wedge, capped by band_bp and paid for via AMM
  displacement costs.
- **Stale observations (quiet pool):** `PriceStale` gate; keeper freshens; anyone can freshen.
- **Deposit-side price games:** same band gate; plus epoch withdrawals already blunt
  deposit-timing alpha (H3).
- **Decimals/overflow:** all token math in u128 with the token's decimals normalized at machine
  creation (param `token_decimals`); house-math proofs run at extreme decimals (0 and 9).
- **Vault authority:** the machine PDA owns its token ATA; transfers via token-program CPI
  signed by the PDA — the one CPI class this protocol admits (asset movement), distinct from
  logic delegation, which remains ownership-based reads.
- **Reveal-window drift beyond haircut:** cannot break settle (reserve covers −15%); beyond
  that, settle still pays (vault-permitting) and the loss is LP variance — documented.

## 7. Sessions

- **H6a — ground truth + demo market. ✓ SHIPPED.** Verify devnet Raydium CLMM program id + PoolState/
  ObservationState layouts against live accounts (raw bytes vs known swaps; pin offsets with a
  regression test). Create the demo token (9 decimals), seed a token/WSOL CLMM pool, write the
  keeper (dust-swap cron) and a `twap-status` script proving TWAP/spot/staleness reads off
  devnet. house-math: tick→price fixed point with pinned vectors.
- **H6b — the program.** Dual-asset Machine (new account version or a `denom` field carved from
  reserved space — decide against live-account compatibility, per H3 precedent), token vault,
  price snapshot + band gate + staleness gate + haircut reserve, dual-asset deposit/withdraw,
  full LiteSVM matrix with a mock pool/observation fixture (the seam pattern from H1: mock price
  source behind a feature gate, absent from deployable IDL). Split into three:
  - **H6b-1 — dual-asset core + spin path. ✓ SHIPPED (mock price).** A separate `DualMachine`
    account (the dual-asset params — 4 pubkeys + risk fields — far exceed `Machine`'s 56 reserved
    bytes, so growing it would break the live H3 SOL machines; a new account type keeps them
    untouched). Token vault ATA owned by the PDA, `create_machine_dual` validating the margin-floor
    invariant via house-math, a minimal `lp_deposit_token`, and `spin_commit_dual` /
    `spin_settle_dual` / `spin_expire_dual`. Price behind a `read_price` seam (mock feature vs a
    CLMM stub) with gate evaluation in shared code. house-math: token payout + value-RTP-invariance
    + haircut-solvency. 27-test LiteSVM matrix; legacy SOL machines pass untouched; mocks absent
    from the deployable IDL.
  - **H6b-2 — LP dividend ledger. ✓ SHIPPED (mock price).** PRICE-FREE token deposits (not
    value-priced — the locked, safer decision; see §5), a MasterChef per-share SOL dividend ledger
    (`acc_sol_per_share` + position `sol_debt`, house-math `dividend` module: conservation via a
    pool-balance cap, no-dilution, rounding-favors-the-pool), SOL/SPL reward modes (`claim_sol`,
    `earmark_sol`, `set_reward_mode`; SPL earmarks into `earmarked_sol`, excluded from everything,
    swapped in H6b-3), and price-free epoch-gated withdrawals of BOTH assets (`request/cancel/
    process_withdrawal_token`). Curve depth is token-side only — accrued SOL is dividend income,
    never at-risk capital, never in `max_bet`. 15-test dual matrix incl. the literal worked example.
  - **H6b-3 — CLMM price reader + compound. ✓ SHIPPED + LIVE.** Filled the
    `read_price` CLMM backend: `house-math::clmm` parses PoolState.sqrt_price (spot) +
    ObservationState cumulative-tick TWAP via the pinned H6a offsets, under the owner-check trust
    pattern (owner == CLMM program, keys match the machine, pool↔observation cross-link). No gate
    logic changed — it lives outside the seam. Ground-truthed against CAPTURED LIVE devnet bytes:
    spot_1e12 and the 300s TWAP avg_tick reproduce scripts/twap.ts exactly. `compound_epoch` (the
    module's only AMM CPI) behind a swap seam — mock fill proves the accounting (books, non-dilution,
    the 33% worked example). house-math: `clmm` + `compound_mint_shares` proofs (48 total).
    - **LIVE on devnet:** the program was upgraded in place (extend 240KB + redeploy) and a full
      dual spin ran against the real H6a CHIP/WSOL pool — keeper-freshened TWAP, SOL wager priced by
      the on-chain CLMM reader (972.00 CHIP/SOL snapshot, spot within 18bp), Switchboard-settled, CHIP
      paid, and the payout matched an independent recompute to the base unit. `claim_sol` paid the
      accrued dividend; the live H3 single-asset machines still read/spin.
- **H6c-1 shipped + LIVE on devnet.** `compound_epoch`'s AMM CPI is now the REAL Raydium CLMM
  `swap_v2` (WSOL→CHIP into the vault, signed by the machine PDA), ground-truthed against a live
  keeper swap (`5XcKLe…`, log `Instruction: SwapV2`) and proven with a live compound on
  `dual-chip-1` (`5P8zLq…`, 174,732 CU): machine SOL down by EXACTLY the earmark, vault CHIP up by
  the swap output (≥ TWAP×(1−band)), shares minted == `compound_mint_shares` at the pre-swap price
  — all by independent recompute. The WSOL is fronted by the crank (a program-owned PDA can't be a
  system-transfer source) and reimbursed out of the machine as the swap's last op (so the only
  balance check is at instruction return). Mock-swap LiteSVM suite unchanged; zero mock surface in
  the deployable IDL; legacy + dual machines unaffected.
- **H6c-2 shipped + LIVE on devnet.** Frontend + verifier, no program change. `dual-chip-1` is
  bootstrapped on the floor (`6vyARZoi…`); the Scotti app renders it as its own card with token
  payouts + value equivalents, a live "price status" chip (TWAP/spot/band/staleness) computed
  client-side from the real pool/observation accounts, the dual LP dashboard (price-free deposit,
  pending SOL dividend, reward-mode choice), and the third LP disclosure. `verify-spin` was
  extended to dual spins — it reconstructs the spin from chain and INDEPENDENTLY recomputes
  `price_at_commit` from the observation ring, flagging any CHIP paid that could not have come from
  that price and a valid k. Verified by a live UI-driven dual spin (CHERRY·BLANK·CHERRY, 3.83 CHIP,
  recompute == paid to the base unit; ring price 977.67 vs 977.65 snapshot, 0.15bp) — see README
  "The app · Verified". The protection made visible, end to end.

---

## 8. VAULT-1 — permissionless vaults with multi-pool price sets

**Status — shipped + LIVE on devnet.** Generalizes the H6 dual vault two ways: (a)
creation is **permissionless** (anyone creates an SPL/dual vault; single-asset SOL
machines remain admin-only and are untouched), and (b) the price link generalizes
from ONE Raydium CLMM pool to a **pool SET of 1–5 pools** of the vault's payout
token, aggregated by a manipulation-resistant **median + quorum**. Interpretation
is fixed: one vault, one payout token, up to five pools pricing THAT token.

### 8.1 The aggregator (`house-math::aggregator`)

At commit, each set member is read through the UNCHANGED per-pool price seam
(`read_clmm_price` → spot, TWAP, observation age). Per-pool rules are reused
verbatim from §2–§3:

- **Eligibility.** A pool is *eligible* iff it is **fresh** (newest observation
  within `max_staleness`, TWAP window covered) AND its own **spot is within
  `band_bp` of its own TWAP**. This is byte-for-byte the single-pool gate applied
  per pool — a member must still pay the full single-pool TWAP-displacement cost to
  be counted.
- **Aggregate = MEDIAN** of the eligible members' TWAPs (a true order statistic —
  `sorted[m/2]`, integer-exact, never an average, so the result is always one real
  pool's TWAP).
- **Quorum gate.** A commit is allowed iff `eligible ≥ quorum`, where `quorum` is a
  strict majority of the SET size:

  | set_len | 1 | 2 | 3 | 4 | 5 |
  |---|---|---|---|---|---|
  | quorum  | 1 | 2 | 2 | 3 | 3 |

  Below quorum ⇒ `QuorumNotMet` (the commit is refused, exactly as a single stale
  pool refuses today).

**Pinned proofs** (house-math, all green):

1. **Bounded manipulation.** If a strict majority of the eligible pools are honest
   and inside the band `[P(1−b), P(1+b)]`, the median is inside the band — proven
   exhaustively over every eligible count 1–5, every choice of which pools are
   adversarial, and adversaries pinned at both extremes. Corollary for the
   **recommended ODD sizes (1, 3, 5)**: `quorum = ⌈n/2⌉`, so corrupting **fewer
   than quorum** pools leaves the aggregate in the band — the headline guarantee.
   Each corrupted pool still costs a full single-pool TWAP displacement, so the
   pool set multiplies the single-pool attack cost by the honest-majority
   threshold.
2. **Determinism / integer-exactness.** The median is a pure integer function; same
   inputs → same output; result ∈ the inputs (no float, no synthetic average).
3. **Single-pool degeneracy.** A 1-pool set returns EXACTLY that pool's TWAP and
   refuses in EXACTLY the cases the single-pool machine refuses — the bit-identical
   guarantee. Legacy vaults (`pool_set_len == 0`) don't even enter this path.

**Documented residual (`even_set_tie_is_the_residual`).** Even sizes (2, 4) have a
50% median breakdown at the tie: an adversary controlling *exactly half* the
eligible pools can move an even-count median (one pool short of the odd-set bound).
Even vaults stay solvent (the per-pool band and the margin floor still bind) but
need strictly more than half honest. **The spec therefore RECOMMENDS odd set sizes;
even sets are permitted but weaker.**

### 8.2 Account design (price-plumbing only)

The five (pool, observation) pairs don't fit `DualMachine`'s reserved tail, so the
set lives in a **companion `PoolSet` PDA** (`["pool-set", machine]`), fixed 394 B,
created WITH the vault and never resized: `machine`, `set_len`, `pools[5]`,
`observations[5]`. `DualMachine` gains a single `pool_set_len: u8` **carved from the
first byte of its reserved tail** (reserved 16 → 15). SIZE stays **409 bytes** —
identical on disk — so **live `dual-chip-1` keeps deserializing untouched**: its
reserved bytes are all zero, so `pool_set_len` reads 0 and it follows the unchanged
single-pool path. No account type's size changes; no LP/ledger/dividend field
moves. This is **price plumbing only** (a stop-and-report trigger was that it must
not force accounting changes — it does not). Migration of `dual-chip-1` is **not
needed**: `pool_set_len == 0` IS the legacy reading, so it works as-is (verified
byte-identical live).

Set member 0 becomes the vault's primary pool (`m.pool` / `m.observation`) — so the
**compound swap venue** (the HARDEN-1 pin `swap pool == m.pool`) is now provably a
member of the set (generalizing the pin to set membership), and member 0 doubles as
the aggregator's legacy-shaped named price account.

### 8.3 Permissionless `create_vault` + the clamp table

`create_vault` has **no admin/config gate**: the creator signs and pays **rent
only** (no protocol fee) for the `DualMachine`, its `PoolSet`, and the token vault
ATA, and becomes the **curator with PAUSE rights only** (`set_paused_dual`) — no
odds control beyond the create-time params. Each candidate pool is validated:
owned by the Raydium CLMM program, **actually pairs the payout mint** (one side of
`PoolState` = the vault mint, else `PoolMintMismatch`), pool↔observation
cross-linked, and **distinct** (`DuplicatePool`). Under the mock-price seam these
CLMM-structure checks fold to a program-owner check (the mock has no pool state);
the deployable branch does the full parse (zero mock surface in the shipped IDL).

Every risk param is CLAMPED so the **H6b margin-floor invariant holds for ANY user
input** (`validate_dual_params`, proven exhaustively over ~14.6M configs — the
same gate `create_machine_dual` uses):

| Param | Min | Max | Note |
|---|---|---|---|
| `set_len` | 1 | 5 | pool-set size (odd recommended) |
| `d_low, d_mid, d_high` | — | — | `0 < d_low < d_mid < d_high` |
| `max_exposure_bp` | 1 | 10000 | ≤100% of token depth per spin |
| `smooth_window` | 1 | — | anti-snipe slots |
| `epoch_length` | 1 | — | withdrawal-epoch slots |
| `token_decimals` | 0 | 18 | |
| `twap_window_secs` | 1 | 1485 | Raydium ring coverage cap |
| `max_staleness_secs` | 1 | — | |
| `max_pending_spins` | 1 | — | |
| `haircut_bp` | 0 | 10000 | reveal-drift reserve cushion |
| `rtp_max_bp` | **9200** | **9500** | dual realized-RTP ceiling band |
| `band_bp` | 0 | **300** | spot-vs-TWAP gate cap |
| `m_bp` (margin floor) | **200** | <10000 | AND `rtp_max·(BP+band) ≤ (BP−m)·BP` |

The last row is the binding invariant: `margin_floor_holds` is checked on the
user's own `(rtp_max, band, m)`, so no accepted config — for any pool set — can
cross the house floor even at worst-case band drift (`margin.rs` proves the 300bp
cap sits 15bp inside the true boundary).

### 8.4 Cross-vault coherence — what IS and ISN'T guaranteed

Dual vaults keep **per-vault** curve knees `(d_low, d_mid, d_high)` (the ODDS-1
normalized protocol curve is single-asset floor scope, unchanged). The clamps make
the cross-vault story **coherent but not normalized**:

- **Guaranteed for every user vault:** realized RTP lives in the dual `[92%, 95%]`
  corridor; the margin floor holds under the band gate (no vault is ever a faucet);
  the haircut reserve covers every outcome (solvency); the payout VALUE is
  invariant to the snapshot price (the median only rescales the token count).
- **NOT guaranteed across vaults:** a global odds ORDERING. Unlike the single-asset
  protocol curve (lowest pool value ⇒ best odds, one monotone function), two
  different user vaults are not comparable by pool value — each sets its own knees
  within the clamped corridor. The clamps guarantee every vault is *solvent and
  inside the same RTP band*, not that vaults are *ranked* by depth.

### 8.5 Live proof (devnet)

Program upgraded in place (601312 → 654488 bytes). A SECOND vault was created
**permissionlessly from a fresh non-authority wallet**
(`Ev8rR17SuDm4C5MThBznbfeDvshX6tsmU5oKRhmVexJc`) as a 1-pool set on the CHIP/WSOL
pool, deposited (20,000 CHIP), and spun once through the on-chain aggregator path
(`pool_set_len = 1`, PoolSet `7dmx8UzQ…`): `BLANK·CHERRY·CHERRY` at 972.0974
CHIP/SOL → **2,210,685,642 base units, matching an independent recompute exactly**.
`dual-chip-1` was **byte-identical before and after**. New vault
`86JGeQXykW69jydjUXxWfUBk6KpgHSm8sVvE1fKfrxPE`; script `scripts/vault1-live-proof.ts`.
(The user-facing docs/frontend page is VAULT-2.)
