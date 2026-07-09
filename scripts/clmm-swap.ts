// H6a — reusable CLMM swap over a devnet CLMM pool. Used by the layout proof,
// the keeper, and the twap demo. Fetches fresh pool/tick data each call (tick
// arrays change as price moves), computes the route with slippage, and sends it.
//
// KEEP-0: the pool is now an explicit argument. loadPool reads the pool's
// identity — both mints, both decimals, and the ObservationState address — from
// its on-chain PoolState (the pinned offsets in layouts.ts); nothing is
// hardcoded to the CHIP demo pool. The observation is the pinned offset-201
// field of the pool itself, so it can never disagree with the pool it belongs
// to (no second argument to get out of sync).
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { Raydium, PoolUtils, TxVersion } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { POOL } from "./layouts.ts";
import { CLMM_POOL, CHIP_MINT } from "./raydium-constants.ts";

export const WSOL = NATIVE_MINT;
export const CHIP = CHIP_MINT;
/** The demo CHIP/WSOL pool — the default every existing invocation resolves to. */
export const DEFAULT_POOL = CLMM_POOL;

/** A pool's identity, read straight from its PoolState — no hardcoded token
 *  order, decimals, or observation account. `price` is UI mintB-per-mintA. */
export interface PoolCtx {
  id: PublicKey;
  mintA: PublicKey; mintB: PublicKey;
  decimalsA: number; decimalsB: number;
  observationId: PublicKey;
}

/** Read `poolId`'s PoolState and decode the fields the swap + keeper need. The
 *  ObservationState comes from the pinned offset-201 field, NOT a caller-supplied
 *  argument, so it always matches the pool. */
export async function loadPool(connection: Connection, poolId: PublicKey): Promise<PoolCtx> {
  const ai = await connection.getAccountInfo(poolId);
  if (!ai) throw new Error(`pool ${poolId.toBase58()} not found on ${connection.rpcEndpoint}`);
  const d = ai.data;
  return {
    id: poolId,
    mintA: new PublicKey(d.subarray(POOL.mintA, POOL.mintA + 32)),
    mintB: new PublicKey(d.subarray(POOL.mintB, POOL.mintB + 32)),
    decimalsA: d[POOL.mintDecimalsA],
    decimalsB: d[POOL.mintDecimalsB],
    observationId: new PublicKey(d.subarray(POOL.observationId, POOL.observationId + 32)),
  };
}

export async function loadRaydium(connection: Connection, owner: Keypair) {
  return Raydium.load({ connection, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });
}

/** Swap `amountIn` (base units) of `inputMint` into the other token of `pool`.
 *  Returns the tx id. The swap is direction-agnostic — the SDK derives the route
 *  from `inputMint`; nothing here assumes which side is WSOL. */
export async function doSwap(
  raydium: any, connection: Connection, pool: PoolCtx, inputMint: PublicKey, amountIn: BN, slippage = 0.05,
): Promise<{ txId: string; amountOut: string; priceBefore: number }> {
  const id = pool.id.toBase58();
  const data = await raydium.clmm.getPoolInfoFromRpc(id);
  const { poolInfo, poolKeys, computePoolInfo, tickData } = data;
  const epochInfo = await raydium.fetchEpochInfo();

  const out = await PoolUtils.computeAmountOut({
    poolInfo: computePoolInfo,
    tickArrayCache: tickData[id],
    baseMint: inputMint,
    amountIn,
    slippage,
    epochInfo,
    tickarrayBitmapExtension: (computePoolInfo as any).exBitmapInfo,
  });

  const { execute } = await raydium.clmm.swap({
    poolInfo, poolKeys,
    inputMint,
    amountIn,
    amountOutMin: out.minAmountOut.amount,
    observationId: pool.observationId,
    ownerInfo: { useSOLBalance: true },
    remainingAccounts: out.remainingAccounts,
    txVersion: TxVersion.V0,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  return { txId, amountOut: out.amountOut.amount.toString(), priceBefore: Number(poolInfo.price) };
}
