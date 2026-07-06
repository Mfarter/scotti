// Fixture loader: reconstruct a SettleBundle (Buffers from base64) from a captured
// JSON file so the tests run offline against real devnet data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { SettleBundle } from "../src/ingest.ts";
import type { RawTx } from "../src/parse.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const buf = (s: string | null) => (s === null ? null : Buffer.from(s, "base64"));

interface FixtureJson {
  settleSig: string; kind: string;
  settle: RawTx; commit: RawTx | null;
  randomnessData: string | null; machineData: string | null; poolData: string | null; obsData: string | null;
}

export function loadBundle(name: string): SettleBundle {
  const f = JSON.parse(readFileSync(join(HERE, "fixtures", `${name}.json`), "utf8")) as FixtureJson;
  return {
    settleSig: f.settleSig, settle: f.settle, commit: f.commit,
    randomnessData: buf(f.randomnessData), machineData: buf(f.machineData),
    poolData: buf(f.poolData), obsData: buf(f.obsData),
  };
}
