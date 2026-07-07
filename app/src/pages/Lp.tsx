import { useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useFloor, useDualFloor, useLp, useMachine } from "../lib/hooks.ts";
import { ixCancelWithdraw, ixLpDeposit, ixProcessWithdrawals, ixRequestWithdraw } from "../lib/program.ts";
import { confirm } from "../lib/rpc.ts";
import { SOL } from "../lib/constants.ts";
import { fmtPctBp, fmtLamports } from "../lib/format.ts";
import { Sol, Stat, TierBadge } from "../components/ui.tsx";
import { Window, SectionHeader } from "../components/os/index.ts";
import { SharePriceChart } from "../components/Indexed.tsx";
import { indexerEnabled } from "../lib/indexer.ts";
import { DualLpPanel } from "./DualLpPanel.tsx";
import { LpDashboard } from "./LpDashboard.tsx";

function scrollToId(id: string) {
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
}

function parseSol(s: string): bigint | null {
  const n = Number(s);
  if (!isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * Number(SOL)));
}

export function Lp() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { entries } = useFloor(8000);
  const { entries: dualEntries } = useDualFloor(8000);
  const [selected, setSelected] = useState<string | null>(null);
  const [dualSel, setDualSel] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const [singleDepositOpen, setSingleDepositOpen] = useState(false);
  const [dualDepositNonce, setDualDepositNonce] = useState(0);
  const machine = selected ?? entries?.[0]?.pubkey.toBase58() ?? null;
  const activePk = activeRow ?? machine;

  function onSelectRow(pk: string, kind: "single" | "dual") {
    setActiveRow(pk);
    if (kind === "single") { setSelected(pk); scrollToId("lp-single-detail"); }
    else { setDualSel(pk); scrollToId("lp-dual-detail"); }
  }

  // A row's Deposit button selects that machine and opens its deposit modal. The
  // dual modal lives in DualLpPanel (it owns the token-mint/vault status), so we
  // trigger it with a bumped nonce; the tx/validation logic is unchanged either way.
  function onDepositRow(pk: string, kind: "single" | "dual") {
    setActiveRow(pk);
    if (kind === "single") { setSelected(pk); setSingleDepositOpen(true); }
    else { setDualSel(pk); setDualDepositNonce((n) => n + 1); }
  }

  const { status, refresh: refreshM } = useMachine(machine ?? undefined, 6000);
  const { lp, refresh: refreshLp } = useLp(machine ?? undefined, publicKey ?? null, 6000);

  const [depositSol, setDepositSol] = useState("0.05");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);
  const [crankAddr, setCrankAddr] = useState("");

  async function send(ixLabel: string, buildIx: () => Transaction): Promise<boolean> {
    if (!publicKey) return false;
    setBusy(ixLabel); setMsg(null);
    try {
      const sig = await sendTransaction(buildIx(), connection);
      await confirm(connection, sig, ixLabel);
      setMsg({ kind: "good", text: `${ixLabel} confirmed` });
      await Promise.all([refreshM(), refreshLp()]);
      return true;
    } catch (e) {
      setMsg({ kind: "bad", text: `${ixLabel} failed: ${(e as Error).message}` });
      return false;
    } finally { setBusy(null); }
  }

  const m = machine ? new PublicKey(machine) : null;

  return (
    <div className="stack" style={{ gap: 22 }}>
      <header>
        <SectionHeader kicker="Liquidity" title="Back the house." titleSize={34}
          subline={<span style={{ display: "block", maxWidth: 640 }}>
            LPs own the bankroll pro-rata. The house edge on every spin accrues to the pool, so your
            share price drifts up with volume and down when jackpots land. Yield is share-price
            appreciation — never a promised rate.
          </span>} />
      </header>

      <LpDashboard singles={entries} duals={dualEntries} activePk={activePk} onSelect={onSelectRow} onDeposit={onDepositRow} />

      {!connected && (
        <div className="card pad stack" style={{ gap: 12, alignItems: "flex-start" }}>
          <div className="muted">Connect a devnet wallet to deposit and manage a position.</div>
          <WalletMultiButton />
        </div>
      )}

      {msg && <div className={`note ${msg.kind}`}>{msg.text}</div>}

      {status && m && (
        <div id="lp-single-detail" className="grid" style={{ gridTemplateColumns: "1.1fr 0.9fr", alignItems: "start" }}>
          {/* left: position + actions */}
          <div className="stack" style={{ gap: 16 }}>
            <Window icon="◇" title="Your position" bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {!connected || !lp?.exists ? (
                <div className="muted">No position on this machine yet.</div>
              ) : (
                <>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <Stat k="shares"><span className="mono">{fmtLamports(lp.shares)}</span></Stat>
                    <Stat k="value now"><Sol lamports={lp.valueLamports} dp={5} /></Stat>
                  </div>
                  {lp.pendingShares > 0n && (
                    <div className="note warn stack" style={{ gap: 4 }}>
                      <div>Pending withdrawal: <span className="mono">{fmtLamports(lp.pendingShares)}</span> shares (~<Sol lamports={lp.pendingValueLamports} dp={5} />)</div>
                      <div className="faint" style={{ fontSize: 12.5 }}>
                        requested in epoch {lp.pendingEpoch.toString()} · {lp.processableNow
                          ? "processable now"
                          : `processable after slot ${lp.nextBoundarySlot.toString()} (~${((Number(lp.nextBoundarySlot - status.slot)) * 0.4 / 60).toFixed(1)} min)`}
                      </div>
                    </div>
                  )}
                </>
              )}

              {connected && (
                <>
                  {lp?.exists && lp.shares > 0n && (
                    <div className="stack" style={{ gap: 8 }}>
                      <div className="hr" />
                      <span className="tag">request withdrawal (epoch-gated)</span>
                      <div className="faint" style={{ fontSize: 12 }}>
                        Paid at the epoch's conservative price snapshot — the pool valued as if every
                        pending spin hits its max — so exiting while spins are in flight is priced for
                        the worst case and any surplus favors the LPs who stay. Order-independent within
                        an epoch: identical requests are paid identically.
                      </div>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        {[25, 50, 100].map((pct) => (
                          <button key={pct} className="btn sm" disabled={busy !== null} onClick={() => {
                            const shares = (lp.shares * BigInt(pct)) / 100n;
                            send("request_withdraw", () => new Transaction().add(ixRequestWithdraw(m, publicKey!, shares)));
                          }}>{pct}%</button>
                        ))}
                      </div>
                    </div>
                  )}

                  {lp?.exists && lp.pendingShares > 0n && (
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <button className="btn" disabled={busy !== null} onClick={() => send("cancel_withdraw", () => new Transaction().add(ixCancelWithdraw(m, publicKey!)))}>Cancel request</button>
                      {lp.processableNow && (
                        <button className="btn neon" disabled={busy !== null} onClick={() => send("process_withdrawals", () => new Transaction().add(ixProcessWithdrawals(m, publicKey!, publicKey!)))}>Process my withdrawal</button>
                      )}
                    </div>
                  )}
                </>
              )}
            </Window>

            {/* permissionless crank */}
            {connected && (
              <Window icon="◇" title="Crank someone's withdrawal" bodyStyle={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <p className="muted" style={{ margin: 0, fontSize: 13.5 }}>The processing crank is permissionless — anyone can settle any LP's due request. Paste an LP owner address.</p>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <input className="input mono" placeholder="LP owner pubkey" value={crankAddr} onChange={(e) => setCrankAddr(e.target.value)} style={{ fontSize: 13 }} />
                  <button className="btn" disabled={busy !== null || !crankAddr} onClick={() => {
                    let owner: PublicKey; try { owner = new PublicKey(crankAddr.trim()); } catch { setMsg({ kind: "bad", text: "not a valid pubkey" }); return; }
                    send("process_withdrawals", () => new Transaction().add(ixProcessWithdrawals(m, owner, publicKey!)));
                  }}>Crank</button>
                </div>
              </Window>
            )}
          </div>

          {/* right: honest yield display */}
          <Yield status={status} />
        </div>
      )}

      <div className="hr" style={{ margin: "8px 0" }} />
      <div id="lp-dual-detail"><DualLpPanel selectedPk={dualSel} hideSelector openDepositNonce={dualDepositNonce} /></div>

      {/* Deposit modal — the single-asset deposit entry point, relocated from the
          position Window. The transaction/validation logic below is moved verbatim. */}
      {singleDepositOpen && status && (
        <div className="modal-backdrop" onClick={() => setSingleDepositOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="spread" style={{ marginBottom: 10 }}>
              <h3 style={{ fontSize: 20 }}>Deposit — {status.name}</h3>
              <TierBadge tier={status.tier} topMult={status.topMult} paused={status.paused} />
            </div>
            {!connected ? (
              <div className="stack" style={{ gap: 10 }}>
                <div className="muted">Connect a devnet wallet to deposit and manage a position.</div>
                <WalletMultiButton />
              </div>
            ) : (
              <div className="stack" style={{ gap: 12 }}>
                <div className="stack" style={{ gap: 8 }}>
                  <span className="tag">deposit</span>
                  <div className="row" style={{ gap: 8 }}>
                    <input className="input" value={depositSol} onChange={(e) => setDepositSol(e.target.value)} inputMode="decimal" style={{ maxWidth: 160 }} />
                    <span className="faint">SOL</span>
                    <button className="btn gold" disabled={busy !== null || !parseSol(depositSol)} onClick={async () => {
                      const amt = parseSol(depositSol); if (!amt || !m) return;
                      if (await send("deposit", () => new Transaction().add(ixLpDeposit(m, publicKey!, amt)))) setSingleDepositOpen(false);
                    }}>{busy === "deposit" ? "…" : "Deposit"}</button>
                  </div>
                </div>
                <SingleVarianceNote status={status} />
                {msg && msg.kind === "bad" && <div className="note bad">{msg.text}</div>}
              </div>
            )}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn ghost" onClick={() => setSingleDepositOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** The material single-asset risk disclosure — one source, rendered both in the
 * "What to expect" Window and (so it is not orphaned) in the deposit modal. */
export function SingleVarianceNote({ status }: { status: import("../lib/status.ts").MachineStatus }) {
  const maxDrawdownPct = Number(status.maxExposureBp) / 100;
  return (
    <div className="note warn stack" style={{ gap: 4 }}>
      <span style={{ fontWeight: 800 }}>Variance, honestly</span>
      <span style={{ fontSize: 13.5 }}>
        A single jackpot pays up to <b>{maxDrawdownPct}% of the pool</b> (the per-spin exposure cap).
        Expect whole-percent drawdowns when the {status.topMult}× top line lands. This is a devnet demo — the
        expected return is <b>not an APY</b>; it is share-price appreciation with real drawdown risk.
      </span>
    </div>
  );
}

function Yield({ status }: { status: import("../lib/status.ts").MachineStatus }) {
  const [volSol, setVolSol] = useState("20");
  const edgeBp = 10_000n - status.realizedRtpBp; // house edge in bp
  const vol = Number(volSol) || 0;
  const pool = Number(status.poolValue) / Number(SOL);
  const dailyEdgeSol = vol * (Number(edgeBp) / 10_000);
  const dailyPct = pool > 0 ? (dailyEdgeSol / pool) * 100 : 0;
  const yearlyPct = dailyPct * 365;

  return (
    <Window icon="◇" title="What to expect" bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <Stat k="share price"><span className="mono">{(Number(status.sharePrice1e12) / 1e12).toPrecision(5)}</span></Stat>
        <Stat k="house edge"><span className="num">{fmtPctBp(edgeBp)}</span></Stat>
      </div>

      <div className="note stack" style={{ gap: 8 }}>
        <span className="tag">expected-value calculator</span>
        <div className="row" style={{ gap: 8 }}>
          <span className="faint" style={{ fontSize: 13 }}>projected volume</span>
          <input className="input" value={volSol} onChange={(e) => setVolSol(e.target.value)} inputMode="decimal" style={{ maxWidth: 90, padding: "6px 10px", fontSize: 14 }} />
          <span className="faint" style={{ fontSize: 13 }}>SOL/day</span>
        </div>
        <div className="mono" style={{ fontSize: 13.5 }}>
          expected yield = edge × volume ÷ pool → the pool earns <b>{dailyEdgeSol.toFixed(4)} SOL/day</b>
          {pool > 0 && <> (~{dailyPct.toFixed(3)}%/day, ~{yearlyPct.toFixed(1)}%/yr on current depth)</>} — <b>before variance</b>.
        </div>
        <div className="faint" style={{ fontSize: 12.5 }}>
          The rate is edge × volume ÷ pool: a smaller pool with the same routed volume runs a
          <b> hotter rate</b> — because the same edge is spread over less capital, <i>not</i> because your
          deposit is a bigger slice. More depositors at the same volume dilute the rate for everyone.
        </div>
      </div>

      <SingleVarianceNote status={status} />

      {indexerEnabled()
        ? <><div className="hr" /><SharePriceChart machine={status.machine} kind="single" /></>
        : <div className="faint" style={{ fontSize: 12 }}>Trailing 7d/30d share-price history and annualized drawdown need an indexer — not shown rather than faked.</div>}
    </Window>
  );
}
