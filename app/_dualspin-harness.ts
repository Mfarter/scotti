// Live acceptance harness: drives the APP's session-key dual-spin code path
// (src/lib/dualspin.ts::runDualSpin) on devnet, using a keypair sender identical
// to the UI's sessionSender. This exercises the exact frontend spin logic (dual
// instruction builders, snapshot read, oracle reveal, CHIP payout) end-to-end —
// the closest faithful automation of the session-key UI flow. Prints the txids
// and the recomputed vs paid CHIP for the report; verify-spin.ts re-checks it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair, PublicKey, type Signer, type VersionedTransaction } from "@solana/web3.js";
import { runDualSpin } from "./src/lib/dualspin.ts";
import { fetchDualStatus } from "./src/lib/dualstatus.ts";

const RPC = "https://api.devnet.solana.com";
const MACHINE = new PublicKey("6vyARZoi4Kc81ZLHYxYDhE4JGH5Db4zf1u8xvLJEvYzL");

function wallet(): Keypair {
  const p = process.env.HOUSE_WALLET ?? `${homedir()}/.config/solana/id.json`;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const player = wallet();
  // the UI's sessionSender, verbatim: sign the v0 tx with the session key + extras.
  const sender = async (tx: VersionedTransaction, c: Connection, opts?: { signers?: Signer[] }) => {
    tx.sign([player, ...(opts?.signers ?? [])]);
    return c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  };

  const status = await fetchDualStatus(conn, MACHINE);
  console.log(`machine ${status.name}  price ${status.price.label}  spot ${status.price.spot?.toFixed(2)} twap ${status.price.twap?.toFixed(2)} band ${status.price.bandBp}bp`);
  if (!status.price.commitAllowed) throw new Error(`price gate closed (${status.price.label}: ${status.price.reason}) — run the keeper`);
  const maxBet = status.maxBetLamports!;
  const wager = maxBet / 2n > 0n ? maxBet / 2n : 1n;
  console.log(`max bet ${Number(maxBet) / 1e9} SOL → wagering ${Number(wager) / 1e9} SOL`);

  const r = await runDualSpin({
    conn, player: player.publicKey, sendTransaction: sender,
    machine: MACHINE, pool: new PublicKey(status.pool), observation: new PublicKey(status.observation),
    vault: new PublicKey(status.tokenVault), tokenMint: new PublicKey(status.tokenMint), tokenDecimals: status.tokenDecimals,
    wager, onStage: (s) => console.log(`  [stage] ${s}`),
  });

  console.log(`\nreels ${r.reels.join(" · ")}`);
  console.log(`recomputed payout = ${r.payoutTokens} base units`);
  console.log(`CHIP paid on-chain= ${r.paidTokens} base units  (match: ${r.payoutTokens === r.paidTokens ? "YES ✓" : "NO ✗"})`);
  console.log(`price_at_commit    = ${(Number(r.priceAtCommit1e12) / 1e12).toFixed(4)} CHIP/SOL, k ${r.kBp}, tier ${r.tierIsDeep ? "DEEP" : "SHALLOW"}`);
  console.log(`commit  https://solscan.io/tx/${r.commitSig}?cluster=devnet`);
  console.log(`settle  https://solscan.io/tx/${r.settleSig}?cluster=devnet`);
  console.log(`\nSETTLE_SIG=${r.settleSig}`);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
