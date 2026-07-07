# SCOTTI — app

Vite + React devnet demonstration frontend for the House Module.

## RPC endpoint (avoid the 429s)

The Floor and Liquidity pages scan the program with `getProgramAccounts`, which the
**public** devnet RPC (`api.devnet.solana.com`) rate-limits (HTTP 429). When that
happens the app keeps the last-good pools on screen and shows an amber
"RPC rate-limited — retrying" chip while it backs off — it never blanks the list.

For a smooth experience, put your own devnet endpoint in `app/.env.local`:

```
cp .env.local.example .env.local
# then edit .env.local and set VITE_RPC_URL to your Helius/QuickNode/Triton devnet URL
```

`.env.local` is gitignored. **Do not commit a real key** — `VITE_*` variables are
baked into the client bundle at build time, so the value ships publicly; use a
devnet-only key you can rotate.

## Scripts

- `npm run dev` — dev server
- `npm run build` — `tsc --noEmit && vite build`
- `npm test` — unit tests (`node --test`, e.g. the RPC poll-store backoff/dedup)
