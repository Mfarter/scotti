# Scotti House Module — H6: Dual-Asset Machines (SOL in, SPL out) — Spec v0 draft

**Status:** Draft for review · **H6a shipped** (price-infra ground-truth spike: verified devnet CLMM `DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH`, demo CHIP/WSOL pool, layout ground-truth + regression guard, twap-status/keeper, house-math tick→price/TWAP/margin proofs — see README "Price infrastructure") · **H6b-1 shipped** (dual-asset `DualMachine` account + token vault + spin path against a MOCK price seam; the CLMM price reader is stubbed until H6b-3; LP dividend ledger is H6b-2. house-math gains the token-payout + value-RTP-invariance + haircut-solvency proofs) · **Extends:** HOUSE-SPEC v0 (H1–H5 shipped) · **Cluster:** devnet only
**Legal posture:** unchanged from HOUSE-SPEC and amplified: a token-denominated house adds a
token-issuance/market dimension on top of the licensed-casino question. Devnet demonstration only.

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

- **Deposit: tokens only**, priced by TWAP behind the band gate:
  `mint = token_amount × TWAP × total_shares ÷ D`. (First deposit 1:1 at 1e6 scale on value.)
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
  - **H6b-2 — LP dividend ledger.** Value-priced token deposits behind the band gate, dual-asset
    pro-rata withdrawals (price-free), and the `pending_sol_yield` → per-share SOL dividend ledger
    (`DualLpPosition.sol_debt`/`reward_mode` are laid out now).
  - **H6b-3 — CLMM price reader.** Fill the `read_price` CLMM backend: parse Raydium
    PoolState.sqrt_price + ObservationState cumulative-tick TWAP via the pinned H6a offsets, under
    the owner-check trust pattern. No gate logic changes (it lives outside the seam).
- **H6c — devnet + frontend.** Deploy/upgrade, bootstrap a dual-asset machine on the floor,
  spin against the real pool, extend `verify-spin` to recompute price from the observation
  history, and the UI: token payouts with value equivalents, the third LP disclosure, and a
  "price status" chip (TWAP/spot/band/staleness) on the machine page — the protection made
  visible.
