// H6a — seed the CLMM pool with a concentrated position. Built after the raw
// finding that base-mode openPositionFromBase consumes only pool ids/mints/
// tickSpacing/vaults (the on-chain program derives liquidity from the base
// amount), so getPoolInfoFromRpc — which fails on a fresh pool with no tick
// arrays — is unnecessary. poolInfo/poolKeys are hand-built from pool.json.
//
// Pool orientation: mintA = WSOL, mintB = CHIP → pool price = CHIP per SOL.
// Current price 1000 CHIP/SOL; we seed a range of [600, 1800] CHIP/SOL.
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import { Raydium, TickUtil, TxVersion } from "@raydium-io/raydium-sdk-v2";
import Decimal from "decimal.js";
import BN from "bn.js";
import { CLMM_PROGRAM_ID } from "./raydium-constants.ts";

const RPC = process.env.HOUSE_RPC ?? "https://api.devnet.solana.com";
const POOL_JSON = new URL("./pool.json", import.meta.url).pathname;
const P = JSON.parse(readFileSync(POOL_JSON, "utf8"));

const RANGE_LOW = new Decimal("600");   // CHIP per SOL (lower)
const RANGE_HIGH = new Decimal("1800"); // CHIP per SOL (upper)
const SEED_SOL = 0.3;

function wallet(): Keypair {
  const path = process.env.HOUSE_WALLET ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

async function main() {
  const owner = wallet();
  const connection = new Connection(RPC, "confirmed");
  const before = await connection.getBalance(owner.publicKey);
  console.log("payer balance:", before / 1e9, "SOL");

  const raydium = await Raydium.load({ connection, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });

  const dA = 9, dB = 9; // WSOL, CHIP
  const spacing = 10;
  const lowerTick = TickUtil.toTickIndex(TickUtil.priceToTick(RANGE_LOW, dA, dB), spacing);
  const upperTick = TickUtil.toTickIndex(TickUtil.priceToTick(RANGE_HIGH, dA, dB), spacing);
  console.log("range ticks:", lowerTick, "→", upperTick,
    "| prices:", TickUtil.tickToPrice(lowerTick, dA, dB).toFixed(2), "→", TickUtil.tickToPrice(upperTick, dA, dB).toFixed(2), "CHIP/SOL");

  const poolInfo: any = {
    id: P.poolId,
    programId: CLMM_PROGRAM_ID.toBase58(),
    mintA: { address: NATIVE_MINT.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals: dA },
    mintB: { address: P.chip, programId: TOKEN_PROGRAM_ID.toBase58(), decimals: dB },
    config: { id: P.ammConfig, index: 2, protocolFeeRate: 120000, tradeFeeRate: 500, tickSpacing: spacing, fundFeeRate: 40000 },
    price: 1000,
  };
  const poolKeys: any = { vault: { A: P.vaultA, B: P.vaultB } };

  const { execute } = await raydium.clmm.openPositionFromBase({
    poolInfo, poolKeys,
    tickLower: Math.min(lowerTick, upperTick),
    tickUpper: Math.max(lowerTick, upperTick),
    base: "MintA",                                  // WSOL side
    baseAmount: new BN(Math.round(SEED_SOL * 1e9)),
    otherAmountMax: new BN(2_000_000).mul(new BN(10).pow(new BN(9))), // up to 2M CHIP
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  const after = await connection.getBalance(owner.publicKey);
  console.log("position opened, tx:", txId, "| cost (seed+rent+fees):", (before - after) / 1e9, "SOL");

  writeFileSync(POOL_JSON, JSON.stringify({
    ...P, seedTx: txId, seedCostSol: (before - after) / 1e9,
    tickLower: Math.min(lowerTick, upperTick), tickUpper: Math.max(lowerTick, upperTick),
    rangeLowChipPerSol: RANGE_LOW.toString(), rangeHighChipPerSol: RANGE_HIGH.toString(), seedSol: SEED_SOL,
  }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
