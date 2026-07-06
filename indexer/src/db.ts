// SQLite storage via node:sqlite (built in — no native dependency). Single file,
// one migration. All bigints are stored as decimal TEXT; slots/times as INTEGER.
import { DatabaseSync } from "node:sqlite";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS machines (
  pubkey              TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,          -- 'single' | 'dual'
  label               TEXT,
  token_mint          TEXT,                   -- dual only
  token_decimals      INTEGER,                -- dual only
  first_indexed_slot  INTEGER,                -- earliest sample/spin slot seen (backfill honesty)
  first_indexed_time  INTEGER
);

CREATE TABLE IF NOT EXISTS price_samples (
  machine                 TEXT NOT NULL,
  slot                    INTEGER NOT NULL,
  block_time              INTEGER,
  -- single-asset:
  pool_value              TEXT,
  total_shares            TEXT,
  share_price_1e12        TEXT,               -- lamports per share ×1e12
  -- dual PRIMARY (price-free):
  token_balance           TEXT,
  share_price_tokens_1e12 TEXT,               -- token base units per share ×1e12
  -- dual SECONDARY (price-dependent, may be null):
  div_pool_sol            TEXT,
  twap_1e12               TEXT,
  token_value_lamports    TEXT,
  price_kind              TEXT,
  PRIMARY KEY (machine, slot)                 -- idempotent: one sample per machine per slot
);
CREATE INDEX IF NOT EXISTS idx_samples_machine_time ON price_samples(machine, block_time);

CREATE TABLE IF NOT EXISTS spins (
  signature            TEXT PRIMARY KEY,       -- settle signature (idempotent)
  machine              TEXT NOT NULL,
  kind                 TEXT NOT NULL,          -- 'single' | 'dual'
  slot                 INTEGER,
  block_time           INTEGER,
  player               TEXT,
  nonce                TEXT,
  wager                TEXT,                   -- lamports (from commit tx; null if unrecoverable)
  reels                TEXT,                   -- 'BAR|BELL|CHERRY' or null
  payout               TEXT,                   -- lamports (single) or token base units (dual)
  payout_kind          TEXT,                   -- 'lamports' | 'tokens'
  commit_sig           TEXT,
  price_at_commit_1e12 TEXT,                   -- dual only, recomputed from ring (nullable)
  verify_status        TEXT NOT NULL,          -- verified | partial | unverifiable | mismatch
  verify_detail        TEXT
);
CREATE INDEX IF NOT EXISTS idx_spins_machine_slot ON spins(machine, slot DESC);
`;

export interface MachineRow {
  pubkey: string; kind: string; label: string | null;
  token_mint: string | null; token_decimals: number | null;
  first_indexed_slot: number | null; first_indexed_time: number | null;
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(MIGRATION);
    this.db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES('schema_version','1')").run();
  }
  close() { this.db.close(); }

  setMeta(key: string, value: string) {
    this.db.prepare("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  /** Upsert a machine, keeping the EARLIEST first_indexed_slot/time ever seen and
   * never nulling out a known label/mint/decimals (spin-ingest passes only the
   * minimum; the sampling pass fills the rest). */
  upsertMachine(m: MachineRow) {
    this.db.prepare(`
      INSERT INTO machines(pubkey,kind,label,token_mint,token_decimals,first_indexed_slot,first_indexed_time)
      VALUES(@pubkey,@kind,@label,@token_mint,@token_decimals,@first_indexed_slot,@first_indexed_time)
      ON CONFLICT(pubkey) DO UPDATE SET
        kind=excluded.kind,
        label=COALESCE(excluded.label, machines.label),
        token_mint=COALESCE(excluded.token_mint, machines.token_mint),
        token_decimals=COALESCE(excluded.token_decimals, machines.token_decimals),
        first_indexed_slot=COALESCE(MIN(machines.first_indexed_slot, excluded.first_indexed_slot), machines.first_indexed_slot, excluded.first_indexed_slot),
        first_indexed_time=COALESCE(MIN(machines.first_indexed_time, excluded.first_indexed_time), machines.first_indexed_time, excluded.first_indexed_time)
    `).run(m as unknown as Record<string, string | number | null>);
  }

  insertSample(s: Record<string, string | number | null>) {
    // idempotent on (machine, slot).
    this.db.prepare(`
      INSERT OR IGNORE INTO price_samples
        (machine,slot,block_time,pool_value,total_shares,share_price_1e12,
         token_balance,share_price_tokens_1e12,div_pool_sol,twap_1e12,token_value_lamports,price_kind)
      VALUES
        (@machine,@slot,@block_time,@pool_value,@total_shares,@share_price_1e12,
         @token_balance,@share_price_tokens_1e12,@div_pool_sol,@twap_1e12,@token_value_lamports,@price_kind)
    `).run(s);
  }

  /** Idempotent on signature. Returns true if a NEW row was written. */
  insertSpin(s: Record<string, string | number | null>): boolean {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO spins
        (signature,machine,kind,slot,block_time,player,nonce,wager,reels,payout,payout_kind,commit_sig,price_at_commit_1e12,verify_status,verify_detail)
      VALUES
        (@signature,@machine,@kind,@slot,@block_time,@player,@nonce,@wager,@reels,@payout,@payout_kind,@commit_sig,@price_at_commit_1e12,@verify_status,@verify_detail)
    `).run(s);
    return r.changes > 0;
  }

  hasSpin(sig: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM spins WHERE signature=?").get(sig);
  }
  countSpins(): number { return (this.db.prepare("SELECT COUNT(*) c FROM spins").get() as { c: number }).c; }
  countSamples(): number { return (this.db.prepare("SELECT COUNT(*) c FROM price_samples").get() as { c: number }).c; }

  listMachines(): MachineRow[] { return this.db.prepare("SELECT * FROM machines ORDER BY kind, label").all() as unknown as MachineRow[]; }
  latestSample(machine: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM price_samples WHERE machine=? ORDER BY slot DESC LIMIT 1").get(machine) as Record<string, unknown> | undefined;
  }
  priceSeries(machine: string, from: number, to: number): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM price_samples WHERE machine=? AND block_time>=? AND block_time<=? ORDER BY block_time ASC").all(machine, from, to) as Record<string, unknown>[];
  }
  spinsFor(machine: string, limit: number, beforeSlot: number | null): Record<string, unknown>[] {
    if (beforeSlot === null)
      return this.db.prepare("SELECT * FROM spins WHERE machine=? ORDER BY slot DESC LIMIT ?").all(machine, limit) as Record<string, unknown>[];
    return this.db.prepare("SELECT * FROM spins WHERE machine=? AND slot<? ORDER BY slot DESC LIMIT ?").all(machine, beforeSlot, limit) as Record<string, unknown>[];
  }
}
