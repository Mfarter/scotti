// Shared helpers for the House Module devnet scripts. Run with Node's native TS
// support (`node init-config.ts`) — no build step. Minimal deps: @solana/web3.js
// (raw client, no anchor TS) + node stdlib. The house-math port below mirrors
// crates/house-math exactly; verify-spin.ts checks it against on-chain payouts.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ");
export const RPC = process.env.HOUSE_RPC ?? "https://api.devnet.solana.com";
export const SOL = 1_000_000_000n;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function connection(): Connection {
  return new Connection(RPC, "confirmed");
}
export function loadWallet(): Keypair {
  const path = process.env.HOUSE_WALLET ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}
export function solscanTx(sig: string): string {
  return `https://solscan.io/tx/${sig}?cluster=devnet`;
}
export function solscanAcct(a: PublicKey | string): string {
  return `https://solscan.io/account/${a.toString()}?cluster=devnet`;
}

export async function retry<T>(fn: () => Promise<T>, label: string, tries = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.warn(`  ${label}: attempt ${i + 1}/${tries} — ${(e as Error).message}`);
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}

/** Send a list of instructions in one tx, paced + confirmed. signers[0] pays. */
export async function sendTx(
  conn: Connection,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  label = "tx",
): Promise<string> {
  await sleep(600); // space ops to dodge the public RPC's 429 bursts
  return retry(async () => {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = blockhash;
    tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const st = (await conn.getSignatureStatus(sig)).value;
      if (st?.err) throw new Error(`tx failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    }
    throw new Error("confirmation timed out");
  }, label);
}

export function cuPrice(microLamports = 50_000): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
}

// -------------------- anchor encoding (raw) --------------------

/** anchor instruction discriminator = sha256("global:<name>")[..8]. */
export function ixDisc(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
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

export function configPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("house-config")], PROGRAM_ID)[0];
}
export function machinePda(id: Buffer): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("machine"), id], PROGRAM_ID)[0];
}
export function lpPda(machine: PublicKey, owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("lp"), machine.toBuffer(), owner.toBuffer()], PROGRAM_ID)[0];
}
export function spinPda(machine: PublicKey, player: PublicKey, nonce: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("spin"), machine.toBuffer(), player.toBuffer(), u64(nonce)],
    PROGRAM_ID,
  )[0];
}
/** A 16-byte machine id from a short label (utf8, right-padded/truncated). */
export function machineId(label: string): Buffer {
  const b = Buffer.alloc(16);
  Buffer.from(label, "utf8").copy(b, 0, 0, 16);
  return b;
}

// -------------------- account decoders --------------------

export interface Machine {
  machineId: Buffer;
  curator: PublicKey;
  dLow: bigint; dMid: bigint; dHigh: bigint;
  maxExposureBp: bigint; smoothWindow: bigint;
  poolValue: bigint; reservedExposure: bigint; totalShares: bigint;
  smoothedValue: bigint; smoothedLastSlot: bigint;
  paused: boolean;
}
export function decodeMachine(data: Buffer): Machine {
  let o = 8; // discriminator
  const rd8 = () => { const v = data.subarray(o, o + 8); o += 8; return v; };
  const rdU64 = () => Buffer.from(rd8()).readBigUInt64LE();
  const rdU128 = () => { const lo = Buffer.from(data.subarray(o, o + 8)).readBigUInt64LE(); const hi = Buffer.from(data.subarray(o + 8, o + 16)).readBigUInt64LE(); o += 16; return (hi << 64n) | lo; };
  const machineId = Buffer.from(data.subarray(o, o + 16)); o += 16;
  const curator = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const dLow = rdU64(), dMid = rdU64(), dHigh = rdU64(), maxExposureBp = rdU64(), smoothWindow = rdU64();
  const poolValue = rdU64(), reservedExposure = rdU64(), totalShares = rdU128();
  const smoothedValue = rdU128(), smoothedLastSlot = rdU64();
  const paused = data[o] !== 0;
  return { machineId, curator, dLow, dMid, dHigh, maxExposureBp, smoothWindow, poolValue, reservedExposure, totalShares, smoothedValue, smoothedLastSlot, paused };
}

export interface PendingSpin {
  machine: PublicKey; player: PublicKey;
  nonce: bigint; wager: bigint;
  kBp: bigint; tierIsDeep: boolean; maxPayout: bigint;
  randomness: PublicKey; randSeedSlot: bigint; commitSlot: bigint;
}
export function decodePendingSpin(data: Buffer): PendingSpin {
  let o = 8;
  const machine = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const player = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const nonce = Buffer.from(data.subarray(o, o + 8)).readBigUInt64LE(); o += 8;
  const wager = Buffer.from(data.subarray(o, o + 8)).readBigUInt64LE(); o += 8;
  const lo = Buffer.from(data.subarray(o, o + 8)).readBigUInt64LE(); const hi = Buffer.from(data.subarray(o + 8, o + 16)).readBigUInt64LE(); o += 16;
  const kBp = (hi << 64n) | lo;
  const tierIsDeep = data[o] !== 0; o += 1;
  const maxPayout = Buffer.from(data.subarray(o, o + 8)).readBigUInt64LE(); o += 8;
  const randomness = new PublicKey(data.subarray(o, o + 32)); o += 32;
  const randSeedSlot = Buffer.from(data.subarray(o, o + 8)).readBigUInt64LE(); o += 8;
  const commitSlot = Buffer.from(data.subarray(o, o + 8)).readBigUInt64LE(); o += 8;
  return { machine, player, nonce, wager, kBp, tierIsDeep, maxPayout, randomness, randSeedSlot, commitSlot };
}

// ============================================================================
// house-math port (BigInt, integer-exact) — mirrors crates/house-math/src/lib.rs
// ============================================================================

export const BP = 10_000n;
export const STOPS = 32n;
export const JACKPOT = 0, SEVEN = 1, BELL = 2, BAR = 3, CHERRY = 4, BLANK = 5;
export const SYMBOL_NAME = ["JACKPOT", "SEVEN", "BELL", "BAR", "CHERRY", "BLANK"];
export const STRIP: number[] = [
  JACKPOT,
  SEVEN, SEVEN,
  BELL, BELL, BELL, BELL,
  BAR, BAR, BAR, BAR, BAR, BAR,
  CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY, CHERRY,
  BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK,
];

export interface Tier {
  name: string;
  threeJackpot: bigint; threeSeven: bigint; threeBell: bigint;
  threeBar: bigint; threeCherry: bigint; twoCherry: bigint; oneCherry: bigint;
}
export const SHALLOW: Tier = { name: "shallow", threeJackpot: 500000n, threeSeven: 250000n, threeBell: 120000n, threeBar: 80000n, threeCherry: 50000n, twoCherry: 22000n, oneCherry: 8000n };
export const DEEP: Tier = { name: "deep", threeJackpot: 5000000n, threeSeven: 600000n, threeBell: 250000n, threeBar: 100000n, threeCherry: 60000n, twoCherry: 20000n, oneCherry: 7000n };
export const maxMultBp = (t: Tier) => t.threeJackpot;

export function payoutBp(t: Tier, s: number[]): bigint {
  if (s[0] === s[1] && s[1] === s[2]) {
    switch (s[0]) {
      case JACKPOT: return t.threeJackpot;
      case SEVEN: return t.threeSeven;
      case BELL: return t.threeBell;
      case BAR: return t.threeBar;
      case CHERRY: return t.threeCherry;
      default: return 0n;
    }
  }
  const c = s.filter((x) => x === CHERRY).length;
  return c === 2 ? t.twoCherry : c === 1 ? t.oneCherry : 0n;
}
export function spinPayout(wager: bigint, t: Tier, kBp: bigint, s: number[]): bigint {
  return ((wager * payoutBp(t, s)) / BP) * kBp / BP;
}
export function reelsFromRandomness(bytes: Uint8Array): number[] {
  return [STRIP[bytes[0] % 32], STRIP[bytes[1] % 32], STRIP[bytes[2] % 32]];
}

function ceilDiv(a: bigint, b: bigint): bigint { return (a + b - 1n) / b; }
export function kBoundsOfNum(num: bigint): [bigint, bigint] {
  const total = STOPS * STOPS * STOPS;
  return [ceilDiv(9200n * total * BP, num), (9700n * total * BP) / num];
}
export const SHALLOW_K = kBoundsOfNum(301_132_000n);
export const DEEP_K = kBoundsOfNum(302_901_000n);
export const kBoundsConst = (isDeep: boolean) => (isDeep ? DEEP_K : SHALLOW_K);
export function kOfDepth(depth: bigint, dLow: bigint, dHigh: bigint, kMin: bigint, kMax: bigint): bigint {
  if (depth <= dLow) return kMax;
  if (depth >= dHigh) return kMin;
  return kMax - ((kMax - kMin) * (depth - dLow)) / (dHigh - dLow);
}
export function maxBet(depth: bigint, expoBp: bigint, t: Tier, kBp: bigint): bigint {
  const eff = (maxMultBp(t) * kBp) / BP;
  if (eff === 0n) return 0n;
  return (((depth * expoBp) / BP) * BP) / eff;
}
/** SmoothedDepth.update — returns the advanced value. */
export function smoothedUpdate(value: bigint, lastSlot: bigint, depthNow: bigint, slotNow: bigint, window: bigint): bigint {
  let elapsed = slotNow > lastSlot ? slotNow - lastSlot : 0n;
  if (elapsed > window) elapsed = window;
  if (elapsed > 0n) {
    if (depthNow >= value) value += ((depthNow - value) * elapsed) / window;
    else value -= ((value - depthNow) * elapsed) / window;
  }
  return value;
}

/** Compute the snapshot the program will freeze at commit for a machine whose
 * smoothing has fully converged (smoothed == poolValue). Mirrors spin_commit. */
export function convergedSnapshot(m: Machine): { isDeep: boolean; k: bigint; tier: Tier; maxBet: bigint } {
  const depth = m.poolValue;
  const isDeep = depth >= m.dMid;
  const tier = isDeep ? DEEP : SHALLOW;
  const [kMin, kMax] = kBoundsConst(isDeep);
  const k = kOfDepth(depth, m.dLow, m.dHigh, kMin, kMax);
  return { isDeep, k, tier, maxBet: maxBet(depth, m.maxExposureBp, tier, k) };
}
