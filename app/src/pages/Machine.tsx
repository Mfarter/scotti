import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useMachine } from "../lib/hooks.ts";
import { runSpin, SpinResult, SpinStage } from "../lib/spin.ts";
import { DEEP, SHALLOW, payoutBp, BP, SYMBOL_NAME } from "../lib/housemath.ts";
import { fmtPctBp, fmtSol, fmtLamports, heatColor, rtpHeat } from "../lib/format.ts";
import { Reels, Sol, Stat, TierBadge, Solscan } from "../components/ui.tsx";
import { VerifyButton } from "../components/Verify.tsx";
import { MachineStatus } from "../lib/status.ts";
import { useSession } from "../components/SessionProvider.tsx";
import { SPIN_OVERHEAD } from "../lib/session.ts";

const stageText = (s: SpinStage, chips: boolean): string => {
  if (chips) return ({ committing: "Placing wager…", revealing: "Waiting for the Switchboard oracle to reveal (~2–4s)…", settling: "Auto-settling…", done: "" } as Record<SpinStage, string>)[s];
  return ({ committing: "Prompt 1 of 2 — approve “place wager” in your wallet", revealing: "Waiting for the Switchboard oracle to reveal (~2–4s)…", settling: "Prompt 2 of 2 — approve “settle & reveal” in your wallet", done: "" } as Record<SpinStage, string>)[s];
};

export function MachinePage() {
  const { pubkey } = useParams();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { active: chips, session, balance: chipBalance, sessionSend, refresh: refreshChips } = useSession();
  const { status } = useMachine(pubkey);

  const [wager, setWager] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<"idle" | SpinStage | "error">("idle");
  const [result, setResult] = useState<SpinResult | null>(null);
  const [history, setHistory] = useState<SpinResult[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (status && wager === null && status.maxBet > 0n) setWager(status.maxBet / 2n);
  }, [status, wager]);

  const busy = phase === "committing" || phase === "revealing" || phase === "settling";
  const spinning = busy;
  // chips (session key) plays promptlessly; otherwise the connected wallet plays
  // with two prompts. Chips take precedence when a session is active.
  const player = chips && session ? session.keypair.publicKey : publicKey;
  const canPlay = chips || connected;

  async function spin() {
    if (!player || !status || !pubkey || !wager) return;
    if (wager <= 0n || wager > status.maxBet) { setErr("Wager must be between 1 and the live max bet."); return; }
    if (chips && chipBalance !== null && chipBalance < wager + SPIN_OVERHEAD) {
      setErr("Not enough chips to cover this wager plus fees — top up your chips."); return;
    }
    setErr(null); setResult(null); setPhase("committing");
    try {
      const r = await runSpin({
        conn: connection, player,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sendTransaction: chips ? sessionSend : ((tx, c, o) => sendTransaction(tx as any, c, o as any)),
        machine: new PublicKey(pubkey), wager, onStage: setPhase,
      });
      setResult(r); setHistory((h) => [r, ...h]); setPhase("done");
      if (chips) await refreshChips();
    } catch (e) {
      setErr((e as Error).message); setPhase("error");
    }
  }

  if (!status) return <div className="muted spin-anim">Loading machine…</div>;
  const heat = rtpHeat(status.realizedRtpBp);
  const glow = heatColor(heat);

  return (
    <div className="stack" style={{ gap: 22 }}>
      <Link className="link" to="/">← the floor</Link>

      <div className="spread" style={{ flexWrap: "wrap", gap: 14 }}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 style={{ fontSize: 38 }}>{status.name}</h1>
          <div className="row" style={{ gap: 10 }}>
            <TierBadge tier={status.tier} topMult={status.topMult} paused={status.paused} />
            <Solscan acct={status.machine} />
          </div>
        </div>
        <div className="stack" style={{ alignItems: "flex-end", gap: 2 }}>
          <div className="num" style={{ fontFamily: "var(--display)", fontWeight: 900, fontSize: 40, lineHeight: 1, color: glow, textShadow: `0 0 26px ${heatColor(heat, 0.5)}` }}>{fmtPctBp(status.realizedRtpBp)}</div>
          <span className="tag">realized RTP · k {status.kBp.toString()}</span>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Stat k="pool depth"><Sol lamports={status.poolValue} dp={3} /></Stat>
        <Stat k="max bet"><Sol lamports={status.maxBet} dp={5} /></Stat>
        <Stat k="reserved"><Sol lamports={status.reservedExposure} dp={5} /></Stat>
        <Stat k="free liquidity"><Sol lamports={status.freeLiquidity} dp={3} /></Stat>
      </div>

      {/* spin console */}
      <div className="card pad stack" style={{ gap: 20, alignItems: "center", position: "relative" }}>
        <Reels symbols={result ? result.reels : null} spinning={spinning} glow={glow} />

        {status.paused && <div className="note warn">This machine is paused by its curator — new spins are halted.</div>}

        {!canPlay ? (
          <div className="stack" style={{ gap: 10, alignItems: "center" }}>
            <div className="muted">Buy chips (one confirmation, then promptless) or connect a wallet to play.</div>
            <WalletMultiButton />
          </div>
        ) : (
          <div className="stack" style={{ gap: 14, width: "min(460px, 100%)" }}>
            <div className="spread">
              <span className="tag">wager</span>
              <span className="mono">{wager !== null ? fmtSol(wager, 6) : "—"} SOL <span className="faint">· {wager !== null ? fmtLamports(wager) : ""} lamports</span></span>
            </div>
            <input
              className="input" type="range" min={1} max={Number(status.maxBet)} step={1}
              value={wager !== null ? Number(wager) : 0}
              onChange={(e) => setWager(BigInt(e.target.value))}
              disabled={busy || status.paused}
              style={{ padding: 0, accentColor: "var(--gold)" }}
            />
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm ghost" disabled={busy} onClick={() => setWager(status.maxBet / 4n)}>25%</button>
              <button className="btn sm ghost" disabled={busy} onClick={() => setWager(status.maxBet / 2n)}>50%</button>
              <button className="btn sm ghost" disabled={busy} onClick={() => setWager(status.maxBet)}>max</button>
            </div>
            <button className="btn gold big" onClick={spin} disabled={busy || status.paused || !wager}>
              {busy ? "Spinning…" : "Spin"}
            </button>
            {busy && <div className="note warn spin-anim">{stageText(phase as SpinStage, chips)}</div>}
            {chips ? (
              <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>
                Playing with chips — no wallet prompts. Balance {chipBalance !== null ? fmtSol(chipBalance, 4) : "…"} SOL · auto-settles on reveal.
              </div>
            ) : (
              <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>Two wallet prompts per spin: place the wager, then settle &amp; reveal. Buy chips to play promptless.</div>
            )}
          </div>
        )}

        {phase === "error" && err && <div className="note bad" style={{ width: "100%" }}>{err}</div>}
      </div>

      {result && <Outcome r={result} status={status} />}

      {history.length > 0 && (
        <div className="stack" style={{ gap: 12 }}>
          <h3 style={{ fontSize: 20 }}>This session's spins</h3>
          {history.map((r) => (
            <div key={r.settleSig} className="panel pad spread" style={{ flexWrap: "wrap", gap: 12 }}>
              <div className="mono">{r.reels.map((s) => SYMBOL_NAME[s]).join(" · ")} &nbsp; <span className="muted">payout {fmtLamports(r.payout)}</span></div>
              <VerifyButton refData={{ machine: status.machine, wager: r.wager.toString(), kBp: r.kBp.toString(), tierIsDeep: r.tierIsDeep, randSeedSlot: r.randSeedSlot.toString(), randomnessAccount: r.randomnessAccount, settleSig: r.settleSig }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Outcome({ r, status }: { r: SpinResult; status: MachineStatus }) {
  const tier = r.tierIsDeep ? DEEP : SHALLOW;
  const baseBp = payoutBp(tier, r.reels);
  const baseMult = Number(baseBp) / Number(BP);
  const kx = Number(r.kBp) / Number(BP);
  const win = r.payout > r.wager;
  return (
    <div className="card pad stack" style={{ gap: 14 }}>
      <div className="spread">
        <h3 style={{ fontSize: 22 }}>{r.reels.map((s) => SYMBOL_NAME[s]).join(" · ")}</h3>
        <span className={`badge ${win ? "shallow" : "deep"}`} style={win ? { color: "#bff0dc", borderColor: "rgba(87,217,163,0.4)", background: "rgba(87,217,163,0.08)" } : undefined}>{win ? "player win" : "house win"}</span>
      </div>
      <div className="note" style={{ fontFamily: "var(--mono)", fontSize: 13.5 }}>
        payout = wager {fmtLamports(r.wager)} × {baseMult}× (paytable) × {kx.toFixed(4)} (k snapshot) = <b>{fmtLamports(r.payout)}</b> lamports
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Stat k="wager"><Sol lamports={r.wager} dp={6} /></Stat>
        <Stat k="payout" color={win ? "var(--good)" : undefined}><Sol lamports={r.payout} dp={6} /></Stat>
        <Stat k="pool Δ">{r.poolDelta < 0n ? "−" : "+"}<Sol lamports={r.poolDelta < 0n ? -r.poolDelta : r.poolDelta} dp={6} unit={false} /></Stat>
      </div>
      <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
        <Solscan tx={r.commitSig}>commit (place wager)</Solscan>
        <Solscan tx={r.settleSig}>settle (reveal)</Solscan>
      </div>
      <div className="hr" />
      <div className="stack" style={{ gap: 8 }}>
        <span className="tag">Don't trust — verify. Recompute this outcome from chain data:</span>
        <VerifyButton refData={{ machine: status.machine, wager: r.wager.toString(), kBp: r.kBp.toString(), tierIsDeep: r.tierIsDeep, randSeedSlot: r.randSeedSlot.toString(), randomnessAccount: r.randomnessAccount, settleSig: r.settleSig }} />
      </div>
    </div>
  );
}
