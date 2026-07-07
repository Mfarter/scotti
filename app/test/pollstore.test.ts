// Unit tests for the RPC poll store: the backoff schedule and the subscriber
// dedup / stale-not-blank behaviour. Pure TS, run with `node --test` (same as the
// indexer). No DOM: the store guards `document` so it runs under node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PollStore, backoffDelay } from "../src/lib/pollstore.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("backoffDelay: exponential schedule, capped, no jitter when rng=0.5", () => {
  const half = () => 0.5;                       // centred rng ⇒ zero jitter
  const seq = [0, 1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(a, {}, half));
  assert.deepEqual(seq, [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
});

test("backoffDelay: jitter stays within ±25% of the raw delay", () => {
  for (const a of [0, 1, 2, 3, 4]) {
    const raw = Math.min(60000, 2000 * 2 ** a);
    const lo = backoffDelay(a, {}, () => 0);    // rng=0 ⇒ -25%
    const hi = backoffDelay(a, {}, () => 1);    // rng=1 ⇒ +25%
    assert.equal(lo, Math.round(raw * 0.75), `lo @${a}`);
    assert.equal(hi, Math.round(raw * 1.25), `hi @${a}`);
  }
});

test("backoffDelay: custom base/cap honoured", () => {
  assert.equal(backoffDelay(0, { base: 500, cap: 3000 }, () => 0.5), 500);
  assert.equal(backoffDelay(10, { base: 500, cap: 3000 }, () => 0.5), 3000); // capped
});

test("PollStore: N subscribers share ONE poll (dedup)", async () => {
  let calls = 0;
  const store = new PollStore(async () => { calls++; return "X"; }, 60000);
  const u1 = store.subscribe(() => {});
  const u2 = store.subscribe(() => {});
  const u3 = store.subscribe(() => {});
  assert.equal(calls, 1, "three subscribers ⇒ one fetch");
  await tick();
  assert.equal(store.getState().data, "X");
  u1(); u2(); u3();
  await tick();
  assert.equal(calls, 1, "no extra fetch after everyone unsubscribed");
});

test("PollStore: failure keeps last-good data and marks it stale (never blanks)", async () => {
  let mode: "ok" | "fail" = "ok";
  const store = new PollStore(async () => { if (mode === "fail") throw new Error("429"); return "DATA"; }, 60000, () => 0.5);
  const unsub = store.subscribe(() => {});
  await tick();
  const good = store.getState();
  assert.equal(good.data, "DATA");
  assert.equal(good.stale, false);
  assert.equal(good.error, null);
  const firstUpdated = good.lastUpdated;
  assert.ok(firstUpdated !== null);

  mode = "fail";
  store.refreshNow();
  await tick();
  const bad = store.getState();
  assert.equal(bad.data, "DATA", "last-good data is preserved");
  assert.equal(bad.stale, true, "marked stale");
  assert.equal(bad.error, "429");
  assert.equal(bad.lastUpdated, firstUpdated, "lastUpdated only advances on success");

  mode = "ok";
  store.refreshNow();
  await tick();
  const recovered = store.getState();
  assert.equal(recovered.stale, false, "recovers on next success");
  assert.ok(recovered.lastUpdated !== null && recovered.lastUpdated >= firstUpdated);
  unsub();
});

test("PollStore: cold failure (no data yet) surfaces error, not stale", async () => {
  const store = new PollStore(async () => { throw new Error("boom"); }, 60000, () => 0.5);
  const unsub = store.subscribe(() => {});
  await tick();
  const s = store.getState();
  assert.equal(s.data, null);
  assert.equal(s.stale, false, "no data ⇒ cold error, not stale");
  assert.equal(s.error, "boom");
  unsub();
});
