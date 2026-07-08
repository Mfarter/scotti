// Dual-asset machine status — the data the dual card + page render. Mirrors the
// on-chain spin_commit_dual depth/k/tier/max-bet computation (token-side value
// depth, dual k-bounds, both max-bet constraints) and the price gate, computed
// client-side from the real pool/observation accounts.
import { Connection, PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  BP, DEEP, SHALLOW, DEEP_NUM, SHALLOW_NUM, kBoundsDual, kOfDepth, maxBet, maxMultBp,
  payoutValueLamports, PAYOUT_DENOM, pow10, realizedRtpBp, smoothedUpdate, topMultiplier,
} from "./housemath.ts";
import { decodeDualMachine, type DualMachine, dualLpPda, decodeDualLpPosition } from "./dual.ts";
import { machineIdToLabel, snapshotPayout, snapshotPrice } from "./program.ts";
import { type PriceStatus, priceStatus } from "./clmm.ts";
import { aggregate, setPriceStatus } from "./aggregator.ts";
import { poolSetPda, decodePoolSet } from "./poolset.ts";
import { pendingSol } from "./dividend.ts";

export interface DualStatus {
  machine: string; name: string;
  tokenMint: string; tokenVault: string; pool: string; observation: string;
  tokenDecimals: number;
  price: PriceStatus;
  // VAULT-1 pool set: len 0 = legacy single-pool; ≥1 = median+quorum over the set.
  poolSetLen: number; eligiblePools: number; quorum: number; perPoolPrice: PriceStatus[];
  rtpFloorBp: bigint; rtpMaxBp: bigint;      // the proven band [92, rtp_max]
  bandBp: number; twapWindowSecs: number; maxStalenessSecs: number;
  tier: string; topMult: number; isDeep: boolean | null;
  kBp: bigint | null; realizedRtpBp: bigint | null;   // nominal, value-denominated
  effectiveRtpAtSpotBp: number | null;                // nominal × spot/TWAP (Option A hedge)
  depthLamports: bigint | null; smoothedDepthLamports: bigint | null;
  valueMaxBetLamports: bigint | null; maxBetLamports: bigint | null;
  tokenBalance: bigint; reservedTokens: bigint; freeTokens: bigint; tokenValueLamports: bigint | null;
  totalShares: bigint; sharePriceTokens: number;      // token base units per share
  divPoolSol: bigint; earmarkedSol: bigint;
  paused: boolean;
  epochLength: bigint; epochNow: bigint; nextBoundarySlot: bigint; slot: bigint;
}

const DEFAULT_EPOCH = 1_350n;

export function computeDualStatus(
  pubkey: PublicKey, m: DualMachine, poolData: Buffer, obsData: Buffer, now: number, slot: bigint,
  extraMembers?: { pool: Buffer; obs: Buffer }[],
): DualStatus {
  // member 0 is m.pool/m.observation (poolData/obsData); a pool-set vault adds
  // members 1..n via extraMembers. The per-pool gate is the SAME single-pool gate;
  // the set price is the median of the eligible pools, gated by majority quorum.
  const member0 = priceStatus(poolData, obsData, now, m.twapWindowSecs, m.maxStalenessSecs, m.bandBp);
  let price: PriceStatus = member0;
  let perPoolPrice: PriceStatus[] = [member0];
  let eligiblePools = member0.commitAllowed ? 1 : 0;
  let quorum = 1;
  if (m.poolSetLen >= 1 && extraMembers) {
    perPoolPrice = [member0, ...extraMembers.map((mm) => priceStatus(mm.pool, mm.obs, now, m.twapWindowSecs, m.maxStalenessSecs, m.bandBp))];
    const v = aggregate(perPoolPrice, m.poolSetLen);
    price = setPriceStatus(v);
    eligiblePools = v.eligible;
    quorum = v.quorum;
  }
  const dec = m.tokenDecimals;
  const elen = m.epochLength === 0n ? DEFAULT_EPOCH : m.epochLength;
  const epochNow = slot / elen;
  const freeTokens = m.tokenBalance > m.reservedTokens ? m.tokenBalance - m.reservedTokens : 0n;

  const base = {
    machine: pubkey.toBase58(), name: machineIdToLabel(m.machineId) || pubkey.toBase58().slice(0, 8),
    tokenMint: m.tokenMint.toBase58(), tokenVault: m.tokenVault.toBase58(),
    pool: m.pool.toBase58(), observation: m.observation.toBase58(), tokenDecimals: dec,
    price, poolSetLen: m.poolSetLen, eligiblePools, quorum, perPoolPrice,
    rtpFloorBp: 9200n, rtpMaxBp: BigInt(m.rtpMaxBp),
    bandBp: m.bandBp, twapWindowSecs: m.twapWindowSecs, maxStalenessSecs: m.maxStalenessSecs,
    topMult: 0, tier: "—", isDeep: null as boolean | null,
    tokenBalance: m.tokenBalance, reservedTokens: m.reservedTokens, freeTokens,
    totalShares: m.totalShares, sharePriceTokens: m.totalShares === 0n ? 0 : Number(m.tokenBalance) / Number(m.totalShares),
    divPoolSol: m.divPoolSol, earmarkedSol: m.earmarkedSol, paused: m.paused,
    epochLength: elen, epochNow, nextBoundarySlot: (epochNow + 1n) * elen, slot,
  };

  if (price.kind !== "LIVE" || price.twap1e12 === null || price.twap === null || price.spot === null) {
    return {
      ...base, kBp: null, realizedRtpBp: null, effectiveRtpAtSpotBp: null,
      depthLamports: null, smoothedDepthLamports: null, valueMaxBetLamports: null, maxBetLamports: null,
      tokenValueLamports: null,
    };
  }

  const twap = price.twap1e12;
  // token-side value depth D = token_balance valued at the TWAP (lamports).
  const dNow = payoutValueLamports(m.tokenBalance, twap, dec);
  const smoothed = m.smoothedValue === 0n ? dNow : smoothedUpdate(m.smoothedValue, m.smoothedLastSlot, dNow, slot, m.smoothWindow);
  const isDeep = smoothed >= m.dMid;
  const tier = isDeep ? DEEP : SHALLOW;
  const num = isDeep ? DEEP_NUM : SHALLOW_NUM;
  const [kMin, kMax] = kBoundsDual(num, BigInt(m.rtpMaxBp));
  const k = kOfDepth(smoothed, m.dLow, m.dHigh, kMin, kMax);
  const nominalRtp = realizedRtpBp(isDeep, k);
  const effectiveRtp = Number(nominalRtp) * (price.spot / price.twap);

  const valueMaxBet = maxBet(smoothed, m.maxExposureBp, tier, k);
  // token-solvency max bet (spec §4): reserve = maxPayout·(1+haircut) ≤ min(token_cap, free).
  const capTokens = (() => {
    const tokenCap = (m.tokenBalance * m.maxExposureBp) / BP;
    return tokenCap < freeTokens ? tokenCap : freeTokens;
  })();
  const targetPayout = (capTokens * BP) / (BP + BigInt(m.haircutBp)); // max allowed max_payout tokens
  const denom = maxMultBp(tier) * k * pow10(dec) * twap;              // max_payout per lamport × 1e29
  const tokenSolvencyMaxBet = denom === 0n ? 0n : (targetPayout * PAYOUT_DENOM) / denom;
  const maxBetLamports = valueMaxBet < tokenSolvencyMaxBet ? valueMaxBet : tokenSolvencyMaxBet;

  return {
    ...base, isDeep, tier: tier.name, topMult: topMultiplier(tier),
    kBp: k, realizedRtpBp: nominalRtp, effectiveRtpAtSpotBp: effectiveRtp,
    depthLamports: dNow, smoothedDepthLamports: smoothed,
    valueMaxBetLamports: valueMaxBet, maxBetLamports,
    tokenValueLamports: payoutValueLamports(m.tokenBalance, twap, dec),
  };
}

/** Load members 1..n of a pool-set vault (member 0 is m.pool/m.observation, fetched
 *  separately). Returns undefined for a legacy single-pool vault, [] for a 1-pool set. */
export async function loadExtraMembers(conn: Connection, machine: PublicKey, m: DualMachine): Promise<{ pool: Buffer; obs: Buffer }[] | undefined> {
  if (m.poolSetLen < 1) return undefined;
  const psInfo = await conn.getAccountInfo(poolSetPda(machine));
  if (!psInfo) return undefined;
  const ps = decodePoolSet(Buffer.from(psInfo.data));
  if (ps.setLen <= 1) return [];
  const keys: PublicKey[] = [];
  for (let i = 1; i < ps.setLen; i++) { keys.push(ps.pools[i]); keys.push(ps.observations[i]); }
  const infos = await conn.getMultipleAccountsInfo(keys);
  const out: { pool: Buffer; obs: Buffer }[] = [];
  for (let i = 0; i < ps.setLen - 1; i++) {
    const p = infos[2 * i], o = infos[2 * i + 1];
    if (p && o) out.push({ pool: Buffer.from(p.data), obs: Buffer.from(o.data) });
  }
  return out;
}

/** Fetch machine + pool set + members + slot/time and compute status. */
export async function fetchDualStatus(conn: Connection, pubkey: PublicKey): Promise<DualStatus> {
  const mInfo = await conn.getAccountInfo(pubkey);
  if (!mInfo) throw new Error("dual machine not found");
  const m = decodeDualMachine(Buffer.from(mInfo.data));
  const [poolInfo, obsInfo, slot, extraMembers] = await Promise.all([
    conn.getAccountInfo(m.pool), conn.getAccountInfo(m.observation), conn.getSlot("confirmed"), loadExtraMembers(conn, pubkey, m),
  ]);
  if (!poolInfo || !obsInfo) throw new Error("pool/observation account not found");
  const now = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
  return computeDualStatus(pubkey, m, Buffer.from(poolInfo.data), Buffer.from(obsInfo.data), now, BigInt(slot), extraMembers);
}

// -------------------- LP position (dual) --------------------

export interface DualLpView {
  exists: boolean;
  shares: bigint; pendingShares: bigint; pendingEpoch: bigint;
  tokenValue: bigint; pendingTokenValue: bigint;    // token base units (share of the vault)
  rewardMode: number; earmarkedSol: bigint; pendingSol: bigint;
  processableNow: boolean; epochNow: bigint; nextBoundarySlot: bigint;
}
export async function fetchDualLp(conn: Connection, machine: PublicKey, owner: PublicKey): Promise<DualLpView> {
  const empty: DualLpView = { exists: false, shares: 0n, pendingShares: 0n, pendingEpoch: 0n, tokenValue: 0n, pendingTokenValue: 0n, rewardMode: 0, earmarkedSol: 0n, pendingSol: 0n, processableNow: false, epochNow: 0n, nextBoundarySlot: 0n };
  const [posInfo, mInfo, slotN] = await Promise.all([
    conn.getAccountInfo(dualLpPda(machine, owner)), conn.getAccountInfo(machine), conn.getSlot("confirmed"),
  ]);
  if (!posInfo || !mInfo) return empty;
  const p = decodeDualLpPosition(Buffer.from(posInfo.data));
  const m = decodeDualMachine(Buffer.from(mInfo.data));
  const tv = (sh: bigint) => (m.totalShares === 0n ? 0n : (sh * m.tokenBalance) / m.totalShares); // NAV mark
  const elen = m.epochLength === 0n ? DEFAULT_EPOCH : m.epochLength;
  const epochNow = BigInt(slotN) / elen;
  const earning = p.shares + p.pendingShares;
  // Queued token withdrawals pay the CONSERVATIVE per-epoch token snapshot (SCALE-2):
  // (token_balance − reserved_tokens)/total_shares, frozen at the epoch's first crank.
  const freeTokens = m.tokenBalance > m.reservedTokens ? m.tokenBalance - m.reservedTokens : 0n;
  const tokenSnap = snapshotPrice(freeTokens, m.totalShares, m.withdrawSnapshotPrice, m.withdrawSnapshotEpoch, epochNow);
  return {
    exists: true, shares: p.shares, pendingShares: p.pendingShares, pendingEpoch: p.pendingEpoch,
    tokenValue: tv(p.shares), pendingTokenValue: snapshotPayout(p.pendingShares, tokenSnap),
    rewardMode: p.rewardMode, earmarkedSol: p.earmarkedSol,
    pendingSol: pendingSol(earning, p.solDebt, m.accSolPerShare),
    processableNow: p.pendingShares > 0n && epochNow > p.pendingEpoch, epochNow, nextBoundarySlot: (epochNow + 1n) * elen,
  };
}
