// Share-price math vs hand-computed values. The two dual series stay separate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { singleSample, dualSample, tokenValueLamports, type DualPrice } from "../src/shareprice.ts";
import type { Machine } from "../src/reuse.ts";
import type { DualMachine } from "../src/dual-decode.ts";

test("single-asset share price = pool_value / total_shares (×1e12)", () => {
  const m = { poolValue: 1_000_000_000n, totalShares: 1_000_000_000_000n } as unknown as Machine;
  const s = singleSample(m);
  // 1e9 lamports over 1e12 shares → 1e-3 lamports/share → ×1e12 = 1e9
  assert.equal(s.sharePrice1e12, 1_000_000_000n);
});

test("single-asset share price is 0 for a machine with no shares", () => {
  const m = { poolValue: 5n, totalShares: 0n } as unknown as Machine;
  assert.equal(singleSample(m).sharePrice1e12, 0n);
});

test("token value = tokens valued at the TWAP (266 CHIP @ 1000 CHIP/SOL = 0.266 SOL)", () => {
  const price1e12 = 1_000_000_000_000_000n; // 1000 CHIP/SOL ×1e12
  assert.equal(tokenValueLamports(266_000_000_000n, price1e12, 9), 266_000_000n); // 0.266 SOL
});

test("dual PRIMARY series is token-per-share, price-free", () => {
  const m = {
    tokenBalance: 266_000_000_000n, totalShares: 266_000_000_000_000n,
    divPoolSol: 1_721_161n, tokenDecimals: 9,
  } as unknown as DualMachine;
  const live: DualPrice = { kind: "LIVE", twap1e12: 1_000_000_000_000_000n, spot1e12: 1_000_000_000_000_000n, reason: "ok" };
  const s = dualSample(m, live);
  assert.equal(s.sharePriceTokens1e12, 1_000_000_000n); // 266e9 / 266e12 ×1e12
  assert.equal(s.divPoolSol, 1_721_161n);               // SECONDARY, always present
  assert.equal(s.tokenValueLamports, 266_000_000n);     // SECONDARY, priced
  assert.equal(s.priceKind, "LIVE");
});

test("dual SECONDARY price fields are null when the price is not LIVE", () => {
  const m = {
    tokenBalance: 266_000_000_000n, totalShares: 266_000_000_000_000n,
    divPoolSol: 42n, tokenDecimals: 9,
  } as unknown as DualMachine;
  const stale: DualPrice = { kind: "STALE", twap1e12: null, spot1e12: null, reason: "stale" };
  const s = dualSample(m, stale);
  assert.equal(s.sharePriceTokens1e12, 1_000_000_000n); // PRIMARY still computed
  assert.equal(s.divPoolSol, 42n);                      // dividend pool still present
  assert.equal(s.twap1e12, null);                       // priced fields withheld
  assert.equal(s.tokenValueLamports, null);
  assert.equal(s.priceKind, "STALE");
});
