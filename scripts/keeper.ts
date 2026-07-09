// H6a — keeper: a tiny alternating-direction dust-swap loop that keeps a pool's
// ObservationState fresh so a machine's TWAP read never goes stale. The keeper
// is operational convenience, NOT a trust component (spec §2.2): anyone's swap
// freshens the ring; the keeper just guarantees SOMEONE does.
//
// Alternating directions keep net price drift ≈ 0 (each buy is ~undone by the
// next sell), so freshness is bought without walking the pool away. Reports
// per-swap and extrapolated per-hour cost so the keeper can be budgeted.
//
// KEEP-0: the pool is a parameter — `--pool <address>` (default: the CHIP demo
// pool). Both mints, decimals, and the observation account are read FROM the
// pool state (see loadPool); the sell-leg size is derived from the pool's live
// spot so alternating swaps net ≈ 0 inventory drift on ANY pool, not just CHIP.
// The keeper also prints warm-up progress (ring coverage + freshness vs the
// TWAP window) and announces the moment the pool first becomes LIVE-capable.
//
// Usage:
//   node keeper.ts                                  # CHIP demo pool, 20s pace
//   node keeper.ts --pool <addr> --interval 20 --amount-sol 0.002
//   node keeper.ts --pool <addr> --window 300 --max-staleness 90
import { readFileSync } from "node:fs"; import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { loadRaydium, loadPool, doSwap, DEFAULT_POOL, type PoolCtx } from "./clmm-swap.ts";
import { decodePool } from "./layouts.ts";
import { collectObservations, computeTwap } from "./twap.ts";

const numArg = (k: string, d: number) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const strArg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const INTERVAL = numArg("--interval", 20) * 1000; // ms; must exceed the 15s obs window
const MAX_SWAPS = numArg("--swaps", Infinity);
const AMOUNT_SOL = numArg("--amount-sol", 0.002);
const WINDOW = numArg("--window", 300);          // TWAP window the operator is warming toward
const MAX_STALE = numArg("--max-staleness", 90);  // newest obs must be fresher than this
const POOL_ARG = strArg("--pool", DEFAULT_POOL.toBase58());
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wallet(): Keypair {
  const p = process.env.HOUSE_WALLET ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

/** Ring health for warm-up reporting: coverage, freshness, and whether a TWAP
 *  over WINDOW with MAX_STALE would be LIVE right now. */
async function ringHealth(c: Connection, pool: PoolCtx) {
  const [pb, ob, slot] = await Promise.all([
    c.getAccountInfo(pool.id), c.getAccountInfo(pool.observationId), c.getSlot(),
  ]);
  const now = (await c.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const p = decodePool(pb!.data);
  const obs = collectObservations(ob!.data);
  const t = computeTwap(obs, p.tickCurrent, now, WINDOW, MAX_STALE);
  return { live: t.status === "LIVE", coverageSecs: t.coverageSecs, staleSecs: t.staleSecs, obsCount: t.obsCount, reason: t.reason, spot: p.price };
}

async function main() {
  const owner = wallet();
  const c = new Connection(process.env.HOUSE_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const raydium = await loadRaydium(c, owner);
  const pool = await loadPool(c, new PublicKey(POOL_ARG));

  // Identify the WSOL leg; the other side is the token. The keeper's cost model
  // is SOL-denominated, so one side must be WSOL.
  const aIsSol = pool.mintA.equals(NATIVE_MINT), bIsSol = pool.mintB.equals(NATIVE_MINT);
  if (!aIsSol && !bIsSol) throw new Error(`pool ${pool.id.toBase58()} has no WSOL side — keeper needs one for SOL-denominated dust`);
  const solMint = aIsSol ? pool.mintA : pool.mintB;
  const tokenMint = aIsSol ? pool.mintB : pool.mintA;
  const tokenDecimals = aIsSol ? pool.decimalsB : pool.decimalsA;

  // Size legs to ≈ equal SOL-value so alternating swaps net ≈ 0 inventory drift
  // and the SOL-balance delta measures true keeper cost (fees + impact). The
  // token-per-SOL price is read live from the pool (decodePool → mintB/mintA),
  // inverted if WSOL is mintB — NOT hardcoded to CHIP's 1000/9dp.
  const h0 = await ringHealth(c, pool);
  const tokenPerSol = aIsSol ? h0.spot : 1 / h0.spot;
  const solIn = new BN(Math.round(AMOUNT_SOL * 1e9));
  const tokenIn = new BN(Math.round(AMOUNT_SOL * tokenPerSol * 10 ** tokenDecimals));

  console.log(`keeper start: pool ${pool.id.toBase58().slice(0, 8)}…  obs ${pool.observationId.toBase58().slice(0, 8)}…`);
  console.log(`  pace ${INTERVAL / 1000}s, dust ${AMOUNT_SOL} SOL ⇄ ${(AMOUNT_SOL * tokenPerSol).toFixed(3)} token, wallet ${owner.publicKey.toBase58().slice(0, 8)}…`);
  console.log(`  warm-up target: TWAP window ${WINDOW}s, max-staleness ${MAX_STALE}s`);
  console.log(`  ring @ start: ${h0.obsCount} obs, coverage ${h0.coverageSecs}s / ${WINDOW}s, newest ${isFinite(h0.staleSecs) ? h0.staleSecs + "s" : "—"} old  → ${h0.live ? "LIVE-capable already" : "warming (" + h0.reason + ")"}`);

  const startBal = await c.getBalance(owner.publicKey);
  const startTime = Date.now();
  let liveAnnounced = h0.live;
  if (liveAnnounced) console.log(`  ✓ TWAP LIVE-capable as of ${new Date().toISOString().slice(11, 19)} (covered window + fresh) at keeper start`);

  let n = 0;
  for (; n < MAX_SWAPS; n++) {
    const buy = n % 2 === 0; // buy = SOL→token, sell = token→SOL
    try {
      const r = buy
        ? await doSwap(raydium, c, pool, solMint, solIn, 0.1)
        : await doSwap(raydium, c, pool, tokenMint, tokenIn, 0.1);
      const el = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  [${el}s] swap #${n + 1} ${buy ? "SOL→token" : "token→SOL"}  tx ${r.txId.slice(0, 8)}…  price→${r.priceBefore.toFixed(2)}`);
    } catch (e) {
      console.warn(`  swap #${n + 1} failed: ${(e as Error).message}`);
    }
    // Warm-up progress: report coverage/freshness and announce first LIVE-capable.
    try {
      const h = await ringHealth(c, pool);
      if (!liveAnnounced) {
        console.log(`      warm-up: coverage ${h.coverageSecs}s / ${WINDOW}s, newest ${isFinite(h.staleSecs) ? h.staleSecs + "s" : "—"} old  ${h.live ? "→ LIVE" : "(" + h.reason + ")"}`);
        if (h.live) { liveAnnounced = true; console.log(`  ✓ TWAP LIVE-capable as of ${new Date().toISOString().slice(11, 19)} — covered ${WINDOW}s window AND newest obs < ${MAX_STALE}s`); }
      }
    } catch { /* transient RPC — keep swapping */ }
    if (n + 1 < MAX_SWAPS) await sleep(INTERVAL);
  }

  const endBal = await c.getBalance(owner.publicKey);
  const spentSol = (startBal - endBal) / 1e9;
  const hours = (Date.now() - startTime) / 3.6e6;
  console.log(`\nkeeper done: ${n} swaps in ${(hours * 60).toFixed(1)} min`);
  console.log(`  total cost   : ${spentSol.toFixed(6)} SOL  (${(spentSol / n).toFixed(6)} SOL/swap)`);
  console.log(`  per-hour cost: ${(spentSol / hours).toFixed(5)} SOL/hr  at ${(3600 / (INTERVAL / 1000)).toFixed(0)} swaps/hr`);
}
main().catch((e) => { console.error(e); process.exit(1); });
