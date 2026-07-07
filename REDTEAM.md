# Scotti — adversarial security pass (REDTEAM-1)

An attacker-mindset review of the program, the swap CPI, the SCALE-2 withdrawal
snapshot, and the off-chain surfaces. The goal was to **break it**. Every "this is
safe" claim below is backed by an attack test that *attempts* the exploit and fails
to break the invariant (a `redteam_*` LiteSVM test, or a node test for the indexer),
or — where LiteSVM cannot reach the surface (the real Raydium program) — by the
exact on-chain constraint quoted from the code. No program logic was changed; the
deliverable is this report plus the attack tests (`git diff --stat` is tests + docs).

Attacker roles assumed, separately and in collusion: **machine curator, permissionless
cranker, LP, player, keeper, indexer operator, arbitrary account-supplier** — able to
reorder/bundle instructions, supply any accounts that pass Anchor's constraints,
front-run, and grief. No good faith assumed anywhere.

## Executive summary

**No (A) findings.** No attack moved funds, minted arbitrary tokens, drained a vault,
or bypassed authorization in LiteSVM. Every account-substitution, price/randomness
swap, and economic attack was rejected by an Anchor constraint or a `require!` and is
captured by a green attack test. Nothing here puts live devnet funds at risk.

The **(B) hardening gaps** (not exploitable now; defense-in-depth):

- **B1 — swap `remaining_accounts` are unpinned except the output vault.** In
  `compound_epoch` the Raydium pool / vaults / tick arrays are supplied by the
  (permissionless) cranker as `remaining_accounts` and are NOT required to equal the
  machine's own `pool`/`observation`. Safety rests on three checks that hold
  (`clmm_program == CLMM_PROGRAM_ID`, output `vault == machine.token_vault`, and
  `received >= min_out` priced off the machine's *own* pool), so a substituted pool
  "can only help or fail" — but the swap pool is not pinned. Mitigation: also
  `require_keys_eq!` the swap `pool_state`/`observation` against `machine.pool`/
  `machine.observation` so the swap and the price read are provably the same pool.
- **B2 — indexer ingest has no per-spin `try/catch`.** A spin whose account/tx data
  throws during recompute would abort the whole ingest pass rather than being skipped.
  Not reachable by an attacker today (the randomness/machine accounts are Switchboard-
  / program-owned, so their bytes can't be forged), but a lying RPC could stall
  ingest. Mitigation: wrap each spin's ingest in try/catch, store `unverifiable`, and
  continue.
- **B3 — snapshot freeze-timing lever (the SCALE-2 residual, now attacked).** The
  cranker chooses *when* in an epoch the withdrawal snapshot freezes. It cannot split
  two identical requests (both get the same frozen price — proven), but a cranker who
  is also a withdrawer can time the freeze to a favorable intra-epoch pool moment,
  shifting value between withdrawers and stayers. Bounded per spin by the exposure cap
  (≤ ~1% of the pool); already disclosed as the SCALE-2 residual.

**(C) accepted / disclosed:** RPC trust (a hostile RPC can mislead the app's *display*
but not induce a harmful signature — the program validates every tx); session-key
custody (loss bounded by the buy-in, disclosed on the Fair page); the "new spin
committed after the freeze then jackpots" carry-over (not a repeatable edge — the
outcome is Switchboard-random with negative attacker EV; SCALE.md §1b residual).

### Coverage table (surface → attacks tried → worst finding)

| # | surface | attacks attempted | worst finding |
|---|---|---|---|
| 1 | account substitution | cross-machine position/LP, foreign vault, foreign payee ATA | none — constrained |
| 2 | swap CPI (`compound_epoch`) | output-vault substitution, rigged price account, sub-min_out fill, out-of-band force-fill; real-Raydium reasoned | **B1** (unpinned swap pool; bounded by min_out) |
| 3 | SCALE-2 snapshot | hostile cranker splits identical LPs; freeze-timing | **B3** (timing lever, bounded) |
| 4 | economic / accounting | dividend prior-accrual theft, max_bet cap edge, dust round-trip harvest | none — bounded |
| 5 | randomness / price gate | swapped randomness (single+dual), foreign price, band edge | none — constrained |
| 6 | off-chain (indexer) | forged payout→verified, false mismatch, parser crash, SQL injection | **B2** (no per-spin try/catch) |
| 7 | griefing / DoS | compound front-run, keeper grief, queue clogging, rent strand | none new (see SCALE.md §2/§3/§5) |

---

## 1. Account substitution

**Attacks attempted (each a `redteam_*` test that builds a malformed instruction and
asserts rejection):**

- **A position from machine A processed against machine B** to drain B's vault against
  A's shares — `redteam_cross_machine_position_rejected` (dual),
  `redteam_cross_machine_lp_rejected` (single). Rejected by
  `#[account(mut, has_one = machine, seeds = [b"dual-lp", machine.key().as_ref(),
  position.owner.as_ref()], bump = position.bump)]` — the position's PDA is re-derived
  from the *context* machine, so A's position fails the seeds/has_one check against B.
- **A foreign token vault** in `process_withdrawal_token` to redirect the token debit —
  `redteam_wrong_vault_rejected`. Rejected by `#[account(mut, address =
  machine.token_vault)]`.
- **The CHIP payout redirected to the attacker's ATA** in `spin_settle_dual` —
  `redteam_settle_payout_to_foreign_ata_rejected`. Rejected by `#[account(mut,
  token::mint = machine.token_mint, token::authority = player)]` (the payee ATA must
  be the *player's* ATA for the machine's mint).

**Result: all rejected by constraint.** The machine PDA itself is derived from its own
stored `machine_id` (`seeds = [b"machine", machine.machine_id.as_ref()], bump =
machine.bump`), so a look-alike machine can't be substituted either. The token program
and mint are typed (`Program<Token>`, `Account<Mint>`), so a fake token program / mint
is rejected by Anchor's program-id / owner checks. **Bucket: none.**

## 2. The swap CPI — highest-risk surface

`compound_epoch` is the module's only AMM CPI and takes the Raydium accounts as
`remaining_accounts`. Attacks attempted:

- **Redirect the swapped tokens to the attacker's vault** (`token_vault` substituted) —
  `redteam_compound_wrong_output_vault_rejected`. Rejected: the output vault is
  `#[account(mut, address = machine.token_vault)]`, and the swap deposits into that
  same `vault` account (`output_token_account = vault.key`). Tokens can only land in
  the machine's own vault.
- **A rigged price account** to misprice the compound —
  `redteam_compound_foreign_price_rejected`. Rejected by the price seam:
  `require_keys_eq!(pool.key(), machine.pool)` + `require_keys_eq!(*pool.owner,
  crate::ID)`, evaluated *before* the gate, so a rigged price reverts (it does not slip
  past the "out-of-band → no-op" branch).
- **Fill below `min_out`** — `redteam_compound_min_out_floor_holds` pushes spot to the
  legal band edge (3% below TWAP, the worst price a compound can execute at) and
  confirms `received >= min_out = value_at_twap × (BP − band)/BP`. The band gate refuses
  any spot below `twap × (1 − band)`, so a fill below the floor is unreachable; the
  handler's `require!(received >= min_out_u64, PriceUnstable)` is belt-and-suspenders.
- **Force a fill at a manipulated price** (spot 4% off TWAP) —
  `redteam_compound_out_of_band_noops` confirms the gate makes compound a **no-op**
  (earmark intact, zero tokens minted) rather than force-filling.

**Result: constrained.** The three real degrees of freedom an attacker has over the
CPI — the output destination, the price basis, and the minimum output — are all pinned
(`address = machine.token_vault`, `require_keys_eq pool == machine.pool`, `min_out` off
the machine's own TWAP). **Reasoned-only (LiteSVM has no Raydium program):** the real
`swap_v2` CPI additionally owner-checks the CLMM program
(`require_keys_eq!(*clmm_program.key, CLMM_PROGRAM_ID)`), and Raydium's own `swap_v2`
validates that the passed pool vaults belong to `pool_state` and that
`output_token_account.mint == output_vault_mint` — so a substituted pool must be a
*real* Raydium WSOL→(machine token) pool, and any such pool that returns fewer tokens
than `min_out` fails the threshold. Net: mis-routing the swap pool **can only help the
machine (more tokens) or fail**; it cannot drain.

**Finding B1 (hardening):** the swap `pool_state`/vaults are not *required* to equal
`machine.pool` — only the *pricing* pool is. Safety is real but rests on `min_out` +
Raydium's internal checks rather than an explicit pin. Pinning the swap pool to
`machine.pool` would make the swap and the price read provably the same market.

## 3. The SCALE-2 snapshot, adversarially

- **Can a hostile cranker split two identical requests?** —
  `redteam_snapshot_cranker_cannot_split_identical_lps` runs the exact SCALE-1 attack
  (cranker = lp2 processes lp1, interleaves a jackpot settle, then processes itself)
  and asserts `pay1 == pay2 == payout(shares, frozen_snapshot)`. **No** — every
  withdrawer of an epoch is priced at the single frozen `withdraw_snapshot_price`, so
  ordering can't move money between identical requests.
- **Can the freeze-timing be weaponized?** The cranker chooses *when* the first crank
  of an epoch freezes the snapshot (`(pool − reserved)/total` at that moment). A
  cranker who is also a withdrawer can wait for a favorable intra-epoch pool state
  (e.g. after a losing spin lifts the pool) to raise the snapshot — extracting from
  stayers — or crank early to lower it. This is **B3**, a real but bounded lever: the
  intra-epoch pool move is bounded per spin by the exposure cap (≤ ~1% of the pool),
  and any withdrawer can self-crank at the same moment, so it is a shared timing option
  rather than a private edge. Disclosed as the SCALE-2 residual.
- **The "commit-after-freeze then jackpot" carry-over** cannot be turned into a
  repeatable edge: forcing the carry requires the attacker's own spin to jackpot, which
  is Switchboard-random with negative expected value (the house edge). Reasoned + the
  SCALE.md §1b residual note. **Bucket C.**

## 4. Economic / accounting attacks

- **Steal a prior dividend by depositing right before an accrual** —
  `redteam_dividend_prior_accrual_theft_fails`: the attacker makes a large deposit
  *after* 3 SOL has accrued to the victim, then claims. The MasterChef `sol_debt`
  (house-math `debt_preserving_pending`) sets the new shares' entitlement to prior
  accrual to **exactly zero**, so the claim pays nothing (only a tx fee) and the victim
  is undiluted. **Rejected by the ledger math.**
- **Escape the exposure cap by sizing the wager to the boundary** —
  `redteam_max_bet_cap_holds_at_the_edge`: `wager = max_bet + 1` is rejected
  (`require!((wager as u128) <= max_bet, BetExceedsMax)`); `wager = max_bet` is accepted
  and the reserved exposure stays `≤ MAX_EXPOSURE_BP` (1%) of the pool. **Bounded.**
- **Harvest flooring dust via repeated deposit/withdraw** —
  `redteam_dust_roundtrip_never_profits`: three deposit→request→process cycles with an
  odd amount each net `≤ 0` for the attacker. The snapshot floors *toward the pool*, so
  a round-trip always loses dust to the pool/stayers. **Bounded (dust favors the pool).**

**Result: none.** The rounding discipline (dust favors the pool), the exposure cap, and
the dividend ledger all resist the standard AMM/lending economic attacks.

## 5. Randomness / price gate boundary

- **Swap the randomness account between commit and settle** to re-roll a jackpot —
  `redteam_settle_swapped_randomness_rejected` (single + dual). Rejected by the seam:
  `require_keys_eq!(account.key(), pending_spin.randomness)` + `require_keys_eq!(
  *account.owner, crate::ID)`. The FX snapshot analog — the price is frozen at commit
  (`price_at_commit_1e12`) and settle re-reads only the *randomness*, never re-prices —
  so a mid-flight account swap cannot change the payout basis.
- **Supply a rigged price account at commit** — `redteam_foreign_price_account_rejected`:
  rejected by `require_keys_eq!(pool.key(), machine.pool)`.
- **Band edge exactly at the boundary** — exercised by
  `redteam_compound_min_out_floor_holds` / `redteam_compound_out_of_band_noops` (3% =
  allowed, 4% = refused). The existing seam unit tests (`switchboard_seam_tests`,
  `c_band_gate_blocks_and_allows`, `d_staleness_gate_blocks`) cover the rest.

**Result: constrained.**

## 6. Off-chain surfaces (indexer)

The indexer is the one non-chain-read path. Attacks (node tests in
`indexer/test/redteam.test.ts`):

- **Store a forged payout as verified** — `recomputeSpin` with a tampered paid amount
  (up or down) is flagged **mismatch**, never verified. Recompute integrity is the
  indexer's whole trust story.
- **Flag a valid spin as mismatch / launder one as verified via unrecoverable side
  data** — `reels/wager = null` → **unverifiable**, never a false mismatch or verified.
- **Crash the parser with hostile data** — garbage (`NaN`) reels do not crash the
  recompute and cannot legitimize a payout (no valid `k` → not verified); `parseSettle`
  on a non-settle / empty tx returns `null` (the loop skips it).
- **Corrupt the store by re-ingesting** — the `signature` primary key + `INSERT OR
  IGNORE` make re-ingest a no-op; a stored `mismatch` is never flipped to `verified`.
- **SQL-inject via a route param** — `spinsFor("'; DROP TABLE spins;--", …)` returns
  `[]` and the table survives: all store reads are parameterized prepared statements
  (bound `?`), so a hostile machine pubkey / cursor is inert data. The HTTP API is
  read-only (405 on non-GET), CORS-open on purpose (public devnet data), and does no
  filesystem access, so there is no injection or path traversal.

**Finding B2 (hardening):** the ingest loop (`ingest.ts`, `for (const s of sigs)`) has
no per-spin `try/catch`, so an exception during one spin's recompute aborts the whole
pass. Not attacker-reachable today (the randomness/machine bytes are Switchboard-/
program-owned and can't be forged), but a lying RPC could stall ingest. Mitigation:
per-spin try/catch → store `unverifiable` → continue.

**App (reasoned):** every state-changing action is a real on-chain tx the program
validates, so a hostile machine (a curator can only create machines whose params pass
`create_machine`/`create_machine_dual`'s RTP-band + exposure + margin-floor gates) or a
lying RPC (spoofed `getProgramAccounts`) can mislead the *display* but cannot induce a
signature that drains the session key elsewhere — payouts go to the player, the session
key only ever pays its own wagers, and its loss is bounded by the buy-in (disclosed).
**Bucket C.**

## 7. Griefing / DoS

Cross-referenced with SCALE.md, not re-demonstrated: the pending-spin cap fill (SCALE
§2), epoch-drain latency (§3), keeper-lapse gate refusals (§5). New angles inspected:
**compound crank front-running** is harmless — the crank is permissionless and
`compound_mint_shares` is non-dilutive, so who cranks doesn't change the compounder's
shares; **withdrawal-queue clogging** is bounded by the epoch gate + free-liquidity cap;
**rent strand** on a conservative full exit is the disclosed SCALE-2 behavior (surplus
favors stayers). **Bucket C / cross-ref.**

---

## Surfaces I could only reason about (not fully test)

- **The real Raydium `swap_v2` CPI** — LiteSVM has no Raydium program, so the mock swap
  proves the *accounting* and the on-chain wiring is proven live on devnet
  (`scripts/devnet-compound.ts`). The constraints that make it safe (CLMM owner-check,
  output-vault address, `min_out`) are tested at the `compound_epoch` level; Raydium's
  *internal* pool↔vault↔mint validation is quoted, not executed here.
- **The app's wallet-adapter / session-key signing** — reasoned from the program's
  validation guarantees (a harmful signature would need the program to accept a harmful
  tx, which the constraints above forbid); not driven headlessly with a hostile RPC in
  this pass.

## Reproducing

```sh
cd programs/house && cargo build-sbf --features mock-randomness,mock-price,mock-swap && cd ../..
cargo test -p house --features mock-randomness,mock-price,mock-swap redteam_   # 15 on-chain attacks
cd indexer && node --test test/redteam.test.ts                                 # 6 off-chain attacks
```

## What surprised me

- **The swap CPI's safety is real but *emergent*, not pinned.** The output vault is
  address-checked, but the swap *pool* rides in as an unconstrained `remaining_account`;
  it's safe only because `min_out` (priced off the machine's own pool) + Raydium's
  internal checks box it in so mis-routing "can only help or fail." That's a correct
  argument, but the safety lives in the interaction of three checks rather than one
  explicit constraint — the kind of thing that quietly breaks if `min_out` is ever
  loosened. Pinning the pool (B1) would make it robust to that.
- **The conservative snapshot's flooring direction is load-bearing for security, not
  just fairness.** Because dust floors toward the pool, the dust-harvest round-trip is
  net-negative for the attacker *by construction* — a snapshot that rounded the other
  way would turn a fairness nicety into a slow drain.
