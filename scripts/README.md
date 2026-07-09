# scripts — devnet operations & price-infra tooling

TypeScript run directly with `node --experimental-strip-types <file>.ts` (Node ≥
22) from **inside this directory** so `node_modules` resolves. Devnet RPC comes
from `HOUSE_RPC` (falls back to the public `api.devnet.solana.com`, which is
rate-limited — prefer a private endpoint); the operator wallet from
`HOUSE_WALLET` (falls back to `~/.config/solana/id.json`).

## Price infrastructure: `--pool` (KEEP-0)

`twap-status.ts` and `keeper.ts` operate on **any** Raydium CLMM pool via
`--pool <address>`. With no flag they default to the CHIP/WSOL demo pool
(`raydium-constants.ts` `CLMM_POOL`), so every prior invocation and doc still
works unchanged.

The **ObservationState is derived from the pool**, never passed separately: it is
read from the pool's PoolState at the pinned offset 201 (`layouts.ts` `POOL.observationId`),
so the ring can never disagree with the pool it belongs to. `clmm-swap.ts`'s
`loadPool()` reads a pool's identity — both mints, both decimals, and the
observation account — straight from the PoolState; nothing is hardcoded to CHIP's
token order or 9 decimals.

```bash
# read the price gate for the CHIP demo pool (default) …
node twap-status.ts
# … or for a user-launched vault's pool (header shows the pool + obs it read):
node twap-status.ts --pool FKpemhoD9E7wvoTHR96jgBJevBYxB9s5BmNF5BvcMKJd
node twap-status.ts --pool <addr> --watch      # 10s refresh

# keep a pool's TWAP fresh (alternating dust swaps, ≈0 net drift):
node keeper.ts                                   # CHIP demo pool
node keeper.ts --pool <addr> --interval 20 --amount-sol 0.002
node keeper.ts --pool <addr> --window 300 --max-staleness 90
```

### Warm-up math (why a fresh pool isn't LIVE immediately)

A CLMM TWAP over a window `W` with staleness bound `S` is **LIVE** only when the
observation ring holds **both**:

1. **coverage ≥ W** — the oldest usable observation is at least `W` seconds
   before now, so `cum(now) − cum(now − W)` is defined; and
2. **freshness < S** — the newest observation is younger than `S`.

A brand-new pool starts with an **empty ring** (`0 observations`). Each swap that
crosses the pool's ~15s observation window appends one observation. So a cold
pool needs **at least `W` seconds of continuous keeping** before its first LIVE
read — coverage has to be *built* one observation at a time; there is no
shortcut. After that, LIVE holds as long as a swap lands more often than `S`.

`keeper.ts` prints this progress on every cycle — ring coverage vs `--window`
and newest-obs age vs `--max-staleness` — and announces the moment the pool first
satisfies both:

```
  ✓ TWAP LIVE-capable as of 02:2X:XX — covered 300s window AND newest obs < 90s
```

`--window` / `--max-staleness` are for this warm-up **reporting** only; they do
not change the swaps (still alternating equal-value dust). A machine's real gate
is its own on-chain `twap_window_secs` / `max_staleness_secs` — set them to match
the machine you're keeping.

## User-launched vaults need a keeper (until KEEP-1)

A vault launched through the app wizard is priced by the CLMM pool(s) in its
pool-set. If **no one swaps** those pools, their observation rings go stale and
the vault reads **QUORUM NOT MET** — it cannot be played. The keeper is
operational convenience, not a trust component (anyone's swap freshens the ring),
but *someone* must run it:

```bash
# keep a user vault's pool fresh (one keeper per pool it prices)
node keeper.ts --pool <the vault's CLMM pool>
```

Today this is **one keeper process per pool**. **KEEP-1** (next) is the dynamic
multi-pool keeper: it enumerates every live vault's pool-set, dedupes the pools,
and keeps all of them from a single process on a freshness-driven schedule. Until
KEEP-1 lands, user vaults are LIVE only while a keeper is pointed at their pools —
stop the keeper and the vault returns to STALE within `max_staleness` seconds.

## End-to-end proofs

- `prove-layouts-with-swaps.ts` — executes known swaps and shows the pinned
  offsets move consistently (layout ground-truth).
- `twap-demo.ts` — drives the demo pool through warmup → nudge (TWAP lags spot,
  band OUT) → recovery → staleness; appends to `twap-demo-output.txt`.
- `devnet-dual-spin.ts` — full dual spin on the `dual-chip-1` demo machine.
- `devnet-b5-spin.ts` (KEEP-0) — one dual spin on the **user-launched B5 vault**
  (a 1-pool-set vault): waits for the keeper-freshened aggregated TWAP, commits,
  settles with Switchboard randomness, and independently recomputes the payout.
  Requires `keeper.ts --pool FKpemhoD9E7wvoTHR96jgBJevBYxB9s5BmNF5BvcMKJd` running.
