// One-off: capture real devnet settle txs (and everything ingestSettle needs) into
// test/fixtures/*.json so the parser/recompute/idempotency tests run offline and
// deterministically. Re-run only to refresh fixtures:  node test/capture.ts
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { conn, getTx, findCommit, accountData } from "../src/chain.ts";
import { parseSettle } from "../src/parse.ts";
import { decodeDualMachine } from "../src/dual-decode.ts";
import { PROGRAM_ID } from "../src/config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures");
mkdirSync(DIR, { recursive: true });

// name → settle signature. Chosen to cover: single win, single loss, dual win
// (price still in the ring), dual aged-out (partial).
const CASES: Record<string, string> = {
  "single-win": "2pxdF6FNLw1H9po6tcUs6REDT6LWifVPDxcD4MTcGvFL6jAJ7tKRYji48WPe65eBPvGP17abbFVHzeZvtf1owP3d",
  "single-loss": "2FMmYdbYNCehjsfoSka53cvAzBWyK7uFcwZ56m3T1Yw4KpqVqRwGVkYTtVShsTrUvNjNLQciwsZvKBDZbDgHR1XT",
  "single-jackpot": "3PN2YBiPYHG76Uc6J4gzqbn7PJn5M9BLXZ1A89kwBZvEuM5DVAkxwRvBwCfZmag6wNfpykeBN9XDFRiYMF1v8jQ6",
  "dual-win": "Gc874Zcxrh37PWL9mpce8NWTUx7pYtjPfW1BpB9B8C7ynfmcKSoCkrUTVXMdApg7skKWnpwhoVZoAhc6LGZ5Uv2",
  "dual-aged": "5ATignq4R8L4PoXSWm15fPQW1w8AxbnRo7nKFfGdMU12Aer43FdAAzgFcZ1Esyptq8sh8VQJe2NSEhsEGE22Adr5",
};

const b64 = (b: Buffer | null) => (b ? b.toString("base64") : null);

const c = conn();
for (const [name, sig] of Object.entries(CASES)) {
  const settle = await getTx(c, sig);
  if (!settle) { console.warn(`${name}: settle ${sig} not in RPC history — skipped`); continue; }
  const parsed = parseSettle(settle, PROGRAM_ID.toBase58());
  if (!parsed) { console.warn(`${name}: not a settle — skipped`); continue; }
  const commit = await findCommit(c, parsed.spin, parsed.kind, sig);
  const randomnessData = await accountData(c, parsed.randomness);
  let machineData: Buffer | null = null, poolData: Buffer | null = null, obsData: Buffer | null = null;
  if (parsed.kind === "dual") {
    machineData = await accountData(c, parsed.machine);
    if (machineData) {
      const dm = decodeDualMachine(machineData);
      [poolData, obsData] = await Promise.all([accountData(c, dm.pool.toBase58()), accountData(c, dm.observation.toBase58())]);
    }
  }
  const bundle = {
    settleSig: sig, kind: parsed.kind,
    settle, commit,
    randomnessData: b64(randomnessData),
    machineData: b64(machineData), poolData: b64(poolData), obsData: b64(obsData),
  };
  writeFileSync(join(DIR, `${name}.json`), JSON.stringify(bundle, null, 2));
  console.log(`captured ${name} (${parsed.kind}) → fixtures/${name}.json`);
}
console.log("done");
