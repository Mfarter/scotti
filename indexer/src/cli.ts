// Entry point: `node src/cli.ts <ingest|serve|dev> [--once]`.
//   ingest        — run the ingest loop every INTERVAL seconds
//   ingest --once — a single pass, then exit (CI / manual backfill)
//   serve         — the read-only HTTP API only
//   dev           — both, in one process
import { Store } from "./db.ts";
import { ingestOnce, conn } from "./ingest.ts";
import { makeServer } from "./server.ts";
import { DB_PATH, PORT, INTERVAL_SECS, RPC_URL, PROGRAM_ID_STR } from "./config.ts";

// node:sqlite is stable enough for our use; silence only its ExperimentalWarning.
process.on("warning", (w) => { if (w.name === "ExperimentalWarning" && /SQLite/i.test(w.message)) return; console.warn(w); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runIngest(store: Store, once: boolean) {
  const c = conn();
  console.log(`[ingest] program ${PROGRAM_ID_STR} via ${RPC_URL}`);
  for (;;) {
    const t0 = Date.now();
    try {
      const { samples, spinsNew, mismatches } = await ingestOnce(store, c);
      console.log(`[ingest] ${new Date().toISOString()} — ${samples} samples, ${spinsNew} new spins (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      if (mismatches.length) {
        console.error(`\n[ingest] *** ${mismatches.length} VERIFICATION MISMATCH(es) — a paid amount did not recompute. STOP AND INVESTIGATE: ***`);
        for (const m of mismatches) console.error(`   ${m.sig}: ${m.detail}`);
        if (once) process.exitCode = 2;
      }
    } catch (e) {
      console.error(`[ingest] pass failed: ${(e as Error).message}`);
      if (once) { process.exitCode = 1; break; }
    }
    if (once) break;
    await sleep(INTERVAL_SECS * 1000);
  }
}

function runServe(store: Store) {
  makeServer(store).listen(PORT, () => console.log(`[serve] http://localhost:${PORT}  (GET /health /machines /machines/:pk/price /machines/:pk/spins)`));
}

const cmd = process.argv[2] ?? "dev";
const once = process.argv.includes("--once");
const store = new Store(DB_PATH);

if (cmd === "ingest") {
  await runIngest(store, once);
  if (once) store.close();
} else if (cmd === "serve") {
  runServe(store);
} else if (cmd === "dev") {
  runServe(store);
  await runIngest(store, false);
} else {
  console.error(`unknown command: ${cmd}\nusage: node src/cli.ts <ingest|serve|dev> [--once]`);
  process.exit(1);
}
