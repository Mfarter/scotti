import { useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { SpinRef, VerifyResult, verifySpin, DualSpinRef, DualVerifyResult, verifyDualSpin } from "../lib/verify.ts";
import { fmtLamports, fmtTokens } from "../lib/format.ts";
import { SYMBOL_NAME } from "../lib/housemath.ts";
import { Solscan } from "./ui.tsx";

export function VerifyButton({ refData }: { refData: SpinRef }) {
  const { connection } = useConnection();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [res, setRes] = useState<VerifyResult | null>(null);
  const [err, setErr] = useState<string>("");

  async function run() {
    setState("running"); setErr("");
    try { setRes(await verifySpin(connection, refData)); setState("done"); }
    catch (e) { setErr((e as Error).message); setState("error"); }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={run} disabled={state === "running"}>
          {state === "running" ? "Recomputing…" : "Verify in browser"}
        </button>
        <Solscan tx={refData.settleSig}>settle tx</Solscan>
      </div>
      {state === "error" && <div className="note bad">{err}</div>}
      {state === "done" && res && (
        <div className={`note ${res.ok ? "good" : "bad"}`}>
          <div className="mono" style={{ marginBottom: 4 }}>
            reels {res.reels.map((s) => SYMBOL_NAME[s]).join(" · ")}
          </div>
          <div className="mono">recomputed payout = {fmtLamports(res.recomputedPayout)} lamports</div>
          {res.paidOnchain >= 0n
            ? <div className="mono">paid on-chain&nbsp;&nbsp;&nbsp; = {fmtLamports(res.paidOnchain)} lamports</div>
            : null}
          <div style={{ marginTop: 6, fontWeight: 800 }}>
            {res.ok
              ? (res.paidOnchain >= 0n ? "✓ recomputed payout == vault payout" : "✓ seed_slot binding holds")
              : "✗ mismatch"}
            {res.seedSlotMatch ? "  ·  seed_slot bound ✓" : "  ·  seed_slot mismatch ✗"}
          </div>
          {res.note && <div className="faint" style={{ marginTop: 4, fontSize: 12 }}>{res.note}</div>}
        </div>
      )}
    </div>
  );
}

/** Dual-asset verifier: recomputes the CHIP payout from the snapshot + randomness,
 * AND independently recomputes price_at_commit from the pool's observation ring. */
export function DualVerifyButton({ refData }: { refData: DualSpinRef }) {
  const { connection } = useConnection();
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [res, setRes] = useState<DualVerifyResult | null>(null);
  const [err, setErr] = useState<string>("");
  const dec = refData.tokenDecimals;

  async function run() {
    setState("running"); setErr("");
    try { setRes(await verifyDualSpin(connection, refData)); setState("done"); }
    catch (e) { setErr((e as Error).message); setState("error"); }
  }
  const p1e12 = (x: bigint) => (Number(x) / 1e12).toFixed(2);

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={run} disabled={state === "running"}>
          {state === "running" ? "Recomputing…" : "Verify in browser"}
        </button>
        <Solscan tx={refData.settleSig}>settle tx</Solscan>
      </div>
      {state === "error" && <div className="note bad">{err}</div>}
      {state === "done" && res && (
        <div className={`note ${res.ok ? "good" : "bad"}`}>
          <div className="mono" style={{ marginBottom: 4 }}>reels {res.reels.map((s) => SYMBOL_NAME[s]).join(" · ")}</div>
          <div className="mono">recomputed payout = {fmtTokens(res.recomputedPayoutTokens, dec, 6)} CHIP</div>
          {res.paidTokens >= 0n && <div className="mono">paid on-chain&nbsp;&nbsp;&nbsp; = {fmtTokens(res.paidTokens, dec, 6)} CHIP</div>}
          <div className="mono" style={{ marginTop: 4 }}>
            price snapshot = {p1e12(res.snapshotPrice1e12)} CHIP/SOL
            {res.recomputedPrice1e12 !== null && <> · ring recompute = {p1e12(res.recomputedPrice1e12)} ({res.priceDriftBp! >= 0 ? "+" : ""}{res.priceDriftBp}bp)</>}
          </div>
          <div style={{ marginTop: 6, fontWeight: 800 }}>
            {res.payoutMatch ? "✓ payout matches" : "✗ payout mismatch"}
            {"  ·  "}{res.seedSlotMatch ? "seed_slot ✓" : "seed_slot ✗"}
            {res.recomputedPrice1e12 !== null && <>{"  ·  "}{res.priceConsistent ? "price from ring ✓" : "price NOT from ring ✗"}</>}
          </div>
          {res.note && <div className="faint" style={{ marginTop: 4, fontSize: 12 }}>{res.note}</div>}
        </div>
      )}
    </div>
  );
}
