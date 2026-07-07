// House program client: PDAs, anchor-style encoders, account decoders, and raw
// instruction builders. Ported from scripts/common.ts; ixDisc/discriminators use
// a browser sha256 (@noble/hashes) instead of node:crypto.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { Buffer } from "buffer";
import { PROGRAM_ID } from "./constants.ts";

// -------------------- anchor encoding --------------------

/** anchor instruction discriminator = sha256("global:<name>")[..8]. */
export function ixDisc(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8));
}
/** anchor account discriminator = sha256("account:<Name>")[..8]. */
export function acctDisc(name: string): Buffer {
  return Buffer.from(sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8));
}
export function u64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
export function u128(n: bigint): Buffer {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(n & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(n >> 64n, 8);
  return b;
}

// -------------------- PDAs --------------------

export const configPda = () => PublicKey.findProgramAddressSync([Buffer.from("house-config")], PROGRAM_ID)[0];
export const machinePda = (id: Buffer) => PublicKey.findProgramAddressSync([Buffer.from("machine"), id], PROGRAM_ID)[0];
export const lpPda = (machine: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("lp"), machine.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
export const spinPda = (machine: PublicKey, player: PublicKey, nonce: bigint) =>
  PublicKey.findProgramAddressSync([Buffer.from("spin"), machine.toBuffer(), player.toBuffer(), u64(nonce)], PROGRAM_ID)[0];

/** A 16-byte machine id from a short label (utf8, right-padded/truncated). */
export function machineId(label: string): Buffer {
  const b = Buffer.alloc(16);
  Buffer.from(label, "utf8").copy(b, 0, 0, 16);
  return b;
}
export function machineIdToLabel(id: Uint8Array): string {
  return Buffer.from(id).toString("utf8").replace(/\0+$/, "");
}

// -------------------- account decoders --------------------

export interface Machine {
  machineId: Buffer; curator: PublicKey;
  dLow: bigint; dMid: bigint; dHigh: bigint; maxExposureBp: bigint; smoothWindow: bigint;
  poolValue: bigint; reservedExposure: bigint; totalShares: bigint;
  smoothedValue: bigint; smoothedLastSlot: bigint;
  paused: boolean; epochLength: bigint;
  withdrawSnapshotPrice: bigint; withdrawSnapshotEpoch: bigint; // SCALE-2 per-epoch withdrawal snapshot
}
export const DEFAULT_EPOCH_LENGTH_SLOTS = 1_350n;
export function decodeMachine(data: Buffer): Machine {
  let o = 8;
  const rdU64 = () => { const v = data.readBigUInt64LE(o); o += 8; return v; };
  const rdU128 = () => { const lo = data.readBigUInt64LE(o); const hi = data.readBigUInt64LE(o + 8); o += 16; return (hi << 64n) | lo; };
  const machineIdBuf = Buffer.from(data.subarray(o, o + 16)); o += 16;
  const curator = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const dLow = rdU64(), dMid = rdU64(), dHigh = rdU64(), maxExposureBp = rdU64(), smoothWindow = rdU64();
  const poolValue = rdU64(), reservedExposure = rdU64(), totalShares = rdU128();
  const smoothedValue = rdU128(), smoothedLastSlot = rdU64();
  const paused = data[o] !== 0; o += 1;
  o += 1; // bump
  const epochLength = rdU64();
  const withdrawSnapshotPrice = rdU128(), withdrawSnapshotEpoch = rdU64();
  return { machineId: machineIdBuf, curator, dLow, dMid, dHigh, maxExposureBp, smoothWindow, poolValue, reservedExposure, totalShares, smoothedValue, smoothedLastSlot, paused, epochLength, withdrawSnapshotPrice, withdrawSnapshotEpoch };
}
export const epochLengthEff = (m: Machine) => (m.epochLength === 0n ? DEFAULT_EPOCH_LENGTH_SLOTS : m.epochLength);

// ---- SCALE-2 conservative withdrawal price snapshot (mirrors house-math `snapshot`) ----
// Queued withdrawals pay (free_value)/total_shares — the pool valued as if every
// pending spin hits its reserved maximum — frozen at the epoch's first crank.
export const SNAPSHOT_SCALE = 1_000_000_000_000_000_000n; // 1e18
export function snapshotPrice(freeValue: bigint, totalShares: bigint, snapPrice: bigint, snapEpoch: bigint, currentEpoch: bigint): bigint {
  if (snapEpoch === currentEpoch && snapPrice !== 0n) return snapPrice;
  return totalShares === 0n ? 0n : (freeValue * SNAPSHOT_SCALE) / totalShares;
}
export const snapshotPayout = (shares: bigint, snapPrice: bigint) => (shares * snapPrice) / SNAPSHOT_SCALE;

export interface LpPosition { machine: PublicKey; owner: PublicKey; shares: bigint; pendingShares: bigint; pendingEpoch: bigint; }
export function decodeLpPosition(data: Buffer): LpPosition {
  let o = 8;
  const machine = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const owner = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const rdU128 = () => { const lo = data.readBigUInt64LE(o); const hi = data.readBigUInt64LE(o + 8); o += 16; return (hi << 64n) | lo; };
  const shares = rdU128();
  const pendingShares = rdU128();
  const pendingEpoch = data.readBigUInt64LE(o); o += 8;
  return { machine, owner, shares, pendingShares, pendingEpoch };
}

export interface PendingSpin {
  machine: PublicKey; player: PublicKey; nonce: bigint; wager: bigint;
  kBp: bigint; tierIsDeep: boolean; maxPayout: bigint;
  randomness: PublicKey; randSeedSlot: bigint; commitSlot: bigint;
}
export function decodePendingSpin(data: Buffer): PendingSpin {
  let o = 8;
  const machine = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const player = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const nonce = data.readBigUInt64LE(o); o += 8;
  const wager = data.readBigUInt64LE(o); o += 8;
  const lo = data.readBigUInt64LE(o); const hi = data.readBigUInt64LE(o + 8); o += 16;
  const kBp = (hi << 64n) | lo;
  const tierIsDeep = data[o] !== 0; o += 1;
  const maxPayout = data.readBigUInt64LE(o); o += 8;
  const randomness = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const randSeedSlot = data.readBigUInt64LE(o); o += 8;
  const commitSlot = data.readBigUInt64LE(o); o += 8;
  return { machine, player, nonce, wager, kBp, tierIsDeep, maxPayout, randomness, randSeedSlot, commitSlot };
}

// -------------------- instruction builders --------------------

const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });
const SYS = SystemProgram.programId;

export function ixLpDeposit(machine: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(machine, false, true), meta(lpPda(machine, owner), false, true), meta(owner, true, true), meta(SYS, false, false)],
    data: Buffer.concat([ixDisc("lp_deposit"), u64(amount)]),
  });
}
export function ixRequestWithdraw(machine: PublicKey, owner: PublicKey, shares: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(machine, false, false), meta(lpPda(machine, owner), false, true), meta(owner, true, false)],
    data: Buffer.concat([ixDisc("request_withdraw"), u128(shares)]),
  });
}
export function ixCancelWithdraw(machine: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(machine, false, false), meta(lpPda(machine, owner), false, true), meta(owner, true, false)],
    data: ixDisc("cancel_withdraw"),
  });
}
export function ixProcessWithdrawals(machine: PublicKey, owner: PublicKey, cranker: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [meta(machine, false, true), meta(lpPda(machine, owner), false, true), meta(owner, false, true), meta(cranker, true, true), meta(SYS, false, false)],
    data: ixDisc("process_withdrawals"),
  });
}
export function ixSpinCommit(machine: PublicKey, player: PublicKey, randomness: PublicKey, wager: bigint, nonce: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(machine, false, true), meta(spinPda(machine, player, nonce), false, true),
      meta(player, true, true), meta(randomness, false, false), meta(SYS, false, false),
    ],
    data: Buffer.concat([ixDisc("spin_commit"), u64(wager), u64(nonce)]),
  });
}
export function ixSpinSettle(machine: PublicKey, player: PublicKey, randomness: PublicKey, nonce: bigint, cranker: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(machine, false, true), meta(spinPda(machine, player, nonce), false, true),
      meta(player, false, true), meta(randomness, false, false), meta(cranker, true, true), meta(SYS, false, false),
    ],
    data: Buffer.concat([ixDisc("spin_settle"), u64(nonce)]),
  });
}
