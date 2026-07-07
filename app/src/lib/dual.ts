// Dual-asset (DualMachine) client: decoders, PDAs, ATA helper, and raw
// instruction builders. Mirrors the dual account layouts + instruction contexts
// in programs/house/src/lib.rs and the account orders in scripts/devnet-dual-spin.ts.
// SOL wager in, SPL token (CHIP) out; the LP ledger pays SOL dividends.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import { Buffer } from "buffer";
import { PROGRAM_ID } from "./constants.ts";
import { acctDisc, ixDisc, u64, u128 } from "./program.ts";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYS = SystemProgram.programId;
const meta = (pubkey: PublicKey, isSigner: boolean, isWritable: boolean) => ({ pubkey, isSigner, isWritable });

// -------------------- PDAs + ATAs --------------------

export function dualMachineId(label: string): Buffer {
  const b = Buffer.alloc(16);
  Buffer.from(label, "utf8").copy(b, 0, 0, 16);
  return b;
}
export const dualMachinePda = (id: Buffer) => PublicKey.findProgramAddressSync([Buffer.from("dual-machine"), id], PROGRAM_ID)[0];
export const dualLpPda = (machine: PublicKey, owner: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("dual-lp"), machine.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
export const dualSpinPda = (machine: PublicKey, player: PublicKey, nonce: bigint) =>
  PublicKey.findProgramAddressSync([Buffer.from("dual-spin"), machine.toBuffer(), player.toBuffer(), u64(nonce)], PROGRAM_ID)[0];

/** Associated token account address (owner, mint) — derived, no spl-token dep. */
export const ata = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

/** create_associated_token_account_idempotent — a no-op if the ATA exists. */
export function ixCreateAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      meta(payer, true, true), meta(ata(owner, mint), false, true), meta(owner, false, false),
      meta(mint, false, false), meta(SYS, false, false), meta(TOKEN_PROGRAM_ID, false, false),
    ],
    data: Buffer.from([1]), // 1 = CreateIdempotent
  });
}

// -------------------- decoders --------------------

const u128at = (d: Buffer, o: number) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);

export interface DualMachine {
  machineId: Buffer; tokenMint: PublicKey; pool: PublicKey; observation: PublicKey; tokenVault: PublicKey;
  tokenDecimals: number;
  dLow: bigint; dMid: bigint; dHigh: bigint; maxExposureBp: bigint; smoothWindow: bigint; epochLength: bigint;
  twapWindowSecs: number; maxStalenessSecs: number;
  bandBp: number; mBp: number; haircutBp: number; rtpMaxBp: number; maxPendingSpins: number; pendingSpins: number;
  tokenBalance: bigint; reservedTokens: bigint; escrowedSol: bigint; divPoolSol: bigint; totalShares: bigint;
  accSolPerShare: bigint; earmarkedSol: bigint; smoothedValue: bigint; smoothedLastSlot: bigint;
  paused: boolean;
  withdrawSnapshotPrice: bigint; withdrawSnapshotEpoch: bigint; // SCALE-2 per-epoch token-withdrawal snapshot
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

export const REWARD_MODE_SOL = 0;
export const REWARD_MODE_SPL = 1;
export interface DualLpPosition {
  shares: bigint; pendingShares: bigint; pendingEpoch: bigint; solDebt: bigint;
  rewardMode: number; earmarkedSol: bigint; lastCompoundEpoch: bigint;
}
export function decodeDualLpPosition(d: Buffer): DualLpPosition {
  return {
    shares: u128at(d, 72), pendingShares: u128at(d, 88), pendingEpoch: d.readBigUInt64LE(104),
    solDebt: u128at(d, 112), rewardMode: d[128], earmarkedSol: d.readBigUInt64LE(129),
    lastCompoundEpoch: d.readBigUInt64LE(137),
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

// -------------------- enumeration --------------------

export interface DualEntry { pubkey: PublicKey; machine: DualMachine; }
export async function listDualMachines(conn: import("@solana/web3.js").Connection): Promise<DualEntry[]> {
  const accts = await conn.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: bs58.encode(acctDisc("DualMachine")) } }],
  });
  return accts.map((a) => ({ pubkey: a.pubkey, machine: decodeDualMachine(Buffer.from(a.account.data)) }));
}

// -------------------- instruction builders --------------------

export function ixLpDepositToken(machine: PublicKey, owner: PublicKey, ownerChip: PublicKey, vault: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(machine, false, true), meta(dualLpPda(machine, owner), false, true), meta(owner, true, true),
      meta(ownerChip, false, true), meta(vault, false, true), meta(TOKEN_PROGRAM_ID, false, false), meta(SYS, false, false),
    ],
    data: Buffer.concat([ixDisc("lp_deposit_token"), u64(amount)]),
  });
}
export function ixSpinCommitDual(machine: PublicKey, player: PublicKey, randomness: PublicKey, pool: PublicKey, obs: PublicKey, wager: bigint, nonce: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(machine, false, true), meta(dualSpinPda(machine, player, nonce), false, true), meta(player, true, true),
      meta(randomness, false, false), meta(pool, false, false), meta(obs, false, false), meta(SYS, false, false),
    ],
    data: Buffer.concat([ixDisc("spin_commit_dual"), u64(wager), u64(nonce)]),
  });
}
export function ixSpinSettleDual(machine: PublicKey, player: PublicKey, randomness: PublicKey, vault: PublicKey, playerChip: PublicKey, cranker: PublicKey, nonce: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(machine, false, true), meta(dualSpinPda(machine, player, nonce), false, true), meta(player, false, true),
      meta(randomness, false, false), meta(vault, false, true), meta(playerChip, false, true),
      meta(TOKEN_PROGRAM_ID, false, false), meta(cranker, true, true), meta(SYS, false, false),
    ],
    data: Buffer.concat([ixDisc("spin_settle_dual"), u64(nonce)]),
  });
}
function claimDividendKeys(machine: PublicKey, owner: PublicKey) {
  return [meta(machine, false, true), meta(dualLpPda(machine, owner), false, true), meta(owner, true, true)];
}
export const ixClaimSol = (machine: PublicKey, owner: PublicKey) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: claimDividendKeys(machine, owner), data: ixDisc("claim_sol") });
export const ixEarmarkSol = (machine: PublicKey, owner: PublicKey) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: claimDividendKeys(machine, owner), data: ixDisc("earmark_sol") });
export const ixSetRewardMode = (machine: PublicKey, owner: PublicKey, mode: number) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: claimDividendKeys(machine, owner), data: Buffer.concat([ixDisc("set_reward_mode"), Buffer.from([mode])]) });
export const ixRequestWithdrawToken = (machine: PublicKey, owner: PublicKey, shares: bigint) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: [meta(machine, false, false), meta(dualLpPda(machine, owner), false, true), meta(owner, true, false)], data: Buffer.concat([ixDisc("request_withdraw_token"), u128(shares)]) });
export const ixCancelWithdrawToken = (machine: PublicKey, owner: PublicKey) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys: [meta(machine, false, false), meta(dualLpPda(machine, owner), false, true), meta(owner, true, false)], data: ixDisc("cancel_withdraw_token") });
export function ixProcessWithdrawalToken(machine: PublicKey, owner: PublicKey, ownerChip: PublicKey, vault: PublicKey, cranker: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      meta(machine, false, true), meta(dualLpPda(machine, owner), false, true), meta(owner, false, true),
      meta(vault, false, true), meta(ownerChip, false, true), meta(TOKEN_PROGRAM_ID, false, false),
      meta(cranker, true, true), meta(SYS, false, false),
    ],
    data: ixDisc("process_withdrawal_token"),
  });
}
