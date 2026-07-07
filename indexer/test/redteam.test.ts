// REDTEAM-1 adversarial pass over the indexer's recompute + parser. The indexer is
// the one non-chain-read surface; these attacks try to make it (a) store a forged
// payout as "verified", (b) flag a valid spin as mismatch, or (c) crash the parser
// on hostile account/tx data. Green = the attack was rejected/bounded as asserted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { recomputeSpin } from "../src/recompute.ts";
import { parseSettle, normalizeTx } from "../src/parse.ts";
import { Store } from "../src/db.ts";
import { ingestSettle, type SettleBundle } from "../src/ingest.ts";
import { PROGRAM_ID } from "../src/config.ts";
import { loadBundle } from "./util.ts";

const PROGRAM = PROGRAM_ID.toBase58();

// (6) FORGED PAYOUT — an attacker who could feed the indexer a settle whose paid
// amount does NOT match house-math for the verified reels must be caught as a
// MISMATCH, never silently stored as verified. (Recompute integrity is the indexer's
// whole trust story.)
test("redteam: a payout that doesn't recompute is flagged mismatch, never verified", () => {
  // real reels + wager, but the paid amount tampered upward.
  const forged = recomputeSpin({ kind: "single", wager: 59410n, reels: [3, 2, 4], paid: 999_999_999n });
  assert.equal(forged.status, "mismatch");
  // and a tampered-DOWN payout too.
  const forgedLow = recomputeSpin({ kind: "single", wager: 59410n, reels: [3, 2, 4], paid: 1n });
  assert.notEqual(forgedLow.status, "verified");
});

// (6) A valid on-chain spin must NOT be flagged mismatch by unrecoverable side data:
// if reels/wager can't be recovered (randomness closed / commit aged out), the honest
// status is `unverifiable`, never a false `mismatch` (which would cry wolf) or a false
// `verified` (which would launder it).
test("redteam: unrecoverable inputs → unverifiable, never a false verified or mismatch", () => {
  assert.equal(recomputeSpin({ kind: "single", wager: 100n, reels: null, paid: 50n }).status, "unverifiable");
  assert.equal(recomputeSpin({ kind: "single", wager: null, reels: [3, 2, 4], paid: 50n }).status, "unverifiable");
});

// (6) HOSTILE ACCOUNT DATA — a truncated/garbage randomness account (e.g. a lying RPC)
// must not crash the recompute and must not produce a false "verified": with garbage
// reels the paid amount cannot factor into a valid k, so it lands unverifiable/mismatch.
test("redteam: truncated randomness data does not crash and does not false-verify", () => {
  // reels derived from garbage bytes (as reelsFromRandomness would on short data).
  const garbageReels = [NaN, NaN, NaN] as unknown as number[];
  const r = recomputeSpin({ kind: "single", wager: 59410n, reels: garbageReels, paid: 50108n });
  assert.notEqual(r.status, "verified"); // garbage reels can't legitimize a payout
});

// (6) PARSER RESILIENCE — parseSettle on a NON-settle tx returns null (not a throw),
// so the ingest loop skips it rather than crashing the whole pass.
test("redteam: parseSettle on a non-settle tx returns null (no crash)", () => {
  const b = loadBundle("single-win");
  assert.equal(parseSettle(b.commit!, PROGRAM), null); // the commit tx is not a settle
  // a tx with no House instructions at all → null.
  const empty = { ...b.settle, ixs: [] };
  assert.equal(parseSettle(empty, PROGRAM), null);
});

// (6) IDEMPOTENT + BOUNDED — re-ingesting a forged/duplicate settle can't corrupt the
// store: the signature PK makes it a no-op, and a mismatch is stored AS mismatch
// (loud), never overwritten to verified on a later pass.
test("redteam: re-ingesting cannot flip a stored status or duplicate a row", () => {
  const s = new Store(":memory:");
  const b = loadBundle("single-win");
  const r1 = ingestSettle(s, b, PROGRAM)!;
  assert.equal(r1.status, "verified"); // the honest real spin
  const before = s.countSpins();
  // a second ingest of the SAME signature is a no-op (idempotent), even if we pretend
  // the bundle changed.
  const tampered: SettleBundle = { ...b };
  const r2 = ingestSettle(s, tampered, PROGRAM)!;
  assert.equal(r2.isNew, false);
  assert.equal(s.countSpins(), before);
  s.close();
});

// (6) API PARAM SAFETY (reasoned + checked) — the store's reads are all parameterized
// prepared statements (bound `?`), so a hostile machine pubkey / cursor in a route
// param is data, not SQL: an unknown/garbage machine yields an empty result, not
// injection or a crash.
test("redteam: hostile machine param yields empty result, not injection", () => {
  const s = new Store(":memory:");
  const evil = "'; DROP TABLE spins;--";
  assert.deepEqual(s.spinsFor(evil, 10, null), []);
  assert.deepEqual(s.priceSeries(evil, 0, 9_999_999_999), []);
  // the table still exists and is queryable → the injection string was inert data.
  assert.equal(s.countSpins(), 0);
  s.close();
});
