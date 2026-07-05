// The data contract the UI renders — mirrors machineStatus/lpStatus in
// scripts/common.ts, computed at the current slot.
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  DEEP, SHALLOW, kBoundsConst, kOfDepth, maxBet, realizedRtpBp, smoothedUpdate, topMultiplier,
} from "./housemath.ts";
import { decodeLpPosition, decodeMachine, epochLengthEff, lpPda, Machine, machineIdToLabel } from "./program.ts";

export interface MachineStatus {
  machine: string;
  name: string;
  poolValue: bigint; reservedExposure: bigint; freeLiquidity: bigint;
  smoothedDepth: bigint;
  isDeep: boolean; tier: string; topMult: number;
  kBp: bigint; realizedRtpBp: bigint; maxBet: bigint;
  totalShares: bigint; sharePrice1e12: bigint;
  paused: boolean;
  epochLength: bigint; epochNow: bigint; nextBoundarySlot: bigint;
  dLow: bigint; dMid: bigint; dHigh: bigint; maxExposureBp: bigint;
  slot: bigint;
}

export function computeMachineStatus(machine: PublicKey, m: Machine, slot: bigint): MachineStatus {
  const smoothed = smoothedUpdate(m.smoothedValue, m.smoothedLastSlot, m.poolValue, slot, m.smoothWindow);
  const isDeep = smoothed >= m.dMid;
  const tier = isDeep ? DEEP : SHALLOW;
  const [kMin, kMax] = kBoundsConst(isDeep);
  const k = kOfDepth(smoothed, m.dLow, m.dHigh, kMin, kMax);
  const elen = epochLengthEff(m);
  const epochNow = slot / elen;
  return {
    machine: machine.toBase58(),
    name: machineIdToLabel(m.machineId) || machine.toBase58().slice(0, 8),
    poolValue: m.poolValue, reservedExposure: m.reservedExposure,
    freeLiquidity: m.poolValue > m.reservedExposure ? m.poolValue - m.reservedExposure : 0n,
    smoothedDepth: smoothed,
    isDeep, tier: tier.name, topMult: topMultiplier(tier),
    kBp: k, realizedRtpBp: realizedRtpBp(isDeep, k), maxBet: maxBet(smoothed, m.maxExposureBp, tier, k),
    totalShares: m.totalShares,
    sharePrice1e12: m.totalShares === 0n ? 0n : (m.poolValue * 1_000_000_000_000n) / m.totalShares,
    paused: m.paused,
    epochLength: elen, epochNow, nextBoundarySlot: (epochNow + 1n) * elen,
    dLow: m.dLow, dMid: m.dMid, dHigh: m.dHigh, maxExposureBp: m.maxExposureBp,
    slot,
  };
}

export async function machineStatus(conn: Connection, machine: PublicKey): Promise<MachineStatus> {
  const info = await conn.getAccountInfo(machine);
  if (!info) throw new Error(`machine ${machine.toBase58()} not found`);
  const slot = BigInt(await conn.getSlot("confirmed"));
  return computeMachineStatus(machine, decodeMachine(Buffer.from(info.data)), slot);
}

export interface LpStatus {
  exists: boolean;
  shares: bigint; valueLamports: bigint;
  pendingShares: bigint; pendingValueLamports: bigint; pendingEpoch: bigint;
  processableNow: boolean; epochNow: bigint; nextBoundarySlot: bigint;
}

export async function lpStatus(conn: Connection, machine: PublicKey, owner: PublicKey): Promise<LpStatus> {
  const [posInfo, machInfo, slotN] = await Promise.all([
    conn.getAccountInfo(lpPda(machine, owner)),
    conn.getAccountInfo(machine),
    conn.getSlot("confirmed"),
  ]);
  const empty: LpStatus = { exists: false, shares: 0n, valueLamports: 0n, pendingShares: 0n, pendingValueLamports: 0n, pendingEpoch: 0n, processableNow: false, epochNow: 0n, nextBoundarySlot: 0n };
  if (!posInfo || !machInfo) return empty;
  const p = decodeLpPosition(Buffer.from(posInfo.data));
  const m = decodeMachine(Buffer.from(machInfo.data));
  const price = (sh: bigint) => (m.totalShares === 0n ? 0n : (sh * m.poolValue) / m.totalShares);
  const elen = epochLengthEff(m);
  const epochNow = BigInt(slotN) / elen;
  return {
    exists: true,
    shares: p.shares, valueLamports: price(p.shares),
    pendingShares: p.pendingShares, pendingValueLamports: price(p.pendingShares), pendingEpoch: p.pendingEpoch,
    processableNow: p.pendingShares > 0n && epochNow > p.pendingEpoch,
    epochNow, nextBoundarySlot: (epochNow + 1n) * elen,
  };
}
