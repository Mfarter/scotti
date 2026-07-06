// H6a LAYOUT GROUND-TRUTH — pinned byte offsets for the devnet Raydium CLMM
// PoolState and ObservationState, VERIFIED against the live accounts by:
//   (1) cross-checking structural invariants (pool.observationId == observation
//       account; observation.poolId == pool account; tickSpacing == 10; the
//       sqrt_price at [253] agrees with the tick at [269] via 1.0001^tick), and
//   (2) executing known swaps and watching tickCurrent / sqrtPriceX64 / the
//       observation ring move consistently (see prove-layouts-with-swaps.ts).
//
// Reconciliation with the "published" structs — see verify-layouts.ts header and
// the H6a report. The offsets below are pinned so verify-layouts.ts fails loudly
// if Raydium upgrades the program and shifts a field.
//
// Endianness: all integers little-endian (Solana/borsh). i32/i64 are two's
// complement; tick and tickCumulative can be negative.

// ---- PoolState (account discriminator + fields), total span 1544 ----
export const POOL = {
  SPAN: 1544,
  bump: 8,
  configId: 9,
  creator: 41,
  mintA: 73,
  mintB: 105,
  vaultA: 137,
  vaultB: 169,
  observationId: 201,
  mintDecimalsA: 233,
  mintDecimalsB: 234,
  tickSpacing: 235, // u16
  liquidity: 237, // u128
  sqrtPriceX64: 253, // u128, Q64.64
  tickCurrent: 269, // i32
} as const;

// ---- ObservationState, total span 4483 ----
export const OBS = {
  SPAN: 4483,
  initialized: 8, // bool (1)
  recentEpoch: 9, // u64
  observationIndex: 17, // u16  <-- the field the practitioner warning flags
  poolId: 19, // pubkey
  observations: 51, // start of the [100] ring
  ITEM_STRIDE: 44,
  ITEM_blockTimestamp: 0, // u32, relative to item start
  ITEM_tickCumulative: 4, // i64, relative to item start
  ITEM_padding: 12, // 32 bytes — NO sqrt/secondsPerLiquidity: cumulative tick ONLY
  COUNT: 100,
} as const;

export function readU16LE(b: Buffer, o: number): number { return b.readUInt16LE(o); }
export function readI32LE(b: Buffer, o: number): number { return b.readInt32LE(o); }
export function readU32LE(b: Buffer, o: number): number { return b.readUInt32LE(o); }
export function readU64LE(b: Buffer, o: number): bigint { return b.readBigUInt64LE(o); }
export function readI64LE(b: Buffer, o: number): bigint { return b.readBigInt64LE(o); }
export function readU128LE(b: Buffer, o: number): bigint {
  const lo = b.readBigUInt64LE(o), hi = b.readBigUInt64LE(o + 8);
  return lo + (hi << 64n);
}
export function readPubkey(b: Buffer, o: number): Buffer { return b.subarray(o, o + 32); }

/** Q64.64 sqrt price → float price (mintB per mintA; equal decimals here). */
export function sqrtPriceX64ToPrice(sqrtX64: bigint, decA = 9, decB = 9): number {
  const num = Number(sqrtX64) / 2 ** 64;
  const raw = num * num; // price = (sqrtPrice)^2 in raw token units
  return raw * 10 ** (decA - decB);
}

export interface PoolView {
  observationId: string; mintA: Buffer; mintB: Buffer;
  tickSpacing: number; liquidity: bigint; sqrtPriceX64: bigint; tickCurrent: number; price: number;
}
export function decodePool(b: Buffer): PoolView {
  const sqrtPriceX64 = readU128LE(b, POOL.sqrtPriceX64);
  return {
    observationId: base58(readPubkey(b, POOL.observationId)),
    mintA: readPubkey(b, POOL.mintA),
    mintB: readPubkey(b, POOL.mintB),
    tickSpacing: readU16LE(b, POOL.tickSpacing),
    liquidity: readU128LE(b, POOL.liquidity),
    sqrtPriceX64,
    tickCurrent: readI32LE(b, POOL.tickCurrent),
    price: sqrtPriceX64ToPrice(sqrtPriceX64),
  };
}

export interface ObsItem { slot: number; blockTimestamp: number; tickCumulative: bigint; }
export function decodeObsItem(b: Buffer, slot: number): ObsItem {
  const off = OBS.observations + slot * OBS.ITEM_STRIDE;
  return {
    slot,
    blockTimestamp: readU32LE(b, off + OBS.ITEM_blockTimestamp),
    tickCumulative: readI64LE(b, off + OBS.ITEM_tickCumulative),
  };
}
export function decodeObs(b: Buffer) {
  const observationIndex = readU16LE(b, OBS.observationIndex);
  return {
    initialized: b[OBS.initialized] === 1,
    recentEpoch: readU64LE(b, OBS.recentEpoch),
    observationIndex,
    poolId: base58(readPubkey(b, OBS.poolId)),
    current: decodeObsItem(b, observationIndex),
    at: (i: number) => decodeObsItem(b, ((i % OBS.COUNT) + OBS.COUNT) % OBS.COUNT),
  };
}

// minimal base58 (no external dep) for pubkey comparison/printing
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(buf: Buffer): string {
  let x = 0n;
  for (const byte of buf) x = x * 256n + BigInt(byte);
  let out = "";
  while (x > 0n) { out = ALPHABET[Number(x % 58n)] + out; x /= 58n; }
  for (const byte of buf) { if (byte === 0) out = "1" + out; else break; }
  return out;
}
