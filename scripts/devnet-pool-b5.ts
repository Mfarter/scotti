// POOL-1 — create + seed a Raydium CLMM pool for B5tR8Tzo…/WSOL on devnet,
// MIRRORING dual-chip-1's CHIP/WSOL pool so the token is immediately usable in the
// vault launch wizard.
//
// GROUND-TRUTH / layout discipline (H6a / LIQ-1 precedent): the create + open/seed
// instruction layouts are NOT hand-built — they are produced by the SAME Raydium
// SDK v2 CLMM path that created dual-chip-1's pool and position on devnet:
//   createPool tx  289qnA4xfuYTSNB1Vjz6jr5xT1TLSy4Hv6bjxhtcTwFkdDdSyC61Ni65STNn34NWTGXJwCRLQSTtzpFVXmg2sLKG
//   seed/open tx   4gqxBiVGdvb11M3vRBFiqEmB1PnPy4pBR2ugKpuRKbBwSd36S6RUzUZ2e3RgmKBjWfpnzbG2ZCrS2MQJuAvZCPg5
// so no new layout is trusted. This file is create-clmm-pool.ts adapted to B5, at
// dual-chip-1's FULL depth (1.9 WSOL, approved), writing pool-b5.json — pool.json
// (dual-chip-1) is never touched.
//
// Mirrored config: ammConfig FZdkW5… (index 2, tickSpacing 10, 0.05%); initialPrice
// 0.001 WSOL-per-B5 = 1000 B5/SOL; wide position 600–1800 B5/SOL. B5 shares CHIP's
// 9 decimals + WSOL pairing, so the price is identical + unambiguous; the script
// still SANITY-CHECKS the on-chain price ≈ 1000 B5/SOL before seeding.
//
// Idempotent-ish: if pool-b5.json already has a poolId, Stage A is skipped;
// re-running Stage B opens/adds to the position, never leaking half-built accounts.
//
// Usage:  node devnet-pool-b5.ts            # full mirror: 1.9 WSOL
//         node devnet-pool-b5.ts --sol 1.4  # seed a different depth
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount, mintTo,
} from "@solana/spl-token";
import { Raydium, TickUtil, PoolUtils, TxVersion, fetchMultipleMintInfos, clmmComputeInfoToApiInfo } from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import BN from "bn.js";
import { CLMM_PROGRAM_ID } from "./raydium-constants.ts";

// FRESH-POOL SEED PATH. The SDK's high-level clmm.getPoolInfoFromRpc crashes on a
// brand-new empty pool (no initialized tick arrays): its last line does
// `tickArrays: Object.values(computePoolTickData[poolId])` and, for an empty pool,
// computePoolTickData[poolId] is `undefined` → "Cannot convert undefined or null to
// object" (reproduced against this exact pool; dual-chip-1, already seeded, is
// unaffected — which is why the original create-clmm-pool.ts didn't hit it). We
// reproduce that method's poolInfo/poolKeys using the SAME SDK helpers it uses
// internally (getRpcClmmPoolInfos + fetchMultipleMintInfos + getComputeClmmPoolInfos
// + clmmComputeInfoToApiInfo), guarding the one undefined. The instruction itself is
// still the SDK's openPositionFromBase — no hand-rolled layout.
async function freshPoolInfoKeys(raydium: any, conn: Connection, poolId: string, mints: string[]) {
  const raw = (await raydium.clmm.getRpcClmmPoolInfos({ poolIds: [poolId] }))[poolId];
  const mintInfos = await fetchMultipleMintInfos({ connection: conn, mints: mints.map((m) => new PublicKey(m)) });
  const { computeClmmPoolInfo } = await raydium.clmm.getComputeClmmPoolInfos({ clmmPoolsRpcInfo: { [poolId]: raw }, mintInfos });
  const ci = computeClmmPoolInfo[poolId];
  const poolInfo: any = clmmComputeInfoToApiInfo(ci, mintInfos);
  poolInfo.mintAmountA = 0; poolInfo.mintAmountB = 0; // fresh pool: empty vaults
  const poolKeys: any = {
    ...ci, exBitmapAccount: ci.exBitmapAccount.toBase58(), observationId: ci.observationId.toBase58(),
    id: poolId, programId: raw.programId.toBase58(), openTime: raw.startTime.toString(),
    vault: { A: raw.vaultA.toBase58(), B: raw.vaultB.toBase58() }, config: poolInfo.config, rewardInfos: [],
  };
  return { poolInfo, poolKeys, tickCurrent: ci.tickCurrent };
}

const RPC = process.env.HOUSE_RPC ?? "https://api.devnet.solana.com";
const B5 = new PublicKey("B5tR8TzoeWoXzYWEgtCq73PFQWV4dvRfhTVVzmwWqJDw");
const AMM_CONFIG = new PublicKey("FZdkW5jiYsjTnCVqFqPrxrQisQkCYrohd7ArZhoKnM8q"); // index 2, tickSpacing 10, 0.05%
const POOL_JSON = new URL("./pool-b5.json", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// on-chain AmmConfig index 2 (identical to dual-chip-1)
const ammConfig = { id: AMM_CONFIG, index: 2, protocolFeeRate: 120000, tradeFeeRate: 500, tickSpacing: 10, fundFeeRate: 40000, fundOwner: "", description: "" };
const INITIAL_PRICE = new Decimal("0.001"); // WSOL per B5  → 1000 B5/SOL (createPool convention: mint2 per mint1)
// Position range in the pool's native price orientation (B5/SOL = mintB/mintA),
// the same convention priceToTick + devnet-liquidity.ts use — mirrors dual-chip-1's
// LIQ-1 position (600–1800 CHIP/SOL → ticks 63970–74950, bracketing the 1000 spot).
const RANGE_LOW = new Decimal("600");       // B5/SOL (position lower)
const RANGE_HIGH = new Decimal("1800");     // B5/SOL (position upper)
const TARGET_B5_PER_SOL = 1000, PRICE_TOL = 0.05; // sanity band around dual-chip-1's rate
const arg = (n: string, d: number) => { const i = process.argv.indexOf(n); return i >= 0 ? Number(process.argv[i + 1]) : d; };
const SEED_SOL = arg("--sol", 1.9);         // 1.9 WSOL = dual-chip-1's full depth (approved)
const MINT_B5 = 10_000;                      // whole B5 minted to our wallet (buffer over the seed need)

function wallet(): Keypair {
  const path = process.env.HOUSE_WALLET ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
const tok = (mint: PublicKey, decimals: number) => ({
  chainId: 103, address: mint.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(),
  logoURI: "", symbol: "", name: "", decimals, tags: [], extensions: {},
});
function save(obj: Record<string, unknown>) {
  const cur = existsSync(POOL_JSON) ? JSON.parse(readFileSync(POOL_JSON, "utf8")) : {};
  writeFileSync(POOL_JSON, JSON.stringify({ ...cur, ...obj }, null, 2));
}
/** Ensure the wallet holds ≥ `need` B5 (base units); mint the shortfall — we hold
 *  the B5 mint authority (the wallet's balance was 0; the 1e6 supply was moved out). */
async function ensureB5(conn: Connection, owner: Keypair, need: bigint) {
  const ata = getAssociatedTokenAddressSync(B5, owner.publicKey);
  let have = 0n;
  try { have = BigInt((await conn.getTokenAccountBalance(ata)).value.amount); } catch { /* no ata */ }
  if (have >= need) { console.log(`  B5 on hand: ${Number(have) / 1e9} (enough)`); return; }
  const dest = await getOrCreateAssociatedTokenAccount(conn, owner, B5, owner.publicKey);
  const amt = need - have;
  console.log(`  minting ${Number(amt) / 1e9} B5 to our wallet (had ${Number(have) / 1e9})…`);
  await mintTo(conn, owner, B5, dest.address, owner, amt);
}

async function main() {
  const owner = wallet();
  const conn = new Connection(RPC, "confirmed");
  const startBal = await conn.getBalance(owner.publicKey);
  console.log("== POOL-1: B5/WSOL pool, mirroring dual-chip-1 ==");
  console.log("payer:", owner.publicKey.toBase58(), "balance:", (startBal / 1e9).toFixed(6), "SOL");
  const raydium = await Raydium.load({ connection: conn, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });

  // 0) mint B5 to our wallet so the seed's other-side amount is covered.
  await ensureB5(conn, owner, BigInt(MINT_B5) * 10n ** 9n);

  let poolId: string | undefined = existsSync(POOL_JSON) ? JSON.parse(readFileSync(POOL_JSON, "utf8")).poolId : undefined;

  // ---- Stage A: create the pool (skip if pool-b5.json already has one) ----
  if (!poolId) {
    console.log("\n== Stage A: createPool ==");
    const { execute, extInfo } = await raydium.clmm.createPool({
      programId: CLMM_PROGRAM_ID, mint1: tok(B5, 9), mint2: tok(NATIVE_MINT, 9),
      ammConfig: ammConfig as any, initialPrice: INITIAL_PRICE, txVersion: TxVersion.V0,
    });
    const addr = extInfo.address; poolId = addr.id.toString();
    save({
      poolId, observationId: addr.observationId.toString(), ammConfig: AMM_CONFIG.toBase58(),
      mintA: addr.mintA.address, mintB: addr.mintB.address,
      vaultA: addr.mintAVault?.toString?.() ?? String((addr as any).vault?.A),
      vaultB: addr.mintBVault?.toString?.() ?? String((addr as any).vault?.B),
      exBitmapAccount: addr.exBitmapAccount?.toString?.(),
      initialPrice: INITIAL_PRICE.toString(), b5: B5.toBase58(), wsol: NATIVE_MINT.toBase58(),
    });
    console.log("mintA:", addr.mintA.address, "mintB:", addr.mintB.address);
    const { txId } = await execute({ sendAndConfirm: true });
    console.log("pool created:", poolId, "tx:", txId);
    save({ createPoolTx: txId, createPoolCostSol: (startBal - await conn.getBalance(owner.publicKey)) / 1e9 });
    await sleep(4000);
  } else console.log("pool-b5.json already has poolId", poolId, "— skipping Stage A");

  // ---- Stage B: sanity-check the mirrored price, then seed a wide position ----
  console.log("\n== Stage B: openPositionFromBase ==");
  const before = await conn.getBalance(owner.publicKey);
  const { poolInfo, poolKeys, tickCurrent: tickCur } = await freshPoolInfoKeys(raydium, conn, poolId!, [NATIVE_MINT.toBase58(), B5.toBase58()]);
  const wsolIsA = poolInfo.mintA.address === NATIVE_MINT.toBase58();
  const rawPrice = Number(poolInfo.price);              // mintB per mintA
  const b5PerSol = wsolIsA ? rawPrice : 1 / rawPrice;   // normalise to B5/SOL
  console.log(`pool price: ${b5PerSol.toFixed(4)} B5/SOL  (WSOL is mint${wsolIsA ? "A" : "B"}; raw ${rawPrice})  tickSpacing ${poolInfo.config.tickSpacing}`);
  // SANITY: refuse to seed a mispriced pool (must match dual-chip-1's 1000 B5/SOL).
  if (Math.abs(b5PerSol - TARGET_B5_PER_SOL) / TARGET_B5_PER_SOL > PRICE_TOL)
    throw new Error(`price ${b5PerSol.toFixed(2)} B5/SOL is off dual-chip-1's ${TARGET_B5_PER_SOL} by > ${PRICE_TOL * 100}% — refusing to seed a mispriced pool`);

  const dA = poolInfo.mintA.decimals, dB = poolInfo.mintB.decimals, spacing = poolInfo.config.tickSpacing;
  const t1 = TickUtil.toTickIndex(TickUtil.priceToTick(RANGE_LOW, dA, dB), spacing);
  const t2 = TickUtil.toTickIndex(TickUtil.priceToTick(RANGE_HIGH, dA, dB), spacing);
  const tickLower = Math.min(t1, t2), tickUpper = Math.max(t1, t2);
  console.log(`range ticks: ${tickLower} → ${tickUpper} | current tick ${tickCur}  ${tickCur >= tickLower && tickCur <= tickUpper ? "(IN range ✓)" : "(OUT of range ✗)"}`);
  if (tickCur < tickLower || tickCur > tickUpper) throw new Error("current price out of the position range — aborting");

  const base = wsolIsA ? "MintA" : "MintB"; // seed from the WSOL side
  const baseAmount = new BN(Math.round(SEED_SOL * 1e9));
  const otherAmountMax = new BN(MINT_B5).mul(new BN(10).pow(new BN(9)));
  console.log(`seeding ${SEED_SOL} WSOL (base=${base}), up to ${MINT_B5} B5…`);
  const { execute, extInfo } = await raydium.clmm.openPositionFromBase({
    poolInfo, poolKeys, tickLower, tickUpper, base, baseAmount, otherAmountMax,
    ownerInfo: { useSOLBalance: true }, txVersion: TxVersion.V0,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  const nft = (extInfo as any)?.nftMint?.toBase58?.() ?? "(see tx)";
  const after = await conn.getBalance(owner.publicKey);

  // ---- Verify: final price/liquidity + a dust-swap price-impact READING (no spend) ----
  // Fetch via the compute path directly (robust even if the high-level call still
  // trips on tick data); after seeding the pool has an initialized tick array.
  const rawPost = (await raydium.clmm.getRpcClmmPoolInfos({ poolIds: [poolId!] }))[poolId!];
  const miPost = await fetchMultipleMintInfos({ connection: conn, mints: [NATIVE_MINT, B5] });
  const { computeClmmPoolInfo: iPost, computePoolTickData: tickPost } = await raydium.clmm.getComputeClmmPoolInfos({ clmmPoolsRpcInfo: { [poolId!]: rawPost }, mintInfos: miPost });
  const cPost = iPost[poolId!];
  const finalPrice = Number(cPost.currentPrice);
  const finalL = cPost.liquidity.toString();
  const epochInfo = await raydium.fetchEpochInfo();
  let impactPct = NaN;
  try {
    const dust = await PoolUtils.computeAmountOut({
      poolInfo: cPost, tickArrayCache: tickPost[poolId!], baseMint: NATIVE_MINT,
      amountIn: new BN(2_000_000), slippage: 0.05, epochInfo,
      tickarrayBitmapExtension: (cPost as any).exBitmapInfo,
    });
    // priceImpact is a Raydium Percent — toSignificant() already yields the value in
    // PERCENT units (e.g. "0.0535" ⇒ 0.0535%), so it is NOT multiplied by 100. A raw
    // number would be a fraction; scale that one.
    const impact = (dust as any).priceImpact;
    impactPct = impact != null && typeof impact.toSignificant === "function" ? Number(impact.toSignificant(6))
      : typeof impact === "number" ? impact * 100 : Number(String(impact));
  } catch (e) { console.log("  (dust-impact quote skipped:", (e as Error).message, ")"); }

  save({
    seedTx: txId, seedCostSol: (before - after) / 1e9, positionNft: nft,
    tickLower, tickUpper, seedSol: SEED_SOL, liquidityAfter: finalL,
    priceB5PerSol: b5PerSol, dustImpactPct: impactPct, totalSpendSol: (startBal - after) / 1e9,
  });

  console.log("\n== RESULT ==");
  console.log("  pool address     :", poolId);
  console.log("  position NFT     :", nft);
  console.log("  final price      :", (wsolIsA ? finalPrice : 1 / finalPrice).toFixed(4), "B5/SOL");
  console.log("  pool liquidity L :", finalL, "(dual-chip-1 ≈ 225,996,431,177)");
  console.log("  0.002-SOL dust swap price impact:", isNaN(impactPct) ? "(n/a)" : impactPct.toFixed(4) + "%", "(dual-chip-1 after LIQ-1 ≈ 0.078%)");
  console.log("  SOL spent total  :", ((startBal - after) / 1e9).toFixed(6), "(WSOL paired + rent + fees; WSOL recoverable on close)");
  console.log("  wallet after     :", (after / 1e9).toFixed(6), "SOL");
  console.log(`\n  >>> PASTE THIS INTO THE WIZARD POOL-SET STEP:  ${poolId}`);
  console.log("  (pool-b5.json written; dual-chip-1's pool.json untouched)");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
