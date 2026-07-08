// VAULT-1 pool sets (client): the PoolSet companion account decode + PDA, the
// permissionless create_vault instruction builder, and the client-side pool
// validation that MIRRORS the on-chain validate_pool_member (CLMM-owned, pairs
// the payout mint, pool↔observation cross-link, distinct). Tx building mirrors
// scripts/vault1-live-proof.ts EXACTLY (account order + DualParams + set_len +
// members via remaining accounts) — if this diverges, that's a stop-and-report.
import { Connection, PublicKey, SystemProgram, TransactionInstruction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { Buffer } from "buffer";
import { PROGRAM_ID } from "./constants.ts";
import { ixDisc, u64 } from "./program.ts";
import { ata, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "./dual.ts";
import { CLMM_PROGRAM_ID } from "./clmm.ts";
import type { VaultParams } from "./vaultspec.ts";

const SYS = SystemProgram.programId;
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

export const MAX_POOLS = 5;

// ---- pinned CLMM PoolState / ObservationState offsets (scripts/layouts.ts, ground-truthed) ----
export const POOL_SPAN = 1544;
const POOL_MINT_A = 73, POOL_MINT_B = 105, POOL_OBSERVATION_ID = 201;
export const OBS_SPAN = 4483;
const OBS_POOL_ID = 19;

// -------------------- PoolSet PDA + decode --------------------

export const poolSetPda = (machine: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("pool-set"), machine.toBuffer()], PROGRAM_ID)[0];

export interface PoolSet { machine: PublicKey; setLen: number; pools: PublicKey[]; observations: PublicKey[]; }

/** Fetch + decode the companion PoolSet, or null for a legacy single-pool vault. */
export async function fetchPoolSet(conn: Connection, machine: PublicKey): Promise<PoolSet | null> {
  const info = await conn.getAccountInfo(poolSetPda(machine));
  return info ? decodePoolSet(Buffer.from(info.data)) : null;
}

/** The accounts spin_commit_dual's read_price_aggregated expects in remaining_accounts
 *  for a pool-set vault: [pool_set_pda, pool_1, obs_1, …] (member 0 is the named
 *  price accounts). Empty for a legacy single-pool vault. */
export function spinRemaining(machine: PublicKey, ps: PoolSet | null): PublicKey[] {
  if (!ps || ps.setLen < 1) return [];
  const out: PublicKey[] = [poolSetPda(machine)];
  for (let i = 1; i < ps.setLen; i++) { out.push(ps.pools[i]); out.push(ps.observations[i]); }
  return out;
}
/** PoolSet: disc(8) machine(32) set_len(1) pools[5](160) observations[5](160) bump reserved(32). */
export function decodePoolSet(d: Buffer): PoolSet {
  const setLen = d[40];
  const pools: PublicKey[] = [], observations: PublicKey[] = [];
  for (let i = 0; i < setLen; i++) {
    pools.push(new PublicKey(d.subarray(41 + i * 32, 41 + i * 32 + 32)));
    observations.push(new PublicKey(d.subarray(201 + i * 32, 201 + i * 32 + 32)));
  }
  return { machine: new PublicKey(d.subarray(8, 40)), setLen, pools, observations };
}

// -------------------- CLMM pool parsing (for client validation) --------------------

export const poolMintA = (d: Buffer) => new PublicKey(d.subarray(POOL_MINT_A, POOL_MINT_A + 32));
export const poolMintB = (d: Buffer) => new PublicKey(d.subarray(POOL_MINT_B, POOL_MINT_B + 32));
export const poolObservationId = (d: Buffer) => new PublicKey(d.subarray(POOL_OBSERVATION_ID, POOL_OBSERVATION_ID + 32));
export const obsPoolId = (d: Buffer) => new PublicKey(d.subarray(OBS_POOL_ID, OBS_POOL_ID + 32));

export interface MemberCheck {
  ok: boolean;
  clmmOwned: boolean; pairsMint: boolean; crossLinked: boolean; distinct: boolean;
  mintA: PublicKey | null; mintB: PublicKey | null; observation: PublicKey | null;
  reasons: string[];
}

/** Mirror of programs/house::validate_pool_member (deployable branch): the pool
 *  account is CLMM-owned, one side pairs the payout mint, and pool↔observation
 *  cross-link via the pinned offsets. `distinct` is checked against the pools
 *  already added. Owner is passed in (the caller reads it from getAccountInfo). */
export function checkPoolMember(
  poolKey: PublicKey, poolOwner: PublicKey | null, poolData: Buffer | null,
  obsKey: PublicKey, obsOwner: PublicKey | null, obsData: Buffer | null,
  tokenMint: PublicKey, alreadyAdded: PublicKey[],
): MemberCheck {
  const reasons: string[] = [];
  const clmmOwned = poolOwner !== null && poolOwner.equals(CLMM_PROGRAM_ID) && obsOwner !== null && obsOwner.equals(CLMM_PROGRAM_ID);
  if (!clmmOwned) reasons.push("pool/observation must be owned by the Raydium CLMM program");
  const spanOk = poolData !== null && poolData.length >= POOL_SPAN && obsData !== null && obsData.length >= OBS_SPAN;
  let mintA: PublicKey | null = null, mintB: PublicKey | null = null, observation: PublicKey | null = null;
  let pairsMint = false, crossLinked = false;
  if (spanOk) {
    mintA = poolMintA(poolData!); mintB = poolMintB(poolData!); observation = poolObservationId(poolData!);
    pairsMint = mintA.equals(tokenMint) || mintB.equals(tokenMint);
    if (!pairsMint) reasons.push("pool does not pair the payout mint (one side must equal it)");
    crossLinked = poolObservationId(poolData!).equals(obsKey) && obsPoolId(obsData!).equals(poolKey);
    if (!crossLinked) reasons.push("pool ↔ observation cross-link mismatch");
  } else if (clmmOwned) {
    reasons.push("pool/observation account too small to parse");
  }
  const distinct = !alreadyAdded.some((k) => k.equals(poolKey));
  if (!distinct) reasons.push("this pool is already in the set (must be distinct)");
  return { ok: clmmOwned && spanOk && pairsMint && crossLinked && distinct, clmmOwned, pairsMint, crossLinked, distinct, mintA, mintB, observation, reasons };
}

// -------------------- create_vault instruction --------------------

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };

/** DualParams borsh (create_vault ignores pool/observation — set to member 0). */
export function encodeDualParams(p: VaultParams, member0Pool: PublicKey, member0Obs: PublicKey): Buffer {
  return Buffer.concat([
    member0Pool.toBuffer(), member0Obs.toBuffer(), Buffer.from([p.tokenDecimals]),
    u64(p.dLow), u64(p.dMid), u64(p.dHigh), u64(BigInt(p.maxExposureBp)), u64(p.smoothWindow), u64(p.epochLength),
    u32(p.twapWindowSecs), u32(p.maxStalenessSecs),
    u16(p.bandBp), u16(p.mBp), u16(p.haircutBp), u16(p.rtpMaxBp), u16(p.maxPendingSpins),
  ]);
}

/** machine_id from a short label (utf8, right-padded/truncated to 16 bytes). */
export function vaultMachineId(label: string): Buffer {
  const b = Buffer.alloc(16);
  Buffer.from(label, "utf8").copy(b, 0, 0, 16);
  return b;
}
export const vaultMachinePda = (id: Buffer) => PublicKey.findProgramAddressSync([Buffer.from("dual-machine"), id], PROGRAM_ID)[0];

/** create_vault — permissionless. Accounts + remaining members mirror
 *  scripts/vault1-live-proof.ts exactly. `members` = the (pool, observation) set. */
export function ixCreateVault(
  machineId: Buffer, creator: PublicKey, tokenMint: PublicKey,
  params: VaultParams, members: { pool: PublicKey; observation: PublicKey }[],
): TransactionInstruction {
  const machine = vaultMachinePda(machineId);
  const vault = ata(machine, tokenMint);
  const data = Buffer.concat([
    ixDisc("create_vault"), machineId,
    encodeDualParams(params, members[0].pool, members[0].observation),
    Buffer.from([members.length]),
  ]);
  const keys = [
    meta(machine, false, true), meta(poolSetPda(machine), false, true), meta(tokenMint, false, false), meta(vault, false, true),
    meta(creator, true, true), meta(TOKEN_PROGRAM_ID, false, false), meta(ASSOCIATED_TOKEN_PROGRAM_ID, false, false),
    meta(SYS, false, false), meta(SYSVAR_RENT_PUBKEY, false, false),
  ];
  for (const m of members) { keys.push(meta(m.pool, false, false)); keys.push(meta(m.observation, false, false)); }
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}
