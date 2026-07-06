# Scotti at production scale — crank ordering, contention, and economics

An analysis of how the House Module behaves at volume. The system is correct and
solvent at demo scale; this document asks where it *degrades*, and demonstrates
every claimed failure mode rather than asserting it — each is backed by a named
LiteSVM test (`scale_*` in the mock suites) or a house-math model with pinned
numbers. **No program logic was changed by this analysis** (`git diff --stat`
touches only test files and docs).

Every finding is triaged into exactly one bucket:

- **(A) real bug at any scale** — exploitable or funds-affecting even at demo
  volume. Demonstrated, **not fixed here** (a follow-up session).
- **(B) scale limit** — correct at demo volume, degrades or becomes unfair at
  production volume. The degradation is demonstrated, the threshold quantified,
  and the known mitigation sketched (not built).
- **(C) mainnet-only concern** — precluded by the legal posture; noted for
  completeness, out of scope by design.

---

## Executive summary

> ### (A) finding — ✅ FIXED in FIX-1
>
> **Status: FIXED and live on devnet (FIX-1).** `process_withdrawal_token` was
> reordered so the SOL dividend `debit_credit` is the LAST money movement, after
> the token CPI — mirroring `compound_epoch`'s surgery-last pattern. The program
> was **upgraded in place** ([`3hPp33d3…eXFT`](https://solscan.io/tx/3hPp33d33TN2uUXNfpjHynHGZkswM5bifVDRctuWKpregsMvP4ewspXkLC3BTLd7xudnXjkVKucb2NWWqpzfeXFT?cluster=devnet))
> and the once-reverting combined withdrawal ran **live** on `dual-chip-1`: a
> SOL-mode LP with an unclaimed 2,000,000-lamport dividend executed one
> `process_withdrawal_token` crank ([`3faxnxiW…sSYh`](https://solscan.io/tx/3faxnxiWmQBPe1UBHH7faWEZKuDvLrQTwJR1TJ5ZBFEZ5xgqWFgrpY5vvaVujsv6YRS9Vf9HqcZ7BqfnfrK1sSYh?cluster=devnet)),
> receiving both assets — token pro-rata `1,999,486,046,306` base units and the
> `2,000,000` lamport dividend, exact by recompute. The finding is preserved below
> as the record.
>
> **The bug (as found).** `process_withdrawal_token` reverted
> (`UnbalancedInstruction`) for a SOL-mode LP that withdrew while holding an
> unclaimed SOL dividend, because the handler moved lamports out of the machine PDA
> (`debit_credit` for the dividend) *before* the token-transfer CPI — the "PDA
> lamport surgery before a CPI trips UnbalancedInstruction" gotcha that
> `compound_epoch` was written to avoid (it does its surgery last). The existing
> books-balance test sidestepped the bug by claiming the dividend first, so the
> combined single-crank path shipped **untested**.
>
> - **Demonstration → now the positive test.** Was
>   `scale_g_bug_a_*` (asserted the revert); FIX-1 rewrote it to
>   `scale_g_fix_sol_dividend_plus_token_withdraw_one_crank` (asserts the correct
>   one-crank both-asset payout, books balanced, position closes), added
>   `scale_g_regression_combined_equals_claim_then_withdraw` (the combined path is
>   economically identical to claim-then-withdraw), and kept the control
>   `scale_g2_spl_mode_withdraw_with_dividend_is_fine` (SPL mode earmarks — no
>   surgery — so it never regressed).
> - **Funds at risk?** **No loss even before the fix.** The LP's tokens and dividend
>   were both recoverable — `claim_sol` first, then withdraw. It was a
>   correctness/liveness bug (the intended one-crank both-asset exit broken for any
>   SOL-mode LP with accrued dividends), not a drain — but a real bug in deployed
>   code, now fixed.
> - **The fix (shipped):** reorder `process_withdrawal_token` so the SOL
>   `debit_credit` is the **last** money movement, after the token CPI — exactly the
>   pattern `compound_epoch`/`amm_swap_sol_to_token` document ("as the swap's last op,
>   so the only balance check is at instruction return"). A pure reordering; same
>   accounts, amounts, rounding, close condition. IDL byte-identical.

Everything else is a **(B) scale limit** or **(C) mainnet-only**. The headline
(B): withdrawal payouts are **crank-order-dependent** whenever a spin settles
between two LPs' cranks — the later-cranked LP eats the interleaved variance, and
the cranker chooses the order. This is the "crank-order / FIFO" item the design
explicitly deferred; it is bounded per spin by the exposure cap and is liveness-safe
(any LP can self-crank), but it is genuinely unfair under contention.

### Bucket table

| # | finding | bucket | demonstration |
|---|---|---|---|
| 1a | SOL-mode dividend + token withdraw reverted (`UnbalancedInstruction`) — **✅ FIXED (FIX-1)**, live-verified | **A** | `scale_g_fix_*` + `scale_g_regression_*` + control `scale_g2_*` |
| 1b | Withdrawal payout depends on crank order when a spin interleaves (single: lamport price; dual: token balance) | **B** | `scale_a_crank_order_dumps_interleaved_jackpot_on_later_lp`, `scale_f_dual_token_withdraw_order_payoff` |
| 1c | Indefinite starvation by a hostile cranker | not a bug | `scale_b_no_starvation_victim_self_cranks` (permissionless self-crank) |
| 2 | Pending-spin cap (100) cheaply deniable; self-heals via permissionless expire | **B** | `scale_e_pending_cap_denies_then_permissionlessly_heals`, `scale_model_pending_slot_capital` |
| 3 | Epoch-boundary drain latency: N positions = N serial cranks | **B** | model (below) + `scale_a`/`w_d` pricing behavior |
| 4 | Per-position compounding: N swaps/epoch, band may close mid-sequence | **B** | `scale_h_compound_per_position_band_close_is_variance_not_dilution` |
| 5 | Keeper economics + TWAP window vs a busy pool's ring coverage | **B** | model (below); staleness = refusals not losses (`d_staleness_gate_blocks`) |
| 6 | Spin throughput vs the ~150–200k realization horizon | **C** | model (below) |
| 7 | Off-chain scans (`getProgramAccounts`) + ingest cost | **B** | IDX-1 watermark (built) + model |

---

## 1. Withdrawal crank ordering

`process_withdrawals` (single) and `process_withdrawal_token` (dual) each handle
**one position per crank**, in an order the cranker picks, and both are
**permissionless** (`cranker: Signer` is "literally anyone"; the payout always
goes to `owner`).

### 1a — (A) the SOL-mode dividend + token withdraw revert — ✅ FIXED (FIX-1)

Covered in the executive summary. The revert (surgery before the token CPI) was
FIXED in FIX-1 by moving the SOL `debit_credit` to the last money movement, after
the CPI. Now demonstrated by the positive test
`scale_g_fix_sol_dividend_plus_token_withdraw_one_crank` and the
`scale_g_regression_combined_equals_claim_then_withdraw` equivalence test;
`scale_g2_*` (SPL mode) remains the control. Shipped to devnet by in-place upgrade
[`3hPp33d3…eXFT`](https://solscan.io/tx/3hPp33d33TN2uUXNfpjHynHGZkswM5bifVDRctuWKpregsMvP4ewspXkLC3BTLd7xudnXjkVKucb2NWWqpzfeXFT?cluster=devnet)
and verified live on `dual-chip-1`
([`3faxnxiW…sSYh`](https://solscan.io/tx/3faxnxiWmQBPe1UBHH7faWEZKuDvLrQTwJR1TJ5ZBFEZ5xgqWFgrpY5vvaVujsv6YRS9Vf9HqcZ7BqfnfrK1sSYh?cluster=devnet)):
one crank paid `1,999,486,046,306` CHIP base units + `2,000,000` lamports, exact by
recompute. **Bucket A, fixed.**

### 1b — (B) the ordering payoff

**Question:** do two LPs with identical requests receive different amounts
depending on processing order, and can a cranker exploit it?

**Answer: yes, whenever a spin settles between the two cranks.** The payout is
priced at the pool state *at processing*. Two identical LPs both queue a full exit
for the same epoch; a **jackpot** settles between their cranks; the LP cranked
**second** absorbs the entire interleaved loss:

- **Single-asset** (`scale_a_crank_order_dumps_interleaved_jackpot_on_later_lp`):
  lp1 (also the cranker) processes itself at the pre-jackpot price and recovers its
  full deposit; the jackpot settles; lp2 is processed at the post-jackpot pool. The
  test pins the gap exactly: `pay1 − pay2 == max_payout − wager` — **the entire net
  jackpot cost falls on the later LP.** Being permissionless, the cranker can bundle
  `[process_self, settle_jackpot, process_victim]`.
- **Dual-asset** (`scale_f_dual_token_withdraw_order_payoff`): dual withdrawals are
  **price-free** (no TWAP read → manipulation-immune), but the token side is still
  pro-rata of the token balance *at processing*. So the same payoff applies to the
  token side: `tokens1 − tokens2 == max_payout_tokens` (the later LP eats the token
  jackpot). Only the **SOL dividend** side is order-independent — a per-share
  MasterChef ledger (`k_deposit_accrue_claim`, `worked_example`,
  house-math `dividend::conservation`). So dual is *manipulation*-fair but not
  *ordering*-fair on the token side.

**Magnitude bound:** the per-spin gap is bounded by the exposure cap — a single
spin's worst case is `max_payout ≤ ~max_exposure_bp` of the pool (≈1% at the demo
setting). So one interleaved jackpot shifts ≤ ~1% of the pool onto the later LP;
the unfairness accumulates only across many interleaved settlements during a drain.

**Contrast (the fair case):** `w_d_two_lps_sequential_pricing` already shows that
*absent* a price move, order does **not** change amounts — withdrawals burn shares
and pool value proportionally, so the share price is invariant to withdrawals
themselves.

**Bucket B.** **Mitigation (not built):** snapshot a single withdrawal price (single:
`pool_value/total_shares`; dual: token-per-share) once per epoch boundary and pay
every queued position of that epoch at that frozen price, or process strictly FIFO
by request slot with the price fixed at the first processable crank. Either makes
the interleaved variance shared pro-rata among the epoch's withdrawers instead of
dumped on whoever is cranked last. This is precisely the "crank-order / FIFO
consideration for production scale" the design deferred.

### 1c — starvation is not possible (self-heal)

**Question:** can a cranker starve a specific LP indefinitely?

**Answer: no.** The crank is permissionless and pays `owner` regardless of signer,
so a hostile cranker that refuses to process a victim changes nothing: the victim
**cranks itself** and is paid to the lamport (`scale_b_no_starvation_victim_self_cranks`).
Liveness is never at a third party's mercy; only the *ordering* of an interleaved
jackpot (1b) is contestable, and an LP minimizes that exposure by self-cranking the
instant its epoch elapses.

---

## 2. Pending-spin slot contention

**Question:** `max_pending_spins = 100`. Can a bot fill all 100 cheaply and deny
service, what does holding a slot cost, and does the machine self-heal?

**Demonstration:** `scale_e_pending_cap_denies_then_permissionlessly_heals` (with a
cap of 3 for speed) fills every slot, shows the next `spin_commit_dual` is refused
with `TooManyPendingSpins`, then — past `EXPIRE_SLOTS` — has a **stranger**
`spin_expire_dual` an abandoned spin (permissionless) and shows a fresh commit
succeeds again.

**Pinned economics** (`scale_model_pending_slot_capital`, numbers from house-math at
the demo params: 1000 CHIP/SOL, 9 decimals, 1500 bp haircut, SHALLOW `k_max = 10337`):

| wager | reserve pinned (from the machine's *own* vault) |
|---|---|
| 1 lamport | 59,437 base units ≈ **0.0000594 CHIP** |
| 1,000 lamports (1e-6 SOL) | 59,437,750 ≈ 0.0594 CHIP |
| 10,000,000 lamports (0.01 SOL) | 594,377,500,000 ≈ 594.4 CHIP |

The token reserve is drawn from the **machine's** vault, not the bot's wallet — the
bot only escrows the (refundable) wager. So **slot denial is decoupled from
liquidity locking**: filling all 100 slots with 1-lamport wagers costs the bot
**100 lamports of refundable escrow + ~100 tx fees ≈ 0.0005 SOL sunk**, while
pinning only `100 × 59,437 ≈ 0.006 CHIP` of the pool — effectively nothing.

**What frees a slot:** a `settle` (needs a reveal the bot has no reason to provide)
or a **permissionless** `spin_expire_dual` after `EXPIRE_SLOTS = SMOOTH_WINDOW_SLOTS
= 9000 slots ≈ 1 hour`. So a maximally-griefed machine's commit path is denied for
**up to ~1 hour per fill**, then anyone heals it; a bot sustaining the denial pays
~0.0005 SOL per refill.

**Bucket B** (cheap griefing of *new commits* on one machine; self-healing; no funds
at risk; existing pending spins settle/expire normally). *Single-asset machines have
**no** pending cap at all* — there the analogous vector is `reserved_exposure`
exhaustion (each pending spin reserves its `max_payout`), which blocks withdrawals
and shrinks others' `max_bet` until settle/expire; but it costs the bot real
escrowed SOL (≈ pool/`top_mult` to lock the pool) and is likewise ~1h self-healing.
**Mitigation (not built):** a per-committer pending cap, a small commit bond that is
slashed on expiry, or priority-fee-ordered slot reclamation.

---

## 3. Epoch-boundary drain latency

**Question:** all queued withdrawals become processable at the same boundary. With
one position per crank, what is the drain latency for N positions, and does anything
change between the first and last processed?

**Model.** Each `process_*` writes the machine account, so cranks on one machine
**serialize** (Solana cannot parallelize writers of the same account); several may
be batched into one tx (the doc-comment notes "cranking several in one tx prices
each at the state left by the previous"), but they still execute sequentially.
Drain latency ≈ `⌈N / batch⌉` transactions, batch bounded by the CU limit (~tens of
`process` ix per tx). At ~1 tx/slot that is sub-second for tens of LPs and a few
minutes for thousands.

**What changes first→last:** absent spins, **nothing** — withdrawals don't move the
share price (item 1b contrast, `w_d`), so a batch drained back-to-back pays every
position identically per share. The *only* thing that changes a later position's
payout is a **spin settling mid-drain**, which ties back to item 1b: the ordering
payoff *is* the epoch-boundary fairness question. A long drain that overlaps live
play exposes later-cranked LPs to more interleaved variance.

**Bucket B.** Mitigation is the same epoch-price snapshot as 1b (which also removes
the drain-order sensitivity entirely).

---

## 4. `compound_epoch` at N SPL-mode positions

**Question:** compounding is per-position, once per epoch, with a real swap each —
N swaps per epoch and N× the band-gate exposure, versus the spec's original *one
aggregated swap per epoch*. Is the difference unfair, and does it break non-dilution?

**Demonstration:** `scale_h_compound_per_position_band_close_is_variance_not_dilution`.
Two SPL positions A and B (plus a SOL-mode canary C). In one epoch: A compounds
while the band is open; the band then **closes mid-sequence** (spot pushed 5% off
TWAP); B's compound **no-ops and succeeds**, earmark intact (never a forced fill);
the band reopens and B compounds later. Assertions:

- **Non-dilution holds per-position.** The SOL-mode canary C's token claim
  (`shares × token_balance / total_shares`) is **non-decreasing** across both
  compounds — the shipped per-position path preserves the `compound_mint_shares`
  guarantee (house-math `dividend::compound_mint_shares`, proven non-dilutive: shares
  are minted at the pre-swap price). So per-position compounding does **not** change
  the non-dilution story — stated explicitly, and demonstrated.
- **Band-close mid-sequence is variance, not unfairness.** A position compounded
  this epoch got that epoch's price; a position that waited compounds later at a
  different price. Neither loses its earmark; the difference is timing variance,
  symmetric in expectation, not value extraction.

**Cost is the real scale limit.** N positions ⇒ **N swaps** ⇒ N× the swap fees and
N× the ~175k-CU compound cost per epoch, versus one aggregated swap. At the demo's
handful of LPs this is negligible; at hundreds of SPL LPs it is hundreds of on-chain
swaps per epoch, each paying the AMM fee and moving the price a little (N× the
band-gate exposure the spec flagged).

**Bucket B** (cost/efficiency, not correctness). **Mitigation (not built):** the
spec's original aggregate design — a single per-epoch swap of the summed earmarked
SOL, with shares minted to each position pro-rata at the shared pre-swap price. It
restores O(1) swaps/epoch and one band crossing, at the cost of a more complex
crank that must fairly attribute one swap's output across positions.

---

## 5. Keeper economics + staleness at volume

**Question:** at demo scale the keeper is ~break-even and organic swaps are absent.
When does the keeper become unnecessary, what breaks when it lapses, and can a
*busy* pool ever have less usable TWAP window than a quiet one?

**Keeper crossover.** The pool must be observed within `max_staleness_secs`
(default 90s) or commits refuse. The keeper exists only to guarantee that. Once
**organic** swaps arrive faster than the staleness bound — interarrival < ~90s, i.e.
≳ 1 swap/90s ≈ 40 swaps/hour — the keeper is redundant; anyone's swap freshens the
ring. Below that (demo reality: ~0 organic swaps), the keeper is required.

**Lapse = refusals, not losses (confirmed).** When observations age past
`max_staleness_secs`, `eval_price_gates` returns `PriceStale` and
`spin_commit_dual` **refuses** (no SOL moves; `d_staleness_gate_blocks`), and
`compound_epoch` **no-ops** (`scale_h` shows the out-of-band/stale no-op path). No
pending spin is affected — settles read the snapshot, not the live price. So a keeper
outage is a **liveness** event (new commits paused) with **zero** fund impact.

**The counterintuitive ring bound — and where it bites.** The observation ring is
**100** wide, and Raydium writes **at most one observation per 15 s**
(`observationUpdateDuration`, ground-truthed in H6a: "the observation index advanced
once per >15 s window"). So the ring's minimum span is bounded **below**, not above:

```
min ring coverage = (100 − 1) × 15 s = 1485 s ≈ 24.75 min
```

A *naïve* per-swap oracle would shrink under load (100 swaps in <300 s ⇒ <300 s of
history), but Raydium's 15 s throttle prevents that: coverage is **always ≥ 1485 s**
regardless of swap rate. Therefore:

- The **demo** `twap_window_secs = 300 s` is always satisfiable (300 < 1485) — a
  busy pool never starves the 5-minute TWAP.
- The **spec's production 30-minute window (1800 s) is NOT safe.** A maximally-busy
  pool (a new observation every 15 s) covers only 1485 s < 1800 s ⇒ the 30-min TWAP
  can't be formed ⇒ cold-start `PriceStale` refusals *on a busy pool*. The exact
  threshold: the window must satisfy `window ≤ 99 × min_obs_interval`. With Raydium's
  15 s throttle, **any `twap_window_secs > 1485 s` can be starved by a busy pool** —
  so, counterintuitively, a busy pool *can* have less usable window than a quiet one.

**Bucket B.** **Mitigation (not built):** cap `twap_window_secs ≤ 99 × 15 = 1485 s`
(≈24 min) so the ring always covers it, or read across multiple Raydium observation
accounts to widen coverage. The current demo value is already safe; the spec's 30-min
default is the one to correct.

---

## 6. Realization horizon under saturation

**Question:** the spec cites ~150–200k spins to statistically resolve the dual
discount. Given `max_pending_spins = 100` and Switchboard reveal latency ~2–4 s,
what is the actual max spin throughput per machine, and does the horizon hold?

**Model.** Three candidate limits:

1. **Reveal latency** — a spin can't settle until its reveal lands (~3 s).
2. **Pending cap** — ≤ 100 spins in flight, so ≤ 100 settle per reveal window:
   `100 / 3 s ≈ 33 spins/s` upper bound.
3. **Per-machine account write serialization** — every `commit` and every `settle`
   writes the machine account, so a spin costs **2 serialized machine-writes**; these
   cannot parallelize across a machine. This, not the cap or the latency, is the
   binding constraint.

Pinned range: the pending-cap/latency bound is **~33 spins/s** (~2.9M/day) *peak*;
the write-serialization bound is far lower — pessimistically ~1 machine-write/slot ⇒
~1 spin / 2 slots ⇒ **~1.25 spins/s (~108k/day)**. Real throughput sits between,
and 150–200k spins is therefore **~1.3 h (throughput-bound) to ~1.5+ days
(write-serialized)** of *continuous, saturated* single-machine play.

**Does the horizon claim hold?** Yes. The discount is a statistical edge that only
resolves over 150–200k spins, which is **hours-to-days** of saturated play on ONE
machine — never approached at any devnet volume (the live floor has tens of spins
total). So the discount stays unrealized noise, exactly as the spec claims; the
throughput ceiling makes that *more* true, not less.

**Bucket C** (a mainnet-scale statistical horizon, moot under the legal gate) with the
throughput numbers pinned above.

---

## 7. Off-chain surfaces at volume

- **`getSignaturesForAddress` paging vs the indexer watermark — handled (verify &
  cite).** The IDX-1 indexer pages program signatures until exhausted
  (`programSignatures`, `MAX_SIG_PAGES`) and advances a **slot watermark**
  (`spin_watermark_slot`) each pass, processing only sigs above it; all inserts are
  `INSERT OR IGNORE` keyed on the settle signature. So re-runs never duplicate and
  steady-state ingest is forward-only after the first backfill — demonstrated by the
  IDX-1 idempotency test (`ingest twice ⇒ identical row counts`). No action needed.
- **`getProgramAccounts` scans as machine count grows — (B).** `listMachines` /
  `listDualMachines` issue a `getProgramAccounts` with a discriminator `memcmp`,
  which is a server-side scan of all program accounts — fine at tens/hundreds of
  machines, an increasingly heavy RPC call as the floor grows to thousands.
  Mitigation (not built): a small on-chain registry account listing machine pubkeys,
  or a cursor/pagination layer, so enumeration is O(machines) client-side rather than
  O(all program accounts) server-side.
- **Indexer ingest recompute cost per spin — (B), linear.** Each spin costs O(1)
  work: ~4–6 RPC reads (settle tx, the commit tx via a ≤20-signature scan of the spin
  PDA, the randomness account, and — dual — pool + observation) plus house-math. The
  binding cost at volume is the `getTransaction` rate against the RPC, already paced
  by the indexer's throttle; ingest scales linearly with spin volume and never
  recomputes an already-stored settle.

---

## Appendix — reproducing the demonstrations

```sh
# scale_* tests live in the mock suites; build the mock .so, then run them.
cd programs/house && cargo build-sbf --features mock-randomness,mock-price,mock-swap && cd ../..
cargo test -p house --features mock-randomness,mock-price,mock-swap scale_

# pre-existing suites are unchanged (counts rise only by the new scale_* tests):
cargo test --workspace                                                   # 10 + 48 + 1
cargo test -p house --features mock-randomness,mock-price,mock-swap      # test_house 19, test_dual 24, gate 1
```

Named tests referenced above:
`scale_a_crank_order_dumps_interleaved_jackpot_on_later_lp`,
`scale_b_no_starvation_victim_self_cranks` (test_house.rs);
`scale_e_pending_cap_denies_then_permissionlessly_heals`,
`scale_f_dual_token_withdraw_order_payoff`,
`scale_g_fix_sol_dividend_plus_token_withdraw_one_crank` (FIX-1, was
`scale_g_bug_a_*`), `scale_g_regression_combined_equals_claim_then_withdraw`,
`scale_g2_spl_mode_withdraw_with_dividend_is_fine`,
`scale_h_compound_per_position_band_close_is_variance_not_dilution`,
`scale_model_pending_slot_capital` (test_dual.rs).
