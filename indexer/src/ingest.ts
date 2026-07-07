// Ingest: (a) sample every machine's share price on an interval, (b) walk the
// program's settle history and record each spin, RECOMPUTED at ingest. The core —
// ingestSettle — is a pure function over a SettleBundle (all chain reads already
// gathered), so the tests drive it from captured fixtures with no live RPC.
import type { Connection } from "@solana/web3.js";
import { collectObservations, computeTwap, decodePool, reelsFromRandomness } from "./reuse.ts";
import { decodeDualMachine, machineIdToLabel } from "./dual-decode.ts";
import { singleSample, dualSample, dualPrice } from "./shareprice.ts";
import { recomputeSpin, type VerifyResult } from "./recompute.ts";
import {
  parseSettle, parseCommitWager, singlePayoutLamports, dualPayoutTokens, type RawTx,
} from "./parse.ts";
import type { Store } from "./db.ts";
import {
  conn, listSingleMachines, listDualMachines, accountData, programSignatures, getTx, findCommit, slotAndTime,
} from "./chain.ts";
import { PROGRAM_ID } from "./config.ts";

const S = (x: bigint | null | undefined) => (x === null || x === undefined ? null : x.toString());
const REELS = (r: number[] | null) => (r ? r.map((s) => ["JACKPOT", "SEVEN", "BELL", "BAR", "CHERRY", "BLANK"][s]).join("|") : null);
// Switchboard RandomnessAccountData: seed_slot @ 8+96, revealed value @ 8+144..176.
const randomnessValue = (data: Buffer): Uint8Array => Uint8Array.from(data.subarray(8 + 144, 8 + 176));

export interface SettleBundle {
  settleSig: string;
  settle: RawTx;
  commit: RawTx | null;
  randomnessData: Buffer | null;
  machineData: Buffer | null; // dual machine account (mint/pool/obs/decimals/gates); null for single
  poolData: Buffer | null;    // dual current pool account (for the price recompute)
  obsData: Buffer | null;     // dual current observation account
}

export interface IngestResult { sig: string; status: VerifyResult["status"]; isNew: boolean; detail: string; }

/** Recompute one settled spin from a fully-gathered bundle and store it. Pure over
 * the bundle — no RPC. Returns null if the tx isn't a settle. */
export function ingestSettle(store: Store, b: SettleBundle, program: string): IngestResult | null {
  const parsed = parseSettle(b.settle, program);
  if (!parsed) return null;
  const { kind, machine, player, nonce } = parsed;
  try {
    return recomputeAndStore(store, b, parsed, program);
  } catch (e) {
    // B2 (HARDEN-1): one spin whose recompute/decode/store throws (a lying RPC handing
    // back truncated account data, a decode edge, etc.) must NEVER abort the batch. We
    // still know the machine + kind from parseSettle, so the spin is stored `unverifiable`
    // with the error detail (attributable + idempotent on signature) and the pass goes on.
    const detail = `ingest error: ${e instanceof Error ? e.message : String(e)}`;
    const isNew = store.insertSpin({
      signature: b.settleSig, machine, kind,
      slot: b.settle.slot, block_time: b.settle.blockTime,
      player, nonce: nonce.toString(),
      wager: null, reels: null, payout: null,
      payout_kind: kind === "single" ? "lamports" : "tokens",
      commit_sig: b.commit?.signature ?? null, price_at_commit_1e12: null,
      verify_status: "unverifiable", verify_detail: detail,
    });
    return { sig: b.settleSig, status: "unverifiable", isNew, detail };
  }
}

/** The recompute + store body, split out so ingestSettle can wrap it in a per-spin
 * try/catch (B2). Pure over the bundle + parsed settle — no RPC. */
function recomputeAndStore(store: Store, b: SettleBundle, parsed: NonNullable<ReturnType<typeof parseSettle>>, program: string): IngestResult {
  const { kind, machine, player, nonce } = parsed;

  const reels = b.randomnessData ? [...reelsFromRandomness(randomnessValue(b.randomnessData))] : null;
  const wager = b.commit ? parseCommitWager(b.commit, program, kind) : null;

  let paid: bigint | null;
  let payoutKind: "lamports" | "tokens";
  let price1e12: bigint | null = null;
  let rtpMaxBp: bigint | undefined;
  let decimals: number | undefined;
  let mintForRow: string | null = null;

  if (kind === "single") {
    paid = singlePayoutLamports(b.settle, machine);
    payoutKind = "lamports";
  } else {
    payoutKind = "tokens";
    const dm = b.machineData ? decodeDualMachine(b.machineData) : null;
    decimals = dm?.tokenDecimals;
    rtpMaxBp = dm ? BigInt(dm.rtpMaxBp) : undefined;
    mintForRow = dm ? dm.tokenMint.toBase58() : null;
    paid = dm ? dualPayoutTokens(b.settle, player, dm.tokenMint.toBase58()) : null;
    // price_at_commit: recompute the TWAP from the CURRENT ring at the commit time.
    // If the ring has rolled past the commit (100-slot window), it's unrecoverable.
    if (dm && b.poolData && b.obsData && b.commit?.blockTime != null) {
      const tick = decodePool(b.poolData).tickCurrent;
      const tw = computeTwap(collectObservations(b.obsData), tick, b.commit.blockTime, dm.twapWindowSecs, dm.maxStalenessSecs);
      price1e12 = tw.price !== null ? BigInt(Math.round(tw.price * 1e12)) : null;
    }
  }

  const v = recomputeSpin({ kind, wager, reels, paid, price1e12, rtpMaxBp, decimals });

  const isNew = store.insertSpin({
    signature: b.settleSig, machine, kind,
    slot: b.settle.slot, block_time: b.settle.blockTime,
    player, nonce: nonce.toString(),
    wager: S(wager), reels: REELS(reels),
    payout: S(paid), payout_kind: payoutKind,
    commit_sig: b.commit?.signature ?? null,
    price_at_commit_1e12: S(price1e12),
    verify_status: v.status, verify_detail: v.detail,
  });
  store.upsertMachine({
    pubkey: machine, kind, label: null, token_mint: mintForRow,
    token_decimals: decimals ?? null, first_indexed_slot: b.settle.slot, first_indexed_time: b.settle.blockTime,
  });
  return { sig: b.settleSig, status: v.status, isNew, detail: v.detail };
}

/** One full ingest pass: sample prices, then walk new settles. */
export async function ingestOnce(store: Store, c: Connection): Promise<{ samples: number; spinsNew: number; mismatches: IngestResult[] }> {
  const { slot, time: blockTime } = await slotAndTime(c);

  // ---- (a) price samples ----
  let samples = 0;
  const singles = await listSingleMachines(c);
  for (const e of singles) {
    const s = singleSample(e.machine);
    store.upsertMachine({ pubkey: e.pubkey, kind: "single", label: machineIdToLabel(e.machine.machineId) || null, token_mint: null, token_decimals: null, first_indexed_slot: slot, first_indexed_time: blockTime });
    store.insertSample({
      machine: e.pubkey, slot, block_time: blockTime,
      pool_value: S(s.poolValue), total_shares: S(s.totalShares), share_price_1e12: S(s.sharePrice1e12),
      token_balance: null, share_price_tokens_1e12: null, div_pool_sol: null, twap_1e12: null, token_value_lamports: null, price_kind: null,
    });
    samples++;
  }

  const duals = await listDualMachines(c);
  const dualCtx = new Map<string, { machineData: Buffer; poolData: Buffer | null; obsData: Buffer | null }>();
  for (const e of duals) {
    const [poolData, obsData] = await Promise.all([accountData(c, e.machine.pool.toBase58()), accountData(c, e.machine.observation.toBase58())]);
    const machineData = await accountData(c, e.pubkey);
    if (machineData) dualCtx.set(e.pubkey, { machineData, poolData, obsData });
    const price = (poolData && obsData)
      ? dualPrice(poolData, obsData, blockTime, e.machine.twapWindowSecs, e.machine.maxStalenessSecs, e.machine.bandBp)
      : { kind: "STALE" as const, twap1e12: null, spot1e12: null, reason: "pool/obs unavailable" };
    const s = dualSample(e.machine, price);
    store.upsertMachine({ pubkey: e.pubkey, kind: "dual", label: machineIdToLabel(e.machine.machineId) || null, token_mint: e.machine.tokenMint.toBase58(), token_decimals: e.machine.tokenDecimals, first_indexed_slot: slot, first_indexed_time: blockTime });
    store.insertSample({
      machine: e.pubkey, slot, block_time: blockTime,
      pool_value: null, total_shares: S(s.totalShares), share_price_1e12: null,
      token_balance: S(s.tokenBalance), share_price_tokens_1e12: S(s.sharePriceTokens1e12),
      div_pool_sol: S(s.divPoolSol), twap_1e12: S(s.twap1e12), token_value_lamports: S(s.tokenValueLamports), price_kind: s.priceKind,
    });
    samples++;
  }

  // ---- (b) spin feed ----
  const program = PROGRAM_ID.toBase58();
  const watermark = Number(store.getMeta("spin_watermark_slot") ?? "0");
  const sigs = await programSignatures(c);
  let newestSlot = watermark;
  let spinsNew = 0;
  const mismatches: IngestResult[] = [];
  for (const s of sigs) {
    newestSlot = Math.max(newestSlot, s.slot);
    if (s.err || s.slot <= watermark || store.hasSpin(s.signature)) continue;
    // B2 (HARDEN-1): the ENTIRE per-spin body — the RPC fetches plus recompute+store —
    // runs inside its own try/catch so a single bad spin (an RPC that throws, a decode
    // edge) can never abort the whole pass. ingestSettle already self-catches recompute
    // throws; this outer guard also covers the RPC gathering above it. On any throw we
    // record what we can as `unverifiable` and move to the next signature.
    let known: { machine: string; kind: "single" | "dual" } | null = null;
    try {
      const settle = await getTx(c, s.signature);
      if (!settle) continue;
      const parsed = parseSettle(settle, program);
      if (!parsed) continue;
      known = { machine: parsed.machine, kind: parsed.kind };
      const commit = await findCommit(c, parsed.spin, parsed.kind, s.signature);
      const randomnessData = await accountData(c, parsed.randomness);
      let machineData: Buffer | null = null, poolData: Buffer | null = null, obsData: Buffer | null = null;
      if (parsed.kind === "dual") {
        const ctx = dualCtx.get(parsed.machine);
        if (ctx) { machineData = ctx.machineData; poolData = ctx.poolData; obsData = ctx.obsData; }
        else { machineData = await accountData(c, parsed.machine); }
      }
      const res = ingestSettle(store, { settleSig: s.signature, settle, commit, randomnessData, machineData, poolData, obsData }, program);
      if (!res) continue;
      if (res.isNew) spinsNew++;
      if (res.status === "mismatch") mismatches.push(res);
    } catch (e) {
      const detail = `ingest error: ${e instanceof Error ? e.message : String(e)}`;
      // attribute the failure if we got far enough to know the machine; otherwise just skip.
      if (known) {
        const isNew = store.insertSpin({
          signature: s.signature, machine: known.machine, kind: known.kind,
          slot: s.slot, block_time: null, player: null, nonce: null,
          wager: null, reels: null, payout: null,
          payout_kind: known.kind === "single" ? "lamports" : "tokens",
          commit_sig: null, price_at_commit_1e12: null,
          verify_status: "unverifiable", verify_detail: detail,
        });
        if (isNew) spinsNew++;
      }
    }
  }
  store.setMeta("spin_watermark_slot", String(newestSlot));
  store.setMeta("last_ingest_slot", String(slot));
  store.setMeta("last_ingest_time", String(blockTime));
  return { samples, spinsNew, mismatches };
}

export { conn };
