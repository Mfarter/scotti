// Read-only JSON API over the SQLite file. No writes, no auth, no state beyond the
// DB. CORS is wide open — this is public devnet data. Built on node:http (no web
// framework dependency).
//
//   GET /health
//   GET /machines
//   GET /machines/:pubkey/price?from&to&resolution
//   GET /machines/:pubkey/spins?limit&before
import { createServer } from "node:http";
import type { Store } from "./db.ts";

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "*",
    "cache-control": "no-store",
  });
  res.end(s);
};

/** Downsample a time series to one row per `bucket` seconds (last wins). */
function downsample(rows: Record<string, unknown>[], bucket: number): Record<string, unknown>[] {
  if (!bucket || bucket <= 0) return rows;
  const out = new Map<number, Record<string, unknown>>();
  for (const r of rows) out.set(Math.floor(Number(r.block_time) / bucket), r);
  return [...out.values()];
}

export function makeServer(store: Store) {
  return createServer((req, res) => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.method !== "GET") return json(res, 405, { error: "read-only" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    try {
      if (parts.length === 1 && parts[0] === "health") {
        return json(res, 200, {
          ok: true,
          source: "scotti-indexer",
          machines: store.listMachines().length,
          spins: store.countSpins(),
          samples: store.countSamples(),
          lastIngestSlot: store.getMeta("last_ingest_slot"),
          lastIngestTime: store.getMeta("last_ingest_time"),
        });
      }

      if (parts.length === 1 && parts[0] === "machines") {
        return json(res, 200, store.listMachines().map((m) => ({
          pubkey: m.pubkey, kind: m.kind, label: m.label,
          tokenMint: m.token_mint, tokenDecimals: m.token_decimals,
          firstIndexedSlot: m.first_indexed_slot, firstIndexedTime: m.first_indexed_time,
          latestSample: store.latestSample(m.pubkey) ?? null,
        })));
      }

      if (parts.length === 3 && parts[0] === "machines" && parts[2] === "price") {
        const pk = parts[1];
        const m = store.listMachines().find((x) => x.pubkey === pk);
        if (!m) return json(res, 404, { error: "unknown machine" });
        const from = Number(url.searchParams.get("from") ?? "0");
        const to = Number(url.searchParams.get("to") ?? String(Math.floor(Date.now() / 1000)));
        const resolution = Number(url.searchParams.get("resolution") ?? "0");
        const rows = downsample(store.priceSeries(pk, from, to), resolution);
        return json(res, 200, {
          machine: pk, kind: m.kind, label: m.label, tokenDecimals: m.token_decimals,
          firstIndexedTime: m.first_indexed_time,
          series: rows.map((r) => ({
            t: r.block_time, slot: r.slot,
            // single-asset
            sharePrice1e12: r.share_price_1e12, poolValue: r.pool_value, totalShares: r.total_shares,
            // dual PRIMARY (price-free)
            sharePriceTokens1e12: r.share_price_tokens_1e12, tokenBalance: r.token_balance,
            // dual SECONDARY (price-dependent)
            divPoolSol: r.div_pool_sol, twap1e12: r.twap_1e12, tokenValueLamports: r.token_value_lamports, priceKind: r.price_kind,
          })),
        });
      }

      if (parts.length === 3 && parts[0] === "machines" && parts[2] === "spins") {
        const pk = parts[1];
        const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 500);
        const beforeStr = url.searchParams.get("before");
        const before = beforeStr === null ? null : Number(beforeStr);
        const rows = store.spinsFor(pk, limit, before);
        return json(res, 200, rows.map((r) => ({
          signature: r.signature, machine: r.machine, kind: r.kind, slot: r.slot, blockTime: r.block_time,
          player: r.player, nonce: r.nonce, wager: r.wager, reels: r.reels,
          payout: r.payout, payoutKind: r.payout_kind, commitSig: r.commit_sig,
          priceAtCommit1e12: r.price_at_commit_1e12,
          verifyStatus: r.verify_status, verifyDetail: r.verify_detail,
        })));
      }

      return json(res, 404, { error: "not found" });
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
  });
}
