import { H2_ARTIFACTS } from "../lib/artifacts.ts";
import { fmtLamports } from "../lib/format.ts";
import { VerifyButton } from "../components/Verify.tsx";
import { Solscan } from "../components/ui.tsx";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 16, alignItems: "flex-start" }}>
      <div style={{ flex: "none", width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", background: "rgba(245,196,81,0.1)", color: "var(--gold)", fontWeight: 900, fontFamily: "var(--display)" }}>{n}</div>
      <div className="stack" style={{ gap: 4 }}>
        <h3 style={{ fontSize: 18 }}>{title}</h3>
        <div className="muted" style={{ fontSize: 14.5 }}>{children}</div>
      </div>
    </div>
  );
}

export function Fair() {
  return (
    <div className="stack" style={{ gap: 26, maxWidth: 820 }}>
      <header className="stack" style={{ gap: 8 }}>
        <div className="eyebrow">Fair?</div>
        <h1 style={{ fontSize: 38 }}>Don't trust. Verify.</h1>
        <p className="muted" style={{ margin: 0 }}>
          Every input to a Scotti spin is public and on-chain, so anyone can recompute any spin from
          chain data alone. Here's the whole trust story, and a button that does exactly that.
        </p>
      </header>

      <div className="card pad stack" style={{ gap: 20 }}>
        <Step n={1} title="Odds are a published function of pool state">
          A machine's payout scaler <span className="mono">k</span> and its tier are a deterministic,
          on-chain function of pool depth (run through an anti-snipe smoothing so a jackpot can't open a
          watchable window). Cold, shallow pools pay near the ceiling; deep pools compress to the floor.
          The band is proven <span className="mono">[92%, 97%]</span> at both extremes — RTP is never ≥ 100%.
        </Step>
        <Step n={2} title="The odds are frozen at commit">
          When you place a wager, the program snapshots <span className="mono">(k, tier, max_payout)</span> from the
          smoothed depth into the spin account. Settlement uses that snapshot — a jackpot landing between
          your commit and your settle cannot re-price your spin.
        </Step>
        <Step n={3} title="Randomness is Switchboard On-Demand (TEE)">
          Your commit binds a Switchboard randomness account seeded one slot earlier; a TEE-backed oracle
          reveals 32 bytes you couldn't have predicted. Those bytes map to three reel positions exactly as
          the on-chain <span className="mono">reels_from_randomness</span> does. (This is a hardware-trust
          assumption — stated plainly, not hidden.)
        </Step>
        <Step n={4} title="You can recompute it yourself">
          Given the machine params, the frozen snapshot, and the revealed randomness, the payout is fully
          determined. The Verify buttons below re-read the randomness account and the settle transaction
          straight from the chain and check the recomputed payout equals what was actually paid.
        </Step>
      </div>

      <div className="stack" style={{ gap: 12 }}>
        <h2 style={{ fontSize: 24 }}>Three real spins, verify them now</h2>
        <p className="muted" style={{ margin: 0 }}>
          The first public spins settled on this program (a house win, a full loss, and a 12× player win),
          live on devnet against real Switchboard randomness. Nothing here trusts our word — each button
          recomputes from chain data in your browser.
        </p>
        {H2_ARTIFACTS.map((a) => (
          <div key={a.settleSig} className="panel pad stack" style={{ gap: 10 }}>
            <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
              <div className="mono" style={{ fontWeight: 700 }}>{a.reels.join(" · ")}</div>
              <div className="muted mono" style={{ fontSize: 13 }}>
                wager {fmtLamports(BigInt(a.wager))} · payout {fmtLamports(BigInt(a.payout))} · {a.tier}
              </div>
            </div>
            <VerifyButton refData={a} />
            <div className="row" style={{ gap: 14, flexWrap: "wrap", fontSize: 13 }}>
              <Solscan tx={a.commitSig}>commit</Solscan>
              <Solscan acct={a.randomnessAccount}>randomness account</Solscan>
            </div>
          </div>
        ))}
      </div>

      <div className="stack" style={{ gap: 12 }}>
        <h2 style={{ fontSize: 24 }}>Dual-asset machines (SOL in, CHIP out)</h2>
        <p className="muted" style={{ margin: 0 }}>
          A dual machine takes a SOL wager and pays a <b>token</b> (CHIP) prize, priced by the pool's
          on-chain price. The same "verify everything" discipline applies, with three extra guards
          worth stating plainly (full detail in <b>H6-DUAL-ASSET-SPEC.md</b>).
        </p>
        <div className="card pad stack" style={{ gap: 20 }}>
          <Step n={1} title="Priced at the TWAP, not the spot">
            The prize is priced at a <span className="mono">time-weighted average price</span> snapshotted at
            commit — never the instantaneous spot. A single-block price wick can't move your payout, and (like
            the single-asset odds) the snapshot is frozen: a price move between commit and settle can't re-price it.
          </Step>
          <Step n={2} title="Two gates — the machine refuses rather than misprice">
            The commit is gated by <b>staleness</b> (the newest observation must be fresh — else <b>STALE</b>) and a
            <b> band</b> (spot must sit within <span className="mono">band_bp</span> of the TWAP — else <b>PRICE
            UNSTABLE</b>). Out of gate, the machine <i>refuses the spin</i>; it never pays at a manipulated price.
            The Floor's price-status chip computes this exact gate in your browser from the live pool.
          </Step>
          <Step n={3} title="Haircut reserve — every prize is pre-funded">
            At commit the machine reserves the worst-case payout (the JACKPOT³ line) plus a <b>haircut</b> from the
            token vault, and proves that reserve covers every outcome. So a booked spin can always be paid; the
            unused remainder releases at settle.
          </Step>
          <Step n={4} title="A margin floor that survives the worst case">
            Even at the machine's maximum RTP <i>and</i> spot at the very top of the band, the effective payout stays
            bounded: <span className="mono">95% × (1 + 3%) = 97.85% ≤ 98%</span>. <span className="mono">create_machine_dual</span> validates
            this invariant on-chain, so the house keeps a <b>≥ 2% margin</b> no matter where price sits in the band.
          </Step>
          <Step n={5} title="Effective RTP at spot — the honest hedge">
            Because the prize is priced at the TWAP but you receive CHIP worth the <i>spot</i>, your effective return is
            <span className="mono"> nominal RTP × spot/TWAP</span>. When spot is below the TWAP it reads <b>below</b> nominal;
            above, above. The machine page shows this live and never clamps it — the price hedge, stated both ways.
          </Step>
        </div>
      </div>

      <div className="note stack" style={{ gap: 6 }}>
        <span style={{ fontWeight: 800, fontFamily: "var(--display)" }}>Session chips</span>
        <span style={{ fontSize: 14 }}>
          To skip a wallet prompt on every spin, you can buy <b>chips</b>: one wallet confirmation
          funds an ephemeral key that then plays and auto-settles without prompts. That key's secret
          is stored in <b>this browser</b> — anyone with access to this browser profile can spend the
          chips, and clearing site data without cashing out loses them. Your exposure is bounded by
          the buy-in. Cash out sweeps the balance back to your wallet and clears the key. Devnet only,
          so this is a convenience demo — a mainnet build would scope and expire such keys far more
          tightly.
        </span>
      </div>

      <div className="note stack" style={{ gap: 6 }}>
        <span style={{ fontWeight: 800, fontFamily: "var(--display)" }}>Chain-read data vs. the indexer</span>
        <span style={{ fontSize: 14 }}>
          Almost everything on this site is a <b>direct chain read</b>: the odds, the pool state, the price gate,
          and every spin you run and verify are computed in your browser from on-chain accounts — trustless, no
          middleman. The one exception is the optional <b>share-price history chart</b> and the <b>recent-spins
          feed</b>, which are served by the <b>Scotti indexer</b> — an <b>off-chain service</b>. That data is
          convenient but not trustless: it is served by an operator who could omit or reorder rows. To keep it
          honest, the indexer <b>recomputes every spin at ingest</b> from the same chain data and stores the
          result, so each row in the feed shows its <b>recompute status</b> (verified / partial / unverifiable) —
          and you can always re-verify any spin in-browser yourself. Same register as the session-chips custody
          note above: a convenience, with its trust boundary stated plainly.
        </span>
      </div>

      <div className="note warn stack" style={{ gap: 6 }}>
        <span style={{ fontWeight: 800, fontFamily: "var(--display)" }}>The posture, in plain language</span>
        <span style={{ fontSize: 14 }}>
          Scotti is a <b>devnet demonstration</b> of verifiable, state-dependent house games and pooled
          bankrolls. It uses test tokens with <b>no real value</b>. It is <b>not a licensed gambling
          product</b> and not an investment. Real-money operation would be a licensed-casino activity and a
          pooled investment product at once — deliberately out of scope. The randomness rests on a hardware
          (TEE) trust assumption; the fairness proof makes outcomes verifiable, not trustless.
        </span>
      </div>
    </div>
  );
}
