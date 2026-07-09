// H6a — twap-status: the price-infrastructure read the H6b machine will do
// on-chain, exercised off-chain against the live devnet pool. Prints spot,
// 5-minute TWAP, observation freshness, band status, and the price_at_commit
// the machine would snapshot under the spec's pure-TWAP default. Cold-start
// (too little history) and staleness are explicit STALE states, not errors.
//
// Run once: `node twap-status.ts`   |   watch: `node twap-status.ts --watch`
// KEEP-0: `--pool <address>` reads ANY CLMM pool (default: the CHIP demo pool).
// The ObservationState is derived from the pool's pinned offset-201 field — not
// a second argument that could disagree with the pool — and the header shows the
// pool actually read (this is what caught the hardcoded-constant bug).
import { Connection, PublicKey } from "@solana/web3.js";
import { decodePool } from "./layouts.ts";
import { collectObservations, computeTwap, BAND_BP, TWAP_WINDOW_SECS, MAX_STALENESS_SECS } from "./twap.ts";
import { CLMM_POOL } from "./raydium-constants.ts";

const RPC = process.env.HOUSE_RPC ?? "https://api.devnet.solana.com";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function poolArg(): PublicKey {
  const i = process.argv.indexOf("--pool");
  return i >= 0 ? new PublicKey(process.argv[i + 1]) : CLMM_POOL;
}

export async function readStatus(c: Connection, poolId: PublicKey = CLMM_POOL) {
  const poolAi = await c.getAccountInfo(poolId);
  if (!poolAi) throw new Error(`pool ${poolId.toBase58()} not found on ${c.rpcEndpoint}`);
  const pool = decodePool(poolAi.data);
  const obsId = new PublicKey(pool.observationId); // pinned offset 201 — always the pool's own ring
  const [obsAi, slot] = await Promise.all([c.getAccountInfo(obsId), c.getSlot()]);
  const now = (await c.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  const obs = collectObservations(obsAi!.data);
  const twap = computeTwap(obs, pool.tickCurrent, now);

  const spot = pool.price; // token per SOL, from sqrt_price
  let bandBp: number | null = null, bandOk: boolean | null = null;
  if (twap.status === "LIVE" && twap.price) {
    bandBp = Math.round(Math.abs(spot - twap.price) / twap.price * 10_000);
    bandOk = bandBp <= BAND_BP;
  }
  return { now, pool, obs, twap, spot, bandBp, bandOk, poolId, obsId };
}

function render(s: Awaited<ReturnType<typeof readStatus>>) {
  const { pool, twap, spot, bandBp, bandOk } = s;
  const time = new Date(s.now * 1000).toISOString().slice(11, 19);
  const live = twap.status === "LIVE";
  const priceAtCommit = live ? twap.price! : null; // pure-TWAP default
  const commitGate = live && bandOk ? "COMMIT ALLOWED" : "COMMIT REFUSED";
  const gateReason = !live ? `PriceStale (${twap.reason})` : !bandOk ? `PriceUnstable (band ${bandBp}bp > ${BAND_BP}bp)` : "—";

  const L: string[] = [];
  L.push(`┌─ twap-status @ ${time} (cluster time)  pool ${s.poolId.toBase58().slice(0, 8)}…  obs ${s.obsId.toBase58().slice(0, 8)}…`);
  L.push(`│  spot (sqrt_price)   : ${spot.toFixed(4)} token/SOL   tick ${pool.tickCurrent}`);
  L.push(`│  5-min TWAP          : ${live ? `${twap.price!.toFixed(4)} token/SOL   avg_tick ${twap.avgTick!.toFixed(1)}` : "—"}   [${twap.status}]`);
  L.push(`│  observations        : ${twap.obsCount} in ring, coverage ${twap.coverageSecs}s / window ${TWAP_WINDOW_SECS}s`);
  L.push(`│  freshness           : newest obs ${isFinite(twap.staleSecs) ? twap.staleSecs + "s" : "—"} old   (max_staleness ${MAX_STALENESS_SECS}s)`);
  if (live) {
    L.push(`│  band |spot−twap|/twap: ${bandBp}bp  vs gate ${BAND_BP}bp   → ${bandOk ? "IN BAND" : "OUT OF BAND"}`);
    L.push(`│  price_at_commit     : ${priceAtCommit!.toFixed(4)} token/SOL  (pure-TWAP default)`);
  } else {
    L.push(`│  band                : n/a (TWAP ${twap.status})`);
    L.push(`│  price_at_commit     : n/a — machine would refuse`);
  }
  L.push(`│  GATE                : ${commitGate}${gateReason !== "—" ? "  — " + gateReason : ""}`);
  L.push(`└─`);
  return L.join("\n");
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  const pool = poolArg();
  const watch = process.argv.includes("--watch");
  do {
    try { console.log(render(await readStatus(c, pool)) + (watch ? "\n" : "")); }
    catch (e) { console.error("read failed:", (e as Error).message); }
    if (watch) await sleep(10_000);
  } while (watch);
}
main().catch((e) => { console.error(e); process.exit(1); });
