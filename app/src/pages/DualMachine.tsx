import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useDualMachine } from "../lib/hooks.ts";
import { runDualSpin, DualSpinResult } from "../lib/dualspin.ts";
import { SpinStage } from "../lib/spin.ts";
import { DEEP, SHALLOW, payoutBp, payoutValueLamports, BP, SYMBOL_NAME } from "../lib/housemath.ts";
import { fmtPctBp, fmtSol, fmtTokens, heatColor, rtpHeat } from "../lib/format.ts";
import { Reels, Sol, Stat, Solscan, PriceChip } from "../components/ui.tsx";
import { Window } from "../components/os/index.ts";
import { RecentSpins } from "../components/Indexed.tsx";
import { DualVerifyButton } from "../components/Verify.tsx";
import { DualStatus } from "../lib/dualstatus.ts";
import { fetchPoolSet, spinRemaining, type PoolSet } from "../lib/poolset.ts";
import { useSession } from "../components/SessionProvider.tsx";
import { SPIN_OVERHEAD } from "../lib/session.ts";

// dual spins additionally rent a CHIP ATA (~0.0021 SOL, first spin) on top of the
// single-asset overhead — refuse a chips wager that can't cover it.
const DUAL_OVERHEAD = SPIN_OVERHEAD + 2_100_000n;

const stageText = (s: SpinStage, chips: boolean): string =>
  (chips
    ? { committing: "Placing wager…", revealing: "Waiting for the Switchboard oracle to reveal (~2–4s)…", settling: "Auto-settling…", done: "" }
    : { committing: "Prompt 1 of 2 — approve “place wager” in your wallet", revealing: "Waiting for the Switchboard oracle to reveal (~2–4s)…", settling: "Prompt 2 of 2 — approve “settle & reveal” in your wallet", done: "" }
  )[s];

export function DualMachinePage() {
  const { pubkey } = useParams();
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { active: chips, session, balance: chipBalance, sessionSend, refresh: refreshChips } = useSession();
  const { status } = useDualMachine(pubkey);

  const [wager, setWager] = useState<bigint | null>(null);
  const [phase, setPhase] = useState<"idle" | SpinStage | "error">("idle");
  const [result, setResult] = useState<DualSpinResult | null>(null);
  const [history, setHistory] = useState<DualSpinResult[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [poolSet, setPoolSet] = useState<PoolSet | null>(null);

  useEffect(() => {
    if (status?.maxBetLamports && wager === null && status.maxBetLamports > 0n) setWager(status.maxBetLamports / 2n);
  }, [status, wager]);

  // pool-set vaults: load the companion PoolSet for the per-pool breakdown + the
  // spin's remaining accounts (a legacy single-pool vault leaves this null).
  useEffect(() => {
    if (!pubkey || !status || status.poolSetLen < 1) { setPoolSet(null); return; }
    let alive = true;
    fetchPoolSet(connection, new PublicKey(pubkey)).then((ps) => { if (alive) setPoolSet(ps); }).catch(() => {});
    return () => { alive = false; };
  }, [pubkey, status, connection]);

  const busy = phase === "committing" || phase === "revealing" || phase === "settling";
  const player = chips && session ? session.keypair.publicKey : publicKey;
  const canPlay = chips || connected;
  // a pool-set vault's commit needs its PoolSet account in remaining_accounts, so
  // don't open the gate until it's loaded (legacy single-pool vaults skip this).
  const setReady = !status || status.poolSetLen < 1 || poolSet !== null;
  const gateOpen = !!status && status.price.commitAllowed && !status.paused && setReady;

  async function spin() {
    if (!player || !status || !pubkey || !wager) return;
    if (!status.maxBetLamports || wager <= 0n || wager > status.maxBetLamports) { setErr("Wager must be between 1 and the live max bet."); return; }
    if (chips && chipBalance !== null && chipBalance < wager + DUAL_OVERHEAD) { setErr("Not enough chips to cover this wager plus fees + the CHIP account rent — top up your chips."); return; }
    setErr(null); setResult(null); setPhase("committing");
    try {
      const r = await runDualSpin({
        conn: connection, player,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sendTransaction: chips ? sessionSend : ((tx, c, o) => sendTransaction(tx as any, c, o as any)),
        machine: new PublicKey(pubkey),
        pool: new PublicKey(status.pool), observation: new PublicKey(status.observation),
        vault: new PublicKey(status.tokenVault), tokenMint: new PublicKey(status.tokenMint), tokenDecimals: status.tokenDecimals,
        wager, commitExtra: spinRemaining(new PublicKey(pubkey), poolSet), onStage: setPhase,
      });
      setResult(r); setHistory((h) => [r, ...h]); setPhase("done");
      if (chips) await refreshChips();
    } catch (e) { setErr((e as Error).message); setPhase("error"); }
  }

  if (!status) return <div className="muted spin-anim">Loading machine…</div>;
  const live = status.price.kind === "LIVE";
  const heat = status.realizedRtpBp !== null ? rtpHeat(status.realizedRtpBp) : 0.5;
  const glow = live ? heatColor(heat) : "var(--ink-faint)";
  const dec = status.tokenDecimals;

  return (
    <div className="stack" style={{ gap: 22 }}>
      <Link className="link" to="/">← the floor</Link>

      <div className="spread" style={{ flexWrap: "wrap", gap: 14 }}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 style={{ fontSize: 38 }}>{status.name}</h1>
          <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
            <span className="os-chip peach">dual · SOL in → CHIP out</span>
            {status.poolSetLen >= 1 && <span className="os-chip neutral" title="priced by the median of a pool set, gated by a majority quorum">{status.poolSetLen}-pool set · {status.eligiblePools}/{status.poolSetLen} live</span>}
            <PriceChip kind={status.price.kind} label={status.price.label} title={status.price.reason} />
            <Solscan acct={status.machine} />
          </div>
        </div>
        <div className="stack" style={{ alignItems: "flex-end", gap: 2 }}>
          <div className="num" style={{ fontFamily: "var(--serif)", fontWeight: 700, fontSize: 42, lineHeight: 1, color: "var(--ink)" }}>
            {status.realizedRtpBp !== null ? fmtPctBp(status.realizedRtpBp) : "—"}
          </div>
          <span className="tag">nominal RTP · band {fmtPctBp(status.rtpFloorBp, 0)}–{fmtPctBp(status.rtpMaxBp, 0)}</span>
        </div>
      </div>

      {/* price + effective-RTP readout */}
      <Window icon="◈" title="Price · effective RTP" bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
          <Stat k="spot">{status.price.spot !== null ? <span className="mono">{status.price.spot.toFixed(2)} <span className="faint">CHIP/SOL</span></span> : "—"}</Stat>
          <Stat k="TWAP (price_at_commit)">{status.price.twap !== null ? <span className="mono">{status.price.twap.toFixed(2)} <span className="faint">CHIP/SOL</span></span> : "—"}</Stat>
          <Stat k="band vs gate">{status.price.bandBp !== null ? <span className="mono">{status.price.bandBp}bp / {status.bandBp}bp</span> : "—"}</Stat>
          <Stat k="obs freshness">{isFinite(status.price.staleSecs) ? <span className="mono">{status.price.staleSecs}s</span> : "—"}</Stat>
        </div>
        {status.effectiveRtpAtSpotBp !== null && status.realizedRtpBp !== null && (
          <div className="note stack" style={{ gap: 4 }}>
            <span className="tag">effective RTP at current spot</span>
            <div className="mono" style={{ fontSize: 14 }}>
              nominal <b>{fmtPctBp(status.realizedRtpBp)}</b> × spot/TWAP ({(status.price.spot! / status.price.twap!).toFixed(4)}) = <b style={{ color: status.effectiveRtpAtSpotBp < Number(status.realizedRtpBp) ? "var(--gold)" : "var(--good)" }}>{(status.effectiveRtpAtSpotBp / 100).toFixed(2)}%</b>
            </div>
            <div className="faint" style={{ fontSize: 12.5 }}>
              Payouts are priced at the TWAP but you receive CHIP worth the <i>spot</i> price. When spot sits
              below the TWAP, your effective return is <b>below</b> nominal; above it, above. This is the
              honest read of the price hedge — never clamped.
            </div>
          </div>
        )}
      </Window>

      {status.poolSetLen >= 1 && (
        <Window icon="◈" title="Pool set · median + quorum" right={<PriceChip kind={status.price.kind} label={status.price.label} title={status.price.reason} />}
          bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="note" style={{ fontSize: 13 }}>
            Price is the <b>median</b> of the eligible pools' TWAPs, gated by a <b>majority quorum</b> of {status.quorum} of {status.poolSetLen}.
            Each pool must pass the same freshness + band gate to count. <b>{status.eligiblePools}/{status.poolSetLen}</b> eligible
            — {status.eligiblePools >= status.quorum ? "quorum met, priced." : "below quorum, spins refused."}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {status.perPoolPrice.map((p, i) => {
              const key = i === 0 ? status.pool : poolSet?.pools[i]?.toBase58();
              return (
                <div key={i} className="panel pad spread" style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}>
                  <div className="row" style={{ gap: 10, alignItems: "center" }}>
                    <span className="tag">pool {i + 1}</span>
                    {key ? <Solscan acct={key} /> : <span className="faint mono">—</span>}
                  </div>
                  <div className="row" style={{ gap: 14, alignItems: "center" }}>
                    <span className="mono faint" style={{ fontSize: 12.5 }}>{p.twap !== null ? `twap ${p.twap.toFixed(1)}` : `${p.staleSecs}s stale`}{p.bandBp !== null ? ` · ${p.bandBp}bp` : ""}</span>
                    <PriceChip kind={p.kind} label={p.commitAllowed ? "eligible" : p.label} title={p.reason} />
                  </div>
                </div>
              );
            })}
          </div>
        </Window>
      )}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Stat k="pool depth"><span className="mono">{fmtTokens(status.tokenBalance, dec, 0)}</span> <span className="faint">CHIP</span></Stat>
        <Stat k="depth value">{status.tokenValueLamports !== null ? <Sol lamports={status.tokenValueLamports} dp={3} /> : "—"}</Stat>
        <Stat k="max bet">{status.maxBetLamports !== null ? <Sol lamports={status.maxBetLamports} dp={5} /> : "—"}</Stat>
        <Stat k="free tokens"><span className="mono">{fmtTokens(status.freeTokens, dec, 0)}</span> <span className="faint">CHIP</span></Stat>
      </div>

      {/* spin console */}
      <Window icon="◈" title="Spin — win CHIP" bodyStyle={{ display: "flex", flexDirection: "column", gap: 20, alignItems: "center", position: "relative" }}>
        <Reels symbols={result ? result.reels : null} spinning={busy} glow={glow} />

        {status.paused && <div className="note warn">This machine is paused by its curator — new spins are halted.</div>}
        {!status.paused && !status.price.commitAllowed && (
          <div className="note warn" style={{ width: "100%" }}>
            <b>Spins are refused right now — {status.price.label}.</b> {status.price.reason}. The on-chain
            commit gate would reject a wager, so the button is disabled — no fees burned on a sure refusal.
            {status.price.kind === "STALE" ? " The pool's price feed needs a fresh swap (the keeper does this)." : " Wait for spot to settle back inside the band."}
          </div>
        )}

        {!canPlay ? (
          <div className="stack" style={{ gap: 10, alignItems: "center" }}>
            <div className="muted">Buy chips (one confirmation, then promptless) or connect a wallet to play.</div>
            <WalletMultiButton />
          </div>
        ) : (
          <div className="stack" style={{ gap: 14, width: "min(460px, 100%)" }}>
            <div className="spread">
              <span className="tag">wager</span>
              <span className="mono">{wager !== null ? fmtSol(wager, 6) : "—"} SOL</span>
            </div>
            <input className="input" type="range" min={1} max={Number(status.maxBetLamports ?? 1n)} step={1}
              value={wager !== null ? Number(wager) : 0} onChange={(e) => setWager(BigInt(e.target.value))}
              disabled={busy || !gateOpen} style={{ padding: 0, accentColor: "var(--gold)" }} />
            <div className="row" style={{ gap: 8 }}>
              {([["25%", 4n], ["50%", 2n], ["max", 1n]] as const).map(([label, div]) => (
                <button key={label} className="btn sm ghost" disabled={busy || !gateOpen} onClick={() => status.maxBetLamports && setWager(status.maxBetLamports / div)}>{label}</button>
              ))}
            </div>
            <button className="btn gold big" onClick={spin} disabled={busy || !gateOpen || !wager}>
              {busy ? "Spinning…" : !gateOpen ? (status.paused ? "Paused" : status.price.label) : "Spin — win CHIP"}
            </button>
            {busy && <div className="note warn spin-anim">{stageText(phase as SpinStage, chips)}</div>}
            <div className="faint" style={{ fontSize: 12, textAlign: "center" }}>
              {chips
                ? <>Playing with chips — no wallet prompts. Balance {chipBalance !== null ? fmtSol(chipBalance, 4) : "…"} SOL · auto-settles on reveal. You wager SOL and win CHIP.</>
                : <>Two wallet prompts per spin: place the SOL wager, then settle &amp; reveal your CHIP prize.</>}
            </div>
          </div>
        )}

        {phase === "error" && err && <div className="note bad" style={{ width: "100%" }}>{err}</div>}
      </Window>

      {result && <DualOutcome r={result} status={status} />}

      {history.length > 0 && (
        <div className="stack" style={{ gap: 12 }}>
          <h3 style={{ fontSize: 20 }}>This session's spins</h3>
          {history.map((r) => (
            <div key={r.settleSig} className="panel pad spread" style={{ flexWrap: "wrap", gap: 12 }}>
              <div className="mono">{r.reels.map((s) => SYMBOL_NAME[s]).join(" · ")} &nbsp; <span className="muted">won {fmtTokens(r.paidTokens, dec, 4)} CHIP</span></div>
              <DualVerifyButton refData={refFrom(r, status)} />
            </div>
          ))}
        </div>
      )}

      <RecentSpins machine={status.machine} kind="dual" tokenDecimals={status.tokenDecimals} />
    </div>
  );
}

function refFrom(r: DualSpinResult, status: DualStatus) {
  return {
    machine: r.machine, pool: r.pool, observation: r.observation, tokenMint: status.tokenMint, tokenDecimals: r.tokenDecimals,
    wager: r.wager.toString(), kBp: r.kBp.toString(), tierIsDeep: r.tierIsDeep, priceAtCommit1e12: r.priceAtCommit1e12.toString(),
    randSeedSlot: r.randSeedSlot.toString(), randomnessAccount: r.randomnessAccount, settleSig: r.settleSig,
    commitBlockTime: r.commitBlockTime, twapWindowSecs: status.twapWindowSecs, maxStalenessSecs: status.maxStalenessSecs,
  };
}

export function DualOutcome({ r, status }: { r: DualSpinResult; status: DualStatus }) {
  const tier = r.tierIsDeep ? DEEP : SHALLOW;
  const baseBp = payoutBp(tier, r.reels);
  const baseMult = Number(baseBp) / Number(BP);
  const kx = Number(r.kBp) / Number(BP);
  const dec = r.tokenDecimals;
  const win = r.paidTokens > 0n;
  const priceAtCommit = Number(r.priceAtCommit1e12) / 1e12;
  // live SOL-value equivalent of the CHIP won, at the CURRENT spot.
  const spot1e12 = status.price.spot !== null ? BigInt(Math.round(status.price.spot * 1e12)) : r.priceAtCommit1e12;
  const valueAtSpot = payoutValueLamports(r.paidTokens, spot1e12, dec);
  return (
    <div className="card pad stack" style={{ gap: 14 }}>
      <div className="spread">
        <h3 style={{ fontSize: 22 }}>{r.reels.map((s) => SYMBOL_NAME[s]).join(" · ")}</h3>
        <span className={`os-chip ${win ? "sage" : "neutral"}`}>{win ? "player win" : "house win"}</span>
      </div>
      <div className="note" style={{ fontFamily: "var(--mono)", fontSize: 13.5 }}>
        payout = wager {fmtSol(r.wager, 6)} SOL × {baseMult}× (paytable) × {kx.toFixed(4)} (k) × <b>{priceAtCommit.toFixed(2)} CHIP/SOL</b> (price_at_commit) = <b>{fmtTokens(r.paidTokens, dec, 6)} CHIP</b>
      </div>
      <div className="faint" style={{ fontSize: 12.5, marginTop: -6 }}>
        Priced at {priceAtCommit.toFixed(2)} CHIP/SOL — <b>locked at commit</b> (a price move between your commit
        and settle cannot re-price it). The CHIP you won is worth ≈ <b>{fmtSol(valueAtSpot, 6)} SOL</b> at the current spot.
      </div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
        <Stat k="wager"><Sol lamports={r.wager} dp={6} /></Stat>
        <Stat k="won" color={win ? "var(--good)" : undefined}><span className="mono">{fmtTokens(r.paidTokens, dec, 6)}</span> <span className="faint">CHIP</span></Stat>
        <Stat k="≈ value at spot"><Sol lamports={valueAtSpot} dp={6} /></Stat>
      </div>
      <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
        <Solscan tx={r.commitSig}>commit (place wager)</Solscan>
        <Solscan tx={r.settleSig}>settle (reveal)</Solscan>
      </div>
      <div className="hr" />
      <div className="stack" style={{ gap: 8 }}>
        <span className="tag">Don't trust — verify. Recompute the CHIP payout AND price_at_commit from chain data:</span>
        <DualVerifyButton refData={refFrom(r, status)} />
      </div>
    </div>
  );
}
