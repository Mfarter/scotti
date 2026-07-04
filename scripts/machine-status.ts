// Print the demo machine's live status — the exact data contract H4's frontend
// renders. Optionally an LP owner (base58) as argv[2] to also show lpStatus.
import { PublicKey } from "@solana/web3.js";
import { SOL, connection, lpStatus, machineId, machinePda, machineStatus } from "./common.ts";

const conn = connection();
const LABEL = process.env.MACHINE_LABEL ?? "house-demo-1";
const machine = machinePda(machineId(LABEL));
const sol = (x: bigint) => (Number(x) / Number(SOL)).toFixed(6);

const s = await machineStatus(conn, machine);
console.log(`machine "${LABEL}"  ${s.machine}`);
console.log(`  slot ${s.slot}  |  paused ${s.paused}`);
console.log(`  pool_value        ${s.poolValue} lamports (${sol(s.poolValue)} SOL)`);
console.log(`  smoothed depth    ${s.smoothedDepth} lamports (${sol(s.smoothedDepth)} SOL)  [curve reads this]`);
console.log(`  reserved exposure ${s.reservedExposure} lamports`);
console.log(`  free liquidity    ${s.freeLiquidity} lamports (withdrawal floor)`);
console.log(`  tier              ${s.tier}`);
console.log(`  k_bp              ${s.kBp}  (1.0x = 10000)`);
console.log(`  realized RTP      ${s.realizedRtpBp} bp (${(Number(s.realizedRtpBp) / 100).toFixed(2)}%)`);
console.log(`  max_bet           ${s.maxBet} lamports (${sol(s.maxBet)} SOL)`);
console.log(`  total_shares      ${s.totalShares}`);
console.log(`  share price       ${s.sharePrice1e12} / 1e12  (pool_value / total_shares)`);
console.log(`  epoch_length      ${s.epochLength} slots${process.env.MACHINE_LABEL ? "" : "  (0 stored → default; legacy H2 machine)"}`);
console.log(`  epoch now         ${s.epochNow}  → next boundary at slot ${s.nextBoundarySlot} (${s.nextBoundarySlot - s.slot} slots away)`);

const ownerArg = process.argv[2];
if (ownerArg) {
  const lp = await lpStatus(conn, machine, new PublicKey(ownerArg));
  console.log(`\nLP ${ownerArg}`);
  if (!lp.exists) { console.log("  (no position)"); }
  else {
    console.log(`  shares            ${lp.shares}  worth ${lp.valueLamports} lamports (${sol(lp.valueLamports)} SOL)`);
    console.log(`  pending shares    ${lp.pendingShares}  worth ${lp.pendingValueLamports} lamports`);
    console.log(`  pending epoch     ${lp.pendingEpoch}  processable now: ${lp.processableNow}`);
  }
}
