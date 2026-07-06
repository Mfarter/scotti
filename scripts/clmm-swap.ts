// H6a — reusable CLMM swap over the devnet demo pool. Used by the layout proof
// and the keeper. Fetches fresh pool/tick data each call (tick arrays change as
// price moves), computes the route with slippage, and sends the swap.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { Raydium, PoolUtils, TxVersion } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { CLMM_POOL, OBSERVATION_STATE, CHIP_MINT } from "./raydium-constants.ts";

export const WSOL = NATIVE_MINT;
export const CHIP = CHIP_MINT;

export async function loadRaydium(connection: Connection, owner: Keypair) {
  return Raydium.load({ connection, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });
}

/** Swap `amountIn` (base units) of `inputMint` into the other token. Returns the tx id. */
export async function doSwap(
  raydium: any, connection: Connection, inputMint: PublicKey, amountIn: BN, slippage = 0.05,
): Promise<{ txId: string; amountOut: string; priceBefore: number }> {
  const data = await raydium.clmm.getPoolInfoFromRpc(CLMM_POOL.toBase58());
  const { poolInfo, poolKeys, computePoolInfo, tickData } = data;
  const epochInfo = await raydium.fetchEpochInfo();

  const out = await PoolUtils.computeAmountOut({
    poolInfo: computePoolInfo,
    tickArrayCache: tickData[CLMM_POOL.toBase58()],
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
    observationId: OBSERVATION_STATE,
    ownerInfo: { useSOLBalance: true },
    remainingAccounts: out.remainingAccounts,
    txVersion: TxVersion.V0,
  });
  const { txId } = await execute({ sendAndConfirm: true });
  return { txId, amountOut: out.amountOut.amount.toString(), priceBefore: Number(poolInfo.price) };
}
