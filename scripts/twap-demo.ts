// H6a SESSION ARTIFACT — drives the live devnet pool through the full price-
// infrastructure story and prints a timeline of twap-status reads:
//   Phase A warmup   : keeper dust-swaps build the ring → STALE → LIVE (spot≈TWAP)
//   Phase B nudge    : one big swap moves spot; 5-min TWAP LAGS → band > 300bp OUT
//   Phase C recovery : counter-swap + dust returns spot → band re-enters IN
//   Phase D staleness: stop swapping → newest obs ages past max_staleness → STALE
// This is the end-to-end proof the price infra works on devnet. Output is also
// appended to twap-demo-output.txt for the report.
import { appendFileSync, readFileSync } from "node:fs"; import { homedir } from "node:os";
import { Connection, Keypair } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import BN from "bn.js";
import { loadRaydium, doSwap } from "./clmm-swap.ts";
import { readStatus } from "./twap-status.ts";
import { CHIP_MINT } from "./raydium-constants.ts";
import { BAND_BP } from "./twap.ts";

const OUT = new URL("./twap-demo-output.txt", import.meta.url).pathname;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WSOL = NATIVE_MINT, CHIP = CHIP_MINT;
function wallet(): Keypair {
  const p = process.env.HOUSE_WALLET ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}
function log(s: string) { console.log(s); appendFileSync(OUT, s + "\n"); }

async function line(c: Connection, tag: string) {
  const s = await readStatus(c);
  const t = new Date(s.now * 1000).toISOString().slice(11, 19);
  const twap = s.twap.status === "LIVE" ? `${s.twap.price!.toFixed(1)}` : "  —  ";
  const band = s.bandBp === null ? " — " : `${String(s.bandBp).padStart(4)}bp`;
  const bandFlag = s.twap.status !== "LIVE" ? "STALE" : (s.bandOk ? "IN " : "OUT");
  const gate = s.twap.status !== "LIVE" ? "REFUSE(stale)" : (s.bandOk ? "ALLOW" : "REFUSE(unstable)");
  log(`${t} | ${tag.padEnd(10)} | spot ${s.spot.toFixed(1).padStart(7)} | twap ${twap.padStart(7)} | ` +
      `cov ${String(s.twap.coverageSecs).padStart(3)}s | fresh ${String(isFinite(s.twap.staleSecs) ? s.twap.staleSecs : 999).padStart(3)}s | ` +
      `band ${band} ${bandFlag} | ${gate}`);
  return s;
}

async function main() {
  const owner = wallet();
  const c = new Connection(process.env.HOUSE_RPC ?? "https://api.devnet.solana.com", "confirmed");
  const raydium = await loadRaydium(c, owner);
  const dust = new BN(Math.round(0.002 * 1e9));
  const dustChip = new BN(2).mul(new BN(10).pow(new BN(9)));
  const startBal = await c.getBalance(owner.publicKey);
  log(`\n===== twap-demo @ ${new Date().toISOString()} =====`);
  log(`time     | phase      |    spot |    twap | coverage| fresh | band       | gate`);

  // ---- Phase A: warmup until LIVE (cap ~24 cycles) ----
  await line(c, "start");
  let live = false;
  for (let i = 0; i < 26 && !live; i++) {
    await doSwap(raydium, c, i % 2 === 0 ? WSOL : CHIP, i % 2 === 0 ? dust : dustChip, 0.1);
    await sleep(3000);
    const s = await line(c, "A:warmup");
    live = s.twap.status === "LIVE";
    if (!live) await sleep(15000);
  }

  // ---- Phase B: deliberate nudge (big WSOL→CHIP), watch TWAP lag → band OUT ----
  log(`>> NUDGE: 0.06 SOL WSOL→CHIP (move spot down, TWAP should lag)`);
  await doSwap(raydium, c, WSOL, new BN(Math.round(0.06 * 1e9)), 0.2);
  await sleep(3000);
  for (let i = 0; i < 3; i++) { await line(c, "B:nudged"); await sleep(16000);
    // keep obs fresh during the hold without moving spot much (balanced)
    await doSwap(raydium, c, i % 2 === 0 ? CHIP : WSOL, i % 2 === 0 ? dustChip : dust, 0.1);
  }

  // ---- Phase C: recovery — counter-swap returns spot, band re-enters ----
  log(`>> RECOVER: counter-swap ~60 CHIP → WSOL to bring spot back toward TWAP`);
  await doSwap(raydium, c, CHIP, new BN(60).mul(new BN(10).pow(new BN(9))), 0.2);
  await sleep(3000);
  for (let i = 0; i < 4; i++) { const s = await line(c, "C:recover");
    if (s.twap.status === "LIVE" && s.bandOk) break;
    await sleep(16000);
    await doSwap(raydium, c, i % 2 === 0 ? WSOL : CHIP, i % 2 === 0 ? dust : dustChip, 0.1);
  }

  // ---- Phase D: stop swapping, watch staleness fire ----
  log(`>> STOP keeper — observations should age past max_staleness (90s) → STALE`);
  for (let i = 0; i < 7; i++) { const s = await line(c, "D:idle");
    if (s.twap.status === "STALE" && s.twap.reason.startsWith("stale")) break;
    await sleep(20000);
  }

  const spent = (startBal - await c.getBalance(owner.publicKey)) / 1e9;
  log(`===== demo end. net SOL spent this run: ${spent.toFixed(6)} SOL =====\n`);
}
main().catch((e) => { console.error("DEMO FAILED:", e); process.exit(1); });
