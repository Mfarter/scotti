// H6a REGRESSION GUARD — re-checks the pinned offsets in layouts.ts against the
// LIVE devnet accounts and fails loudly (exit 1) on drift. This is the
// Session-3/4 discipline applied to someone else's program: if Raydium upgrades
// the CLMM and shifts a field, this test screams before any house code trusts a
// stale offset. Run: `node verify-layouts.ts`.
//
// ── Reconciliation with the "published" structs (the headline) ──────────────
// Verified against the CURRENT raydium-clmm source
//   programs/amm/src/states/oracle.rs  and  states/pool.rs
// The deployed devnet program's PoolState and ObservationState are
// `#[repr(C, packed)]` zero-copy accounts. The offsets ONLY line up if the
// packed (no-alignment-padding) layout is honored:
//   • ObservationState: initialized(bool)@8, recent_epoch(u64)@9  ← packed: no
//     4/8-byte pad after the bool; a naive #[repr(C)] struct would put
//     recent_epoch@16 and observation_index@24 and misread everything.
//   • observation_index(u16)@17, pool_id@19, observations[100]@51.
//   • Each Observation is 44 bytes: block_timestamp(u32)@+0, tick_cumulative
//     (i64)@+4  ← packed: no 4-byte pad before the i64, so tick_cumulative is at
//     +4, NOT +8. Then 32 bytes padding ([u64;4]).
// Practitioner warning (spec §2.1), CONFIRMED from bytes + known swaps:
//   1. Observations store CUMULATIVE TICK ONLY — block_timestamp + tick_cumulative.
//      No per-observation sqrt_price / secondsPerLiquidity (the Uniswap-V3 shape
//      some older copy-pasted CPI structs assume). The 32 trailing bytes/item
//      are asserted zero below.
//   2. The ring is 100 wide (OBSERVATION_NUM=100), not the 1000 some old structs
//      assume; observation_index lives in ObservationState@17, not in PoolState.
import { Connection, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { POOL, OBS, decodePool, decodeObs, base58, readPubkey } from "./layouts.ts";
import { CLMM_POOL, OBSERVATION_STATE, CHIP_MINT } from "./raydium-constants.ts";

const RPC = process.env.HOUSE_RPC ?? "https://api.devnet.solana.com";
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "  OK  " : "  FAIL"} ${name}${detail ? "  — " + detail : ""}`);
  if (!cond) failures++;
}

async function main() {
  const c = new Connection(RPC, "confirmed");
  const pool = await c.getAccountInfo(CLMM_POOL);
  const obs = await c.getAccountInfo(OBSERVATION_STATE);
  if (!pool || !obs) throw new Error("pool or observation account not found on devnet");

  console.log("PoolState:", CLMM_POOL.toBase58());
  check("PoolState length == pinned span", pool.data.length === POOL.SPAN, `${pool.data.length} vs ${POOL.SPAN}`);
  check("PoolState owner == CLMM program", pool.owner.toBase58() === "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");
  const p = decodePool(pool.data);
  check("pool.mintA @73 == WSOL", base58(p.mintA) === NATIVE_MINT.toBase58());
  check("pool.mintB @105 == CHIP", base58(p.mintB) === CHIP_MINT.toBase58());
  check("pool.tickSpacing @235 == 10", p.tickSpacing === 10, `got ${p.tickSpacing}`);
  check("pool.observationId @201 == OBSERVATION_STATE (cross-link)", p.observationId === OBSERVATION_STATE.toBase58());
  const impliedFromTick = Math.pow(1.0001, p.tickCurrent);
  const consistent = Math.abs(impliedFromTick - p.price) / p.price < 1e-3;
  check("sqrtPriceX64 @253 <-> tickCurrent @269 consistent", consistent,
    `price=${p.price.toFixed(4)}, 1.0001^tick=${impliedFromTick.toFixed(4)}`);

  console.log("\nObservationState:", OBSERVATION_STATE.toBase58());
  check("Observation length == pinned span", obs.data.length === OBS.SPAN, `${obs.data.length} vs ${OBS.SPAN}`);
  const o = decodeObs(obs.data);
  check("obs.poolId @19 == CLMM_POOL (cross-link)", o.poolId === CLMM_POOL.toBase58());
  check("obs.observationIndex @17 in [0,99]", o.observationIndex >= 0 && o.observationIndex < 100, `idx=${o.observationIndex}`);
  // the current observation is either cold (ts 0) or a plausible recent unix time
  const now = Math.floor(Date.now() / 1000);
  const ts = o.current.blockTimestamp;
  check("obs.current.blockTimestamp cold(0) or recent", ts === 0 || (ts > 1_700_000_000 && ts <= now + 120), `ts=${ts}`);
  // CRITICAL: prove "cumulative tick only" — each observation item's trailing 32
  // pad bytes must be zero across the whole ring (no hidden sqrt/secondsPerLiq).
  let padNonZero = 0;
  for (let i = 0; i < OBS.COUNT; i++) {
    const off = OBS.observations + i * OBS.ITEM_STRIDE + OBS.ITEM_padding;
    for (let j = 0; j < 32; j++) if (obs.data[off + j] !== 0) padNonZero++;
  }
  check("every observation's 32 pad bytes are zero (cumulative-tick-only)", padNonZero === 0, `${padNonZero} nonzero pad bytes`);

  console.log(`\n${failures === 0 ? "PASS — all pinned offsets hold against live devnet accounts."
    : `FAIL — ${failures} check(s) drifted. Re-run prove-layouts-with-swaps.ts and re-pin layouts.ts.`}`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
