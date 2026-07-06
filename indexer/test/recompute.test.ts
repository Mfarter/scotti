// Recompute + ingest + idempotency tests, against captured real spins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.ts";
import { ingestSettle } from "../src/ingest.ts";
import { recomputeSpin } from "../src/recompute.ts";
import { PROGRAM_ID } from "../src/config.ts";
import { loadBundle } from "./util.ts";

const PROGRAM = PROGRAM_ID.toBase58();
const mem = () => new Store(":memory:");

test("single-asset winning spin → verified, exact recompute == paid", () => {
  const s = mem();
  const r = ingestSettle(s, loadBundle("single-win"), PROGRAM)!;
  assert.equal(r.status, "verified");
  const row = s.spinsFor("9Ns1oYdSyqxYMfiRVSoTRLtuEGg6GdkSGkhCWapXsfi1", 10, null).find((x) => x.payout === "50108");
  assert.ok(row);
  assert.equal(row!.reels, "BAR|BELL|CHERRY");
  s.close();
});

test("single-asset losing spin (0 paid) → verified", () => {
  const s = mem();
  assert.equal(ingestSettle(s, loadBundle("single-loss"), PROGRAM)!.status, "verified");
  s.close();
});

test("single-asset jackpot line → verified", () => {
  const s = mem();
  assert.equal(ingestSettle(s, loadBundle("single-jackpot"), PROGRAM)!.status, "verified");
  s.close();
});

test("dual-asset spin with price still in the ring → verified", () => {
  const s = mem();
  const r = ingestSettle(s, loadBundle("dual-win"), PROGRAM)!;
  assert.equal(r.status, "verified"); // H6c-2 UI spin, ring captured with the fixture
  s.close();
});

test("dual-asset spin aged out of the ring → partial (honest, not verified)", () => {
  const s = mem();
  const r = ingestSettle(s, loadBundle("dual-aged"), PROGRAM)!;
  assert.equal(r.status, "partial");
  // reels + payout still recovered from chain
  const row = s.spinsFor("6vyARZoi4Kc81ZLHYxYDhE4JGH5Db4zf1u8xvLJEvYzL", 20, null).find((x) => x.payout === "803805307");
  assert.ok(row);
  s.close();
});

test("ingest is idempotent — re-ingesting the same settle adds no rows", () => {
  const s = mem();
  const names = ["single-win", "single-loss", "single-jackpot", "dual-win", "dual-aged"];
  for (const n of names) ingestSettle(s, loadBundle(n), PROGRAM);
  const first = s.countSpins();
  for (const n of names) {
    const r = ingestSettle(s, loadBundle(n), PROGRAM)!;
    assert.equal(r.isNew, false); // second pass writes nothing
  }
  assert.equal(s.countSpins(), first);
  assert.equal(first, names.length);
  s.close();
});

test("unrecoverable inputs are stored honestly, never as verified", () => {
  // randomness closed → reels unrecoverable
  assert.equal(recomputeSpin({ kind: "single", wager: 100n, reels: null, paid: 50n }).status, "unverifiable");
  // commit aged out → wager unknown
  assert.equal(recomputeSpin({ kind: "single", wager: null, reels: [3, 2, 4], paid: 50n }).status, "unverifiable");
});

test("a tampered payout is caught as a MISMATCH, not verified", () => {
  const b = loadBundle("single-win");
  // real: wager 59410, reels BAR|BELL|CHERRY (one cherry), paid 50108. Corrupt the paid.
  const r = recomputeSpin({ kind: "single", wager: 59410n, reels: [3, 2, 4], paid: 999999n });
  assert.equal(r.status, "mismatch");
});
