// H6a — keeper: a tiny alternating-direction dust-swap loop that keeps the
// pool's ObservationState fresh so the machine's TWAP read never goes stale.
// The keeper is operational convenience, NOT a trust component (spec §2.2):
// anyone's swap freshens the ring; the keeper just guarantees SOMEONE does.
//
// Alternating directions keep net price drift ≈ 0 (each buy is ~undone by the
// next sell), so freshness is bought without walking the pool away. Reports
// per-swap and extrapolated per-hour cost so the keeper can be budgeted.
//
// Usage:
//   node keeper.ts                 # run until killed, 20s pace, 0.002 SOL dust
//   node keeper.ts --interval 20 --swaps 18 --amount-sol 0.002
import { readFileSync } from "node:fs"; import { homedir } from "node:os";
import { Connection, Keypair } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { loadRaydium, doSwap } from "./clmm-swap.ts";
import { CHIP_MINT } from "./raydium-constants.ts";

const arg = (k: string, d: number) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? Number(process.argv[i + 1]) : d;
};
const INTERVAL = arg("--interval", 20) * 1000; // ms; must exceed the 15s obs window
const MAX_SWAPS = arg("--swaps", Infinity);
const AMOUNT_SOL = arg("--amount-sol", 0.002);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function wallet(): Keypair {
  const p = process.env.HOUSE_WALLET ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

async function main() {
  const owner = wallet();
  const c = new Connection(process.env.HOUSE_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const raydium = await loadRaydium(c, owner);
  const WSOL = NATIVE_MINT, CHIP = CHIP_MINT;

  const startBal = await c.getBalance(owner.publicKey);
  const startTime = Date.now();
  const solIn = new BN(Math.round(AMOUNT_SOL * 1e9));
  // balance the sell leg to ≈ the same SOL-value in CHIP (@~1000 CHIP/SOL, 9 dec)
  // so alternating swaps net ≈ 0 inventory drift and the SOL-balance delta
  // measures true keeper cost (fees + impact), not SOL→CHIP conversion.
  const chipIn = new BN(Math.round(AMOUNT_SOL * 1000)).mul(new BN(10).pow(new BN(9)));

  console.log(`keeper start: pace ${INTERVAL / 1000}s, dust ${AMOUNT_SOL} SOL, wallet ${owner.publicKey.toBase58().slice(0, 8)}…`);
  let n = 0;
  for (; n < MAX_SWAPS; n++) {
    const buy = n % 2 === 0;
    try {
      const r = buy
        ? await doSwap(raydium, c, WSOL, solIn, 0.1)
        : await doSwap(raydium, c, CHIP, chipIn, 0.1);
      const el = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  [${el}s] swap #${n + 1} ${buy ? "WSOL→CHIP" : "CHIP→WSOL"}  tx ${r.txId.slice(0, 8)}…  price→${r.priceBefore.toFixed(2)}`);
    } catch (e) {
      console.warn(`  swap #${n + 1} failed: ${(e as Error).message}`);
    }
    if (n + 1 < MAX_SWAPS) await sleep(INTERVAL);
  }

  const endBal = await c.getBalance(owner.publicKey);
  const spentSol = (startBal - endBal) / 1e9;
  const hours = (Date.now() - startTime) / 3.6e6;
  console.log(`\nkeeper done: ${n} swaps in ${(hours * 60).toFixed(1)} min`);
  console.log(`  total cost   : ${spentSol.toFixed(6)} SOL  (${(spentSol / n).toFixed(6)} SOL/swap)`);
  console.log(`  per-hour cost: ${(spentSol / hours).toFixed(5)} SOL/hr  at ${(3600 / (INTERVAL / 1000)).toFixed(0)} swaps/hr`);
}
main().catch((e) => { console.error(e); process.exit(1); });
