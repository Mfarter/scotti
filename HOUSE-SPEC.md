# Yvone House Module — Specification v0 (draft)

**Status:** H2 shipped — deployed to devnet with **live Switchboard On-Demand randomness**; three
public spins settled + independently verified (see §8 roadmap; spec text below remains v0 draft for
review) · **Depends on:** Yvone core (registry/admin patterns) · **Cluster:** devnet only
**Legal posture (fixed):** this module is a devnet demonstration of verifiable, state-dependent
house games and pooled bankrolls. Real-money operation is a licensed-casino activity AND a pooled
investment product; that is not a "consult counsel" gray zone and this spec does not pretend otherwise.

---

## 1. Concept

Peer-to-house games backed by liquidity pools, where the odds are a **published, deterministic
function of pool state**. Think lending-pool utilization curves, applied to a slot machine:

- Each **Machine** is a vault (bankroll) + a parameter set (strips, paytables, curves).
- **LPs deposit into the vault** and own pro-rata shares; the house edge on every spin accrues to
  the pool, so share price drifts upward with volume and down with jackpot variance. Yield is
  share-price appreciation — never a promised APY.
- **RTP floats within a hard band** as a function of pool depth: cold/shallow machines pay better
  (up to the ceiling), hot/deep machines compress toward the floor. Player flow becomes the
  arbitrage that rebalances machines — an AMM for luck.
- **Volatility scales with depth**: deeper vaults unlock higher-multiplier paytables (rarer, bigger
  wins); shallow vaults run frequent-small-win tables. This is bankroll math, not flavor: max
  exposure per spin is capped at a fraction of the vault.

**The invariant that makes it a casino and not a faucet:** RTP < 100% in every reachable state.
This is not a tuning goal; it is a proof obligation. The `house-math` crate enumerates the entire
outcome space and asserts the band `[RTP_MIN, RTP_MAX] = [92%, 97%]` holds at the curve extremes.
Anything the tests cannot prove does not ship.

## 2. Machine math

### 2.1 Reels and base paytable
v0 machine: 3 reels × 32 stops, identical strips. Symbols per strip:
JACKPOT×1, SEVEN×2, BELL×4, BAR×6, CHERRY×9, BLANK×10. One payline. Outcome space =
32³ = 32,768 equally likely triples (before the VRF maps into it) — small enough to enumerate
exactly, so RTP is computed as an exact rational, never sampled.

Payouts are expressed in **basis points of the wager** (`mult_bp`), so fractional multipliers stay
integer-exact. Two paytable **tiers** (see §2.3): SHALLOW (max 50×) and DEEP (max 500×), engineered
to near-identical base RTP (the crate asserts both, exactly).

### 2.2 The RTP curve — k(D)
Let `D` = pool depth (internal accounting value, NOT raw lamports — see §6 donation attack).
Effective payout on a win = `wager × mult_bp × k_bp / 1e8`, where the scaler `k_bp` is a
piecewise-linear function of D:

```
k(D) = k_max                          for D ≤ D_low        (cold machine: best odds)
       linear from k_max → k_min      for D_low < D < D_high
       k_min                          for D ≥ D_high        (deep machine: floor odds)
```

Per tier, `k_min/k_max` are derived constants: `k_min = floor(RTP_MIN / RTP_base)`,
`k_max = floor(RTP_MAX / RTP_base)` (in bp), so realized RTP = `RTP_base × k` sits inside
[92%, 97%] by construction. The crate asserts the band at both extremes for both tiers, and
asserts k_max × RTP_base < 100% with margin. All curve parameters are on-chain machine state,
readable by anyone: **the odds are the pool state run through a published function.**

### 2.3 Volatility tiering + exposure cap
Tier = SHALLOW if `D < D_mid`, DEEP otherwise. Max bet is solvency-derived:

```
max_bet(D) = D × MAX_EXPOSURE_BP / 10⁴ / max_effective_mult(tier, k(D))
```

with `MAX_EXPOSURE_BP = 100` (one spin's worst case ≤ 1% of pool). A $100k-depth machine in DEEP
tier (500× top, k≈1) allows ~$2 bets... which shows 1% is conservative; the constant is a governance
parameter per machine, and the crate exposes the formula so operators can price it. Every pending
spin **escrows its max payout** (§4), so concurrent spins cannot jointly exceed solvency.

## 3. Accounts (owner: House program)

- **Machine** PDA `["machine", machine_id]`: params (strips hash, tier tables, D_low/mid/high,
  k bounds, MAX_EXPOSURE_BP), accounting (`pool_value D`, `reserved_exposure`, `total_shares`),
  vault (lamports held in the PDA), admin/curator linkage, paused flag.
- **LpPosition** PDA `["lp", machine, owner]`: shares held; pending-withdrawal (shares, epoch).
- **PendingSpin** PDA `["spin", machine, player, nonce]`: wager, snapshot of `(k_bp, tier,
  max_payout)` at commit, the Switchboard randomness account pubkey + seed slot, commit slot,
  state (committed/settled/expired).
- **HouseConfig** PDA `["house-config"]`: admin, epoch length, fee params — mirrors the core
  protocol-config pattern (initialize-once + update_admin, same devnet caveat as SPEC §3.2).

## 4. Spin lifecycle (Switchboard On-Demand randomness)

Verified current state: Switchboard On-Demand provides TEE-backed commit/reveal randomness, live
on devnet; the integration pattern is a randomness account committed at a seed slot, revealed by
the oracle, parsed on-chain via `RandomnessAccountData`; requests expire if not settled within
~1 hour, which protocols must treat as a normal flow; collateral must be taken at commit time.
Fallback candidate if integration disappoints: ORAO VRF (CPI-based, ~0.001 SOL/request).

1. **spin_commit(wager, randomness_account)** — player signs. Program checks: machine not paused;
   wager ≤ max_bet(D); randomness account fresh (seed_slot == current−1 per Switchboard docs);
   then **takes the wager into the vault**, computes and stores the snapshot `(k, tier,
   max_payout = wager × top_mult × k)`, adds `max_payout` to `reserved_exposure`, records the
   randomness account. Odds are frozen at commit — the reveal cannot be re-rolled or re-priced.
2. **spin_settle** — anyone cranks (frontend does it automatically ~2–3s later). Program verifies
   the stored randomness account, parses the revealed 32 bytes, maps them to three reel indices
   (rejection-free: bytes mod 32 per reel from independent byte ranges), evaluates the snapshot
   tier table × snapshot k, pays the player from the vault, releases the reserve, updates D.
   House edge realized = wager − payout, accruing to the pool (i.e., to LP share price).
3. **spin_expire** — if the oracle never reveals (~1h window), anyone cranks: wager refunded,
   reserve released, spin closed. No outcome, no edge taken.

Player-visible flow: one click, ~2–3 seconds, result — the frontend sends commit then auto-cranks
settle. **Fairness verification story:** every input to the outcome is public — the strips and
tables in the Machine account, the snapshot in the PendingSpin, the revealed randomness with its
TEE attestation on the Switchboard account — so anyone can recompute any spin from chain data
alone. The SDK ships `verifySpin(spinPda)` doing exactly that.

## 5. LP mechanics

- **Deposit:** mint `shares = amount × total_shares / D` (first deposit 1:1 at a 1e6 scale).
  Share price `P = D / total_shares` (fixed-point 1e12 in accounting).
- **Withdraw (epoch-gated):** `request_withdraw(shares)` queues; at epoch boundary (devnet: 6h)
  a permissionless crank processes the queue at **that moment's** share price, capped by the
  liquidity floor `free = D − reserved_exposure` (unfilled remainder stays queued). Epochs are
  the anti-pool-hopping and anti-bank-run mechanism in one.
- **Yield display (frontend obligation):** trailing share-price change (7d/30d, annualized) AND
  expected-value math (`edge × projected volume / D`) AND historical drawdown — never a fixed
  "APY". A $1M pool at 5% avg edge and $20k daily volume expects ~36%/yr with whole-percent
  drawdowns when jackpots land; both numbers get shown.

## 6. Threat model v0

- **RTP > 100% anywhere** → the faucet failure. Defense: enumeration proofs in `house-math`
  (band at curve extremes, both tiers) + k snapshot at commit.
- **State-sniping** (spin right after a jackpot drops D → k jumps) → bounded by k_max: even at
  the ceiling the player EV is −3%. The band edge is a marketing cost, not an exploit. Analyzed,
  accepted, documented.
- **Donation attack on the curve** (send lamports to the vault to force tier/k transitions) →
  curve reads internal `pool_value` accounting, never raw lamports; donations are inert dust.
- **Oracle trust** → TEE-based (SGX enclave) randomness is a hardware-trust assumption plus the
  documented oracle/leader considerations; stated honestly in-product. The VRF proof + attestation
  make outcomes verifiable; they do not make Intel a cryptographic-free lunch. Devnet-acceptable;
  a mainnet-grade posture would re-evaluate (ORAO quorum, Pyth Entropy) — moot given legal gate.
- **Reveal-expiry griefing / oracle downtime** → spin_expire refund path; reserves always released.
- **Bank-run vs solvency** → per-spin escrow of max payout + epoch withdrawals + liquidity floor.
  At no point can outstanding spin liabilities exceed vault holdings.
- **Pool-hopping LPs** (deposit after a crater, exit after reversion) → epochs blunt the timing;
  residual mean-reversion capture is symmetric variance transfer between LPs, accepted at v0
  (entry-fee option reserved as a parameter).
- **Rounding** → all payouts floor; dust accrues to the pool. Books-balance test: over the full
  enumeration, Σ payouts + Σ retained == Σ wagers exactly.
- **Admin risk** → machine params are set at creation and immutable except `paused` (curator can
  halt commits, never settles); param upgrades = new machine. Stated plainly in the UI.

## 7. What stays out of v0

Multi-line/multi-reel configurations; volume-EMA term in the curve (depth-only in v0 — EMA is v1
with slot-decay math); progressive jackpots across machines; entry fees; LP share transferability
(non-transferable at v0 to avoid becoming a token by accident — see legal posture); any mainnet
anything.

## 8. Roadmap (session-sized)

- **H0 (this repo):** this spec + `house-math` crate with enumeration proofs (delivered, tested).
- **H1 (shipped):** House program (`programs/house`) — HouseConfig/Machine/LpPosition/PendingSpin
  accounts; initialize_house_config, update_admin, create_machine, set_paused (curator halt),
  lp_deposit (share-price mint), spin commit/settle/expire against a **mock randomness account**
  behind a narrow `revealed_bytes` seam (mock compiled only under a non-default `mock-randomness`
  feature — absent from the deployable IDL, proven by a test). All odds/exposure/smoothing math
  delegated to `house-math`. LiteSVM books-balance tests: happy-spin reconciliation, JACKPOT³,
  max-bet boundary, k-snapshot honored across pool changes, expiry refund, on-chain depth
  smoothing, share minting (1:1 + drifted), pause semantics, and the mock-gate proof. LP
  withdrawals (epoch crank + liquidity floor) are deferred to H3; PendingSpin/LpPosition layouts
  are already sized for them.
- **H2 (shipped):** Switchboard On-Demand randomness live on devnet. The `revealed_bytes` seam's
  stub is replaced by real `RandomnessAccountData` parsing: commit enforces `seed_slot == clock-1`
  and snapshots it; settle re-binds the account key + seed_slot then reads `get_value` (reveal
  bundled in the settle tx); never-revealed spins route to `spin_expire`. Unit-tested against
  crafted account bytes; the mock backend stays feature-gated and out of the deployed IDL.
  Deployed program `EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ`; `scripts/devnet-spin.ts` +
  `scripts/verify-spin.ts` produced three public, independently-audited spins (see README Devnet).
  Reveal latency observed ~2–4 s. (The `verifySpin` TypeScript SDK export is folded into H3's SDK
  work; the standalone `verify-spin.ts` delivers the runnable audit now.)
- **H3:** Epoch withdrawal crank hardening + curve UX endpoints (SDK reads: current k, tier,
  max bet, share price series).
- **H4:** Frontend — machine floor UI (each machine showing live RTP/k, depth, tier), spin flow,
  LP dashboard with the three-number yield display.
