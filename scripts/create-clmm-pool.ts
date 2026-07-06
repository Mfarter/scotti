// H6a — create the demo token/WSOL Raydium CLMM pool on devnet and seed a
// concentrated position. Two stages, each persisted to pool.json so a failure
// in seeding never loses the created pool. Run: `node create-clmm-pool.ts`.
//
// Chosen market: 1 CHIP = 0.001 SOL  (i.e. 1 SOL = 1000 CHIP).
// initialPrice is "mint2 per mint1"; we pass mint1=CHIP, mint2=WSOL → 0.001.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { Raydium, TickUtil, TxVersion } from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import BN from "bn.js";
import { CLMM_PROGRAM_ID } from "./raydium-constants.ts";

const RPC = process.env.HOUSE_RPC ?? "https://api.devnet.solana.com";
const CHIP = new PublicKey("75zyWBYdFSNNFKDaTdEu9nZWdHaZCuuCd7tgCCxi2w6p");
const AMM_CONFIG = new PublicKey("FZdkW5jiYsjTnCVqFqPrxrQisQkCYrohd7ArZhoKnM8q"); // index 2, tickSpacing 10, 0.05%
const POOL_JSON = new URL("./pool.json", import.meta.url).pathname;

// on-chain AmmConfig index 2, read in _find-configs.mjs
const ammConfig = {
  id: AMM_CONFIG,
  index: 2,
  protocolFeeRate: 120000,
  tradeFeeRate: 500,
  tickSpacing: 10,
  fundFeeRate: 40000,
  fundOwner: "",
  description: "",
};

const INITIAL_PRICE = new Decimal("0.001"); // WSOL per CHIP
const RANGE_LOW = new Decimal("0.0006");     // WSOL per CHIP (position lower)
const RANGE_HIGH = new Decimal("0.0018");    // WSOL per CHIP (position upper)
const SEED_SOL = 0.3;                        // WSOL to deposit as base

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

async function main() {
  const owner = wallet();
  const connection = new Connection(RPC, "confirmed");
  const bal = await connection.getBalance(owner.publicKey);
  console.log("payer:", owner.publicKey.toBase58(), "balance:", bal / 1e9, "SOL");

  const raydium = await Raydium.load({ connection, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });

  let poolId: string | undefined = existsSync(POOL_JSON)
    ? JSON.parse(readFileSync(POOL_JSON, "utf8")).poolId : undefined;

  // ---- Stage A: create the pool (skip if pool.json already has one) ----
  if (!poolId) {
    console.log("\n== Stage A: createPool ==");
    const { execute, extInfo } = await raydium.clmm.createPool({
      programId: CLMM_PROGRAM_ID,
      mint1: tok(CHIP, 9),
      mint2: tok(NATIVE_MINT, 9),
      ammConfig: ammConfig as any,
      initialPrice: INITIAL_PRICE,
      txVersion: TxVersion.V0,
    });
    const addr = extInfo.address;
    poolId = addr.id.toString();
    save({
      poolId,
      observationId: addr.observationId.toString(),
      ammConfig: AMM_CONFIG.toBase58(),
      mintA: addr.mintA.address, mintB: addr.mintB.address,
      vaultA: addr.mintAVault?.toString?.() ?? String((addr as any).vault?.A),
      vaultB: addr.mintBVault?.toString?.() ?? String((addr as any).vault?.B),
      exBitmapAccount: addr.exBitmapAccount?.toString?.(),
      initialPrice: INITIAL_PRICE.toString(),
      chip: CHIP.toBase58(), wsol: NATIVE_MINT.toBase58(),
    });
    console.log("mintA:", addr.mintA.address, "mintB:", addr.mintB.address);
    const { txId } = await execute({ sendAndConfirm: true });
    console.log("pool created:", poolId, "tx:", txId);
    const after = await connection.getBalance(owner.publicKey);
    console.log("cost of createPool:", (bal - after) / 1e9, "SOL");
    save({ createPoolTx: txId, createPoolCostSol: (bal - after) / 1e9 });
    await new Promise((r) => setTimeout(r, 4000));
  } else {
    console.log("pool.json already has poolId", poolId, "— skipping Stage A");
  }

  // ---- Stage B: seed a concentrated position ----
  console.log("\n== Stage B: openPositionFromBase ==");
  const before = await connection.getBalance(owner.publicKey);
  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId!);
  console.log("pool current price:", poolInfo.price, "tickSpacing:", poolInfo.config.tickSpacing);

  const dA = poolInfo.mintA.decimals, dB = poolInfo.mintB.decimals;
  const lowerTick = TickUtil.toTickIndex(TickUtil.priceToTick(RANGE_LOW, dA, dB), poolInfo.config.tickSpacing);
  const upperTick = TickUtil.toTickIndex(TickUtil.priceToTick(RANGE_HIGH, dA, dB), poolInfo.config.tickSpacing);
  console.log("range ticks:", lowerTick, "→", upperTick,
    "| prices:", TickUtil.tickToPrice(lowerTick, dA, dB).toFixed(6), "→", TickUtil.tickToPrice(upperTick, dA, dB).toFixed(6));

  // base on the WSOL side. mintA/mintB determined by pubkey sort; find which is WSOL.
  const wsolIsA = poolInfo.mintA.address === NATIVE_MINT.toBase58();
  const base = wsolIsA ? "MintA" : "MintB";
  const baseAmount = new BN(Math.round(SEED_SOL * 1e9));
  const otherAmountMax = new BN(2_000_000).mul(new BN(10).pow(new BN(9))); // up to 2M CHIP

  const { execute } = await raydium.clmm.openPositionFromBase({
    poolInfo, poolKeys,
    tickLower: Math.min(lowerTick, upperTick),
    tickUpper: Math.max(lowerTick, upperTick),
    base, baseAmount, otherAmountMax,
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  const after = await connection.getBalance(owner.publicKey);
  console.log("position opened, tx:", txId, "| seed+rent cost:", (before - after) / 1e9, "SOL");
  save({
    seedTx: txId, seedCostSol: (before - after) / 1e9,
    tickLower: Math.min(lowerTick, upperTick), tickUpper: Math.max(lowerTick, upperTick),
    rangeLow: RANGE_LOW.toString(), rangeHigh: RANGE_HIGH.toString(), seedSol: SEED_SOL,
  });
  console.log("\npool.json written:", POOL_JSON);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
