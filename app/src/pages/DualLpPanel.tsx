// The dual-asset LP section of the Liquidity page. Dual LPs deposit CHIP
// (price-free), earn the SOL house edge as a per-share dividend, and choose how
// it's paid: SOL (claim anytime) or SPL (earmarked, compounded by a permissionless
// epoch crank via one band-bounded swap). Withdrawals pay BOTH assets pro-rata,
// price-free. Token-denominated risk is disclosed plainly next to deposit.
import { useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useDualFloor, useDualMachine, useDualLp } from "../lib/hooks.ts";
import {
  ata, ixCancelWithdrawToken, ixClaimSol, ixCreateAtaIdempotent, ixEarmarkSol, ixLpDepositToken,
  ixProcessWithdrawalToken, ixRequestWithdrawToken, ixSetRewardMode, REWARD_MODE_SOL, REWARD_MODE_SPL,
} from "../lib/dual.ts";
import { confirm } from "../lib/rpc.ts";
import { fmtTokens, fmtLamports } from "../lib/format.ts";
import { Sol, Stat, PriceChip } from "../components/ui.tsx";
import { Window } from "../components/os/index.ts";
import { SharePriceChart } from "../components/Indexed.tsx";
import { indexerEnabled } from "../lib/indexer.ts";

export function DualLpPanel() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const { entries } = useDualFloor(8000);
  const [selected, setSelected] = useState<string | null>(null);
  const machine = selected ?? entries?.[0]?.pubkey.toBase58() ?? null;
  const { status, refresh: refreshM } = useDualMachine(machine ?? undefined, 6000);
  const { lp, refresh: refreshLp } = useDualLp(machine ?? undefined, publicKey ?? null, 6000);

  const [depositChip, setDepositChip] = useState("100");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "good" | "bad"; text: string } | null>(null);

  const m = machine ? new PublicKey(machine) : null;
  const dec = status?.tokenDecimals ?? 9;
  const parseChip = (s: string): bigint | null => { const n = Number(s); return isFinite(n) && n > 0 ? BigInt(Math.round(n * 10 ** dec)) : null; };

  async function send(label: string, build: () => Transaction) {
    if (!publicKey) return;
    setBusy(label); setMsg(null);
    try {
      const sig = await sendTransaction(build(), connection);
      await confirm(connection, sig, label);
      setMsg({ kind: "good", text: `${label} confirmed` });
      await Promise.all([refreshM(), refreshLp()]);
    } catch (e) { setMsg({ kind: "bad", text: `${label} failed: ${(e as Error).message}` }); }
    finally { setBusy(null); }
  }

  if (!entries || entries.length === 0) return null;
  const spl = lp?.rewardMode === REWARD_MODE_SPL;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
        <h2 style={{ fontSize: 24 }}>Dual-asset machines</h2>
        {status && <PriceChip kind={status.price.kind} label={status.price.label} title={status.price.reason} />}
      </div>
      <p className="muted" style={{ margin: 0, maxWidth: 680 }}>
        Dual machines take a <b>SOL</b> wager and pay a <b>CHIP</b> prize. The whole wager is house
        income — there's no SOL payout side — so 100% of it accrues to LPs as a per-share <b>SOL
        dividend</b>. You provide the CHIP bankroll the prizes are paid from.
      </p>

      {entries.length > 1 && (
        <div className="row" style={{ gap: 10 }}>
          <span className="tag">machine</span>
          <select className="btn sm" value={machine ?? ""} onChange={(e) => setSelected(e.target.value)} style={{ minWidth: 220 }}>
            {entries.map((e) => <option key={e.pubkey.toBase58()} value={e.pubkey.toBase58()}>{e.status.name}</option>)}
          </select>
        </div>
      )}

      {msg && <div className={`note ${msg.kind}`}>{msg.text}</div>}

      {status && m && (
        <div className="grid" style={{ gridTemplateColumns: "1.1fr 0.9fr", alignItems: "start", gap: 16 }}>
          {/* left: position + actions */}
          <div className="stack" style={{ gap: 16 }}>
            <Window icon="◈" title="Your position" bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {!connected || !lp?.exists || lp.shares === 0n ? (
                <div className="muted">No position on this machine yet.</div>
              ) : (
                <>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <Stat k="token value"><span className="mono">{fmtTokens(lp.tokenValue, dec, 3)}</span> <span className="faint">CHIP</span></Stat>
                    <Stat k="pending SOL dividend"><Sol lamports={lp.pendingSol} dp={6} /></Stat>
                  </div>
                  <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                    <Stat k="shares"><span className="mono" style={{ fontSize: 12 }}>{fmtLamports(lp.shares)}</span></Stat>
                    <Stat k="reward mode"><span className="mono">{spl ? "SPL (compound)" : "SOL (claim)"}</span></Stat>
                  </div>
                  {spl && lp.earmarkedSol > 0n && (
                    <div className="note" style={{ fontSize: 13 }}>Earmarked for compounding: <Sol lamports={lp.earmarkedSol} dp={6} /> — a permissionless epoch crank swaps it into CHIP shares.</div>
                  )}
                  {lp.pendingShares > 0n && (
                    <div className="note warn stack" style={{ gap: 4 }}>
                      <div>Pending withdrawal: <span className="mono">{fmtLamports(lp.pendingShares)}</span> shares (~{fmtTokens(lp.pendingTokenValue, dec, 3)} CHIP + SOL dividend)</div>
                      <div className="faint" style={{ fontSize: 12.5 }}>epoch {lp.pendingEpoch.toString()} · {lp.processableNow ? "processable now" : `after slot ${lp.nextBoundarySlot.toString()}`}</div>
                    </div>
                  )}
                </>
              )}

              {connected && (
                <>
                  <div className="hr" />
                  <div className="stack" style={{ gap: 6 }}>
                    <span className="tag">deposit CHIP <span className="faint">· price-free</span></span>
                    <div className="row" style={{ gap: 8 }}>
                      <input className="input" value={depositChip} onChange={(e) => setDepositChip(e.target.value)} inputMode="decimal" style={{ maxWidth: 150 }} />
                      <span className="faint">CHIP</span>
                      <button className="btn gold" disabled={busy !== null || !parseChip(depositChip)} onClick={() => {
                        const amt = parseChip(depositChip); if (!amt || !status) return;
                        send("deposit", () => new Transaction().add(ixLpDepositToken(m, publicKey!, ata(publicKey!, new PublicKey(status.tokenMint)), new PublicKey(status.tokenVault), amt)));
                      }}>{busy === "deposit" ? "…" : "Deposit"}</button>
                    </div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      Deposit is <b>price-free</b> — shares are minted against the token vault directly, never
                      through an oracle, so a deposit can't be sandwiched on price. You need CHIP in your wallet.
                    </div>
                  </div>

                  {/* reward mode */}
                  {lp?.exists && lp.shares > 0n && (
                    <div className="stack" style={{ gap: 6 }}>
                      <span className="tag">reward mode</span>
                      <div className="row" style={{ gap: 8 }}>
                        <button className={`btn sm ${!spl ? "gold" : "ghost"}`} disabled={busy !== null || !spl} onClick={() => send("set_reward_mode", () => new Transaction().add(ixSetRewardMode(m, publicKey!, REWARD_MODE_SOL)))}>SOL — claim</button>
                        <button className={`btn sm ${spl ? "gold" : "ghost"}`} disabled={busy !== null || spl} onClick={() => send("set_reward_mode", () => new Transaction().add(ixSetRewardMode(m, publicKey!, REWARD_MODE_SPL)))}>SPL — compound</button>
                      </div>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        {!spl
                          ? <button className="btn" disabled={busy !== null || (lp.pendingSol === 0n)} onClick={() => send("claim_sol", () => new Transaction().add(ixClaimSol(m, publicKey!)))}>Claim SOL dividend</button>
                          : <button className="btn" disabled={busy !== null || (lp.pendingSol === 0n)} onClick={() => send("earmark_sol", () => new Transaction().add(ixEarmarkSol(m, publicKey!)))}>Earmark for compounding</button>}
                      </div>
                    </div>
                  )}

                  {/* withdraw */}
                  {lp?.exists && lp.shares > 0n && (
                    <div className="stack" style={{ gap: 6 }}>
                      <span className="tag">request withdrawal <span className="faint">· epoch-gated · pays BOTH assets</span></span>
                      <div className="faint" style={{ fontSize: 12 }}>
                        The token side pays the epoch's conservative price snapshot (the vault valued
                        as if every pending spin pays its max), frozen per epoch — so it is
                        order-independent and any surplus favors the LPs who stay; the SOL dividend is
                        exact per-share. Exit while spins are in flight and you are priced for the worst
                        case.
                      </div>
                      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        {[25, 50, 100].map((pct) => (
                          <button key={pct} className="btn sm" disabled={busy !== null} onClick={() => send("request_withdraw_token", () => new Transaction().add(ixRequestWithdrawToken(m, publicKey!, (lp.shares * BigInt(pct)) / 100n)))}>{pct}%</button>
                        ))}
                      </div>
                      <div className="faint" style={{ fontSize: 12 }}>Processing pays your CHIP share <b>and</b> your SOL dividend pro-rata — <b>price-free</b> (no oracle in the withdrawal path, so it's manipulation-immune).</div>
                    </div>
                  )}
                  {lp?.exists && lp.pendingShares > 0n && (
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      <button className="btn" disabled={busy !== null} onClick={() => send("cancel_withdraw_token", () => new Transaction().add(ixCancelWithdrawToken(m, publicKey!)))}>Cancel request</button>
                      {lp.processableNow && status && (
                        <button className="btn neon" disabled={busy !== null} onClick={() => send("process_withdrawal_token", () => new Transaction().add(
                          ixCreateAtaIdempotent(publicKey!, publicKey!, new PublicKey(status.tokenMint)),
                          ixProcessWithdrawalToken(m, publicKey!, ata(publicKey!, new PublicKey(status.tokenMint)), new PublicKey(status.tokenVault), publicKey!),
                        ))}>Process my withdrawal</button>
                      )}
                    </div>
                  )}
                </>
              )}
            </Window>
          </div>

          {/* right: honest disclosures */}
          <div className="stack" style={{ gap: 14 }}>
            <Window icon="◈" title="Reward modes, honestly" bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="note stack" style={{ gap: 4 }}>
                <span style={{ fontWeight: 800 }}>SOL — claim anytime</span>
                <span style={{ fontSize: 13 }}>Your share of the house edge accrues as SOL you can <b>claim_sol</b> whenever. Simple; you hold SOL.</span>
              </div>
              <div className="note stack" style={{ gap: 4 }}>
                <span style={{ fontWeight: 800 }}>SPL — compound into CHIP</span>
                <span style={{ fontSize: 13 }}>
                  Your dividend is <b>earmarked</b> instead of paid. A <b>permissionless epoch crank</b> swaps the
                  earmarked SOL into CHIP through <b>one band-bounded</b> Raydium swap (refused if the price is
                  out of band) and mints it into your shares at the pre-swap price.
                </span>
                <span style={{ fontSize: 12.5, color: "var(--gold)" }}>
                  Honest side effect: SPL mode is <b>recurring on-chain buy pressure for CHIP</b> — every compound
                  is a real market buy. Good for CHIP holders, but it means your yield is only as liquid as the pool.
                </span>
              </div>
            </Window>

            <Window icon="◈" title="What you're taking on" bodyStyle={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="note bad stack" style={{ gap: 4 }}>
                <span style={{ fontWeight: 800 }}>Token-denominated risk</span>
                <span style={{ fontSize: 13 }}>
                  Your position is denominated in <b>CHIP</b>, not SOL. On top of ordinary bankroll variance (a
                  jackpot pays up to the exposure cap of the vault), your share value <b>moves with CHIP's own
                  market price</b>. If CHIP falls against SOL, your position is worth less in SOL terms even if the
                  vault is flat. You hold two risks at once: house variance <i>and</i> the token's market.
                </span>
              </div>
              {indexerEnabled() && m
                ? <><div className="hr" /><SharePriceChart machine={m.toBase58()} kind="dual" /></>
                : <div className="faint" style={{ fontSize: 12 }}>Trailing share-price history and annualized drawdown need an indexer — not shown rather than faked.</div>}
            </Window>
          </div>
        </div>
      )}
    </div>
  );
}
