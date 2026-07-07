// DualMachine / DualPendingSpin decoders — ported VERBATIM from the pinned offsets
// in app/src/lib/dual.ts (which itself mirrors programs/house/src/lib.rs). Node's
// global Buffer; no browser polyfills. Kept byte-for-byte in sync with the app
// decoder — the offsets are the single source of truth there and here.
import { PublicKey } from "@solana/web3.js";

const u128at = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

export interface DualMachine {
  machineId: Buffer;
  tokenMint: PublicKey; pool: PublicKey; observation: PublicKey; tokenVault: PublicKey;
  tokenDecimals: number;
  dLow: bigint; dMid: bigint; dHigh: bigint; maxExposureBp: bigint; smoothWindow: bigint; epochLength: bigint;
  twapWindowSecs: number; maxStalenessSecs: number;
  bandBp: number; mBp: number; haircutBp: number; rtpMaxBp: number; maxPendingSpins: number; pendingSpins: number;
  tokenBalance: bigint; reservedTokens: bigint; escrowedSol: bigint; divPoolSol: bigint; totalShares: bigint;
  accSolPerShare: bigint; earmarkedSol: bigint; smoothedValue: bigint; smoothedLastSlot: bigint;
  paused: boolean;
  withdrawSnapshotPrice: bigint; withdrawSnapshotEpoch: bigint; // SCALE-2 (kept in sync; unused by the indexer)
}
export function decodeDualMachine(d: Buffer): DualMachine {
  return {
    machineId: Buffer.from(d.subarray(8, 24)),
    tokenMint: new PublicKey(d.subarray(56, 88)), pool: new PublicKey(d.subarray(88, 120)),
    observation: new PublicKey(d.subarray(120, 152)), tokenVault: new PublicKey(d.subarray(152, 184)),
    tokenDecimals: d[184],
    dLow: d.readBigUInt64LE(185), dMid: d.readBigUInt64LE(193), dHigh: d.readBigUInt64LE(201),
    maxExposureBp: d.readBigUInt64LE(209), smoothWindow: d.readBigUInt64LE(217), epochLength: d.readBigUInt64LE(225),
    twapWindowSecs: d.readUInt32LE(233), maxStalenessSecs: d.readUInt32LE(237),
    bandBp: d.readUInt16LE(241), mBp: d.readUInt16LE(243), haircutBp: d.readUInt16LE(245),
    rtpMaxBp: d.readUInt16LE(247), maxPendingSpins: d.readUInt16LE(249), pendingSpins: d.readUInt16LE(251),
    tokenBalance: u128at(d, 253), reservedTokens: u128at(d, 269), escrowedSol: d.readBigUInt64LE(285),
    divPoolSol: d.readBigUInt64LE(293), totalShares: u128at(d, 301), accSolPerShare: u128at(d, 317),
    earmarkedSol: d.readBigUInt64LE(333), smoothedValue: u128at(d, 341), smoothedLastSlot: d.readBigUInt64LE(357),
    paused: d[365] !== 0,
    withdrawSnapshotPrice: u128at(d, 367), withdrawSnapshotEpoch: d.readBigUInt64LE(383),
  };
}

export interface DualPendingSpin {
  machine: PublicKey; player: PublicKey; nonce: bigint; wager: bigint;
  kBp: bigint; tierIsDeep: boolean; priceAtCommit1e12: bigint; maxPayoutTokens: bigint; reservedTokens: bigint;
  randomness: PublicKey; randSeedSlot: bigint; commitSlot: bigint;
}
export function decodeDualPendingSpin(d: Buffer): DualPendingSpin {
  return {
    machine: new PublicKey(d.subarray(8, 40)), player: new PublicKey(d.subarray(40, 72)),
    nonce: d.readBigUInt64LE(72), wager: d.readBigUInt64LE(80), kBp: u128at(d, 88), tierIsDeep: d[104] !== 0,
    priceAtCommit1e12: u128at(d, 105), maxPayoutTokens: u128at(d, 121), reservedTokens: u128at(d, 137),
    randomness: new PublicKey(d.subarray(153, 185)), randSeedSlot: d.readBigUInt64LE(185), commitSlot: d.readBigUInt64LE(193),
  };
}

/** anchor account discriminator = sha256("account:<Name>")[..8]. */
import { createHash } from "node:crypto";
export function acctDisc(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/** A 16-byte machine-id buffer → its short utf8 label. */
export function machineIdToLabel(id: Uint8Array): string {
  return Buffer.from(id).toString("utf8").replace(/\0+$/, "");
}
