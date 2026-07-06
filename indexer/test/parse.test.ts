// Parser tests — pure functions over captured real settle txs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSettle, parseCommitWager, singlePayoutLamports, dualPayoutTokens } from "../src/parse.ts";
import { decodeDualMachine } from "../src/dual-decode.ts";
import { PROGRAM_ID } from "../src/config.ts";
import { loadBundle } from "./util.ts";

const PROGRAM = PROGRAM_ID.toBase58();

test("parseSettle classifies single-asset and extracts accounts + nonce", () => {
  const b = loadBundle("single-win");
  const p = parseSettle(b.settle, PROGRAM);
  assert.ok(p);
  assert.equal(p!.kind, "single");
  assert.equal(p!.machine, "9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1"); // house-demo-1
  assert.ok(p!.player.length >= 32);
  assert.ok(p!.nonce > 0n);
});

test("parseSettle classifies dual-asset", () => {
  const p = parseSettle(loadBundle("dual-win").settle, PROGRAM);
  assert.ok(p);
  assert.equal(p!.kind, "dual");
  assert.equal(p!.machine, "6vyARZoi4Kc81ZLHYxYDhE4JGH5Db4zf1u8xvLJEvYzL"); // dual-chip-1
});

test("single payout = Machine vault lamport decrease matches the known artifact", () => {
  const b = loadBundle("single-win");
  const p = parseSettle(b.settle, PROGRAM)!;
  assert.equal(singlePayoutLamports(b.settle, p.machine), 50108n); // README H2 artifact
});

test("single losing spin pays 0", () => {
  const b = loadBundle("single-loss");
  const p = parseSettle(b.settle, PROGRAM)!;
  assert.equal(singlePayoutLamports(b.settle, p.machine), 0n);
});

test("dual payout = player token-balance increase for the machine mint", () => {
  const b = loadBundle("dual-win");
  const p = parseSettle(b.settle, PROGRAM)!;
  const dm = decodeDualMachine(b.machineData!);
  assert.equal(dualPayoutTokens(b.settle, p.player, dm.tokenMint.toBase58()), 3826694941n); // H6c-2 UI spin
});

test("wager is read from the commit tx", () => {
  const b = loadBundle("single-win");
  assert.equal(parseCommitWager(b.commit!, PROGRAM, "single"), 59410n); // README H2 wager
});

test("a non-settle tx parses as null", () => {
  const b = loadBundle("single-win");
  assert.equal(parseSettle(b.commit!, PROGRAM), null); // the commit tx is not a settle
});
