import { Link } from "react-router-dom";
import { useFloor, useDualFloor, DualFloorEntry } from "../lib/hooks.ts";
import { MachineStatus } from "../lib/status.ts";
import { fmtPctBp, fmtSol, fmtTokens, heatColor, rtpHeat } from "../lib/format.ts";
import { TierBadge, PriceChip } from "../components/ui.tsx";
import { Window, SectionHeader, StatCell, StaleChip } from "../components/os/index.ts";

export function Floor() {
  const { entries, error, stale, lastUpdated } = useFloor();
  const { entries: dualEntries } = useDualFloor();
  return (
    <div className="stack" style={{ gap: 24 }}>
      <header className="stack" style={{ gap: 14 }}>
        <SectionHeader kicker="The floor · live on devnet" title="Find the cold machine." titleSize={38}
          subline="Every machine's odds are a published function of its pool depth. Sorted by live realized RTP — the warmer the wash, the better the odds right now." />
        {stale && entries && <div className="row"><StaleChip lastUpdated={lastUpdated} /></div>}
        <div className="note warn" style={{ maxWidth: 720 }}>
          <b>The mechanic:</b> cold, shallow pools pay closer to the 97% ceiling; deep pools drop to
          the 92% floor but unlock the bigger-jackpot (500×) tier. Same house edge — different odds
          and different volatility.
        </div>
      </header>

      {/* Full-panel error only on a cold start (no data). Once we have a list, a
          rate-limit shows the amber chip above and keeps the pools rendered. */}
      {error && !entries && <div className="note bad">Couldn't reach the RPC: {error}. Set <code>VITE_RPC_URL</code> to a devnet endpoint.</div>}
      {!entries && !error && <div className="muted spin-anim">Reading the floor…</div>}
      {entries && entries.length === 0 && <div className="note">No machines found for this program on devnet.</div>}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(310px, 1fr))" }}>
        {entries?.map((e) => <MachineCard key={e.pubkey.toBase58()} s={e.status} />)}
        {dualEntries?.map((e) => <DualMachineCard key={e.pubkey.toBase58()} e={e} />)}
      </div>

      {dualEntries && dualEntries.length > 0 && (
        <div className="note" style={{ maxWidth: 720 }}>
          <b>Dual-asset machines</b> take a SOL wager and pay a token (CHIP) prize, priced by the
          pool's on-chain TWAP. Their price-status chip is the machine's own commit gate, computed in
          your browser from the live pool — <b>LIVE</b> (fresh &amp; in-band), <b>PRICE UNSTABLE</b>
          (spot drifted past the band), or <b>STALE</b> (the price feed went quiet).
        </div>
      )}
    </div>
  );
}

/** A big serif RTP numeral over a mono kicker — the machine's headline read. */
function RtpReadout({ value, kicker, sub }: { value: string; kicker: string; sub?: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 14, alignItems: "baseline" }}>
      <div className="num" style={{ fontFamily: "var(--serif)", fontWeight: 700, fontSize: 42, lineHeight: 1, color: "var(--ink)" }}>{value}</div>
      <div className="stack" style={{ gap: 0 }}>
        <span className="tag">{kicker}</span>
        {sub != null && <span className="faint" style={{ fontSize: 12 }}>{sub}</span>}
      </div>
    </div>
  );
}

function DualMachineCard({ e }: { e: DualFloorEntry }) {
  const s = e.status;
  const live = s.price.kind === "LIVE";
  const heat = s.realizedRtpBp !== null ? rtpHeat(s.realizedRtpBp) : 0.5;
  const wash = heatColor(heat, live ? 0.5 : 0.16);
  return (
    <Link to={`/dual/${s.machine}`} style={{ display: "block" }}>
      <Window dotted icon="◈" title={s.name}
        right={<>
          {s.paused && <span className="badge paused">Paused</span>}
          <PriceChip kind={s.price.kind} label={s.price.label} title={s.price.reason} />
        </>}
        bodyStyle={{ display: "flex", flexDirection: "column", gap: 16, position: "relative", overflow: "hidden" }}>
        <div aria-hidden style={{ position: "absolute", inset: 0, background: `radial-gradient(150px 110px at 88% -10%, ${wash}, transparent 70%)`, pointerEvents: "none" }} />
        <span className="tag" style={{ color: "var(--ink2)" }}>dual · pays CHIP</span>
        <RtpReadout value={s.realizedRtpBp !== null ? fmtPctBp(s.realizedRtpBp) : "—"} kicker="realized RTP"
          sub={<>band {fmtPctBp(s.rtpFloorBp, 0)}–{fmtPctBp(s.rtpMaxBp, 0)}</>} />
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <StatCell k="pool depth">{fmtTokens(s.tokenBalance, s.tokenDecimals, 0)} CHIP</StatCell>
          <StatCell k="depth value">{s.tokenValueLamports !== null ? `${fmtSol(s.tokenValueLamports, 3)} SOL` : "—"}</StatCell>
          <StatCell k="spot">{s.price.spot !== null ? `${s.price.spot.toFixed(1)} CHIP/SOL` : "—"}</StatCell>
          <StatCell k="max bet">{s.maxBetLamports !== null ? `${fmtSol(s.maxBetLamports, 5)} SOL` : "—"}</StatCell>
        </div>
        <div className="row" style={{ gap: 6, color: "var(--gold)", fontWeight: 700, fontSize: 12.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>Play this machine →</div>
      </Window>
    </Link>
  );
}

function MachineCard({ s }: { s: MachineStatus }) {
  const heat = rtpHeat(s.realizedRtpBp);
  const wash = heatColor(heat, 0.5);
  return (
    <Link to={`/machine/${s.machine}`} style={{ display: "block" }}>
      <Window dotted icon="◇" title={s.name}
        right={<TierBadge tier={s.tier} topMult={s.topMult} paused={s.paused} />}
        bodyStyle={{ display: "flex", flexDirection: "column", gap: 16, position: "relative", overflow: "hidden" }}>
        <div aria-hidden style={{ position: "absolute", inset: 0, background: `radial-gradient(150px 110px at 88% -10%, ${wash}, transparent 70%)`, pointerEvents: "none" }} />
        <RtpReadout value={fmtPctBp(s.realizedRtpBp)} kicker="realized RTP" sub={<>k {s.kBp.toString()}</>} />
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <StatCell k="pool depth">{fmtSol(s.poolValue, 3)} SOL</StatCell>
          <StatCell k="max bet">{fmtSol(s.maxBet, 5)} SOL</StatCell>
          <StatCell k="share price">{(Number(s.sharePrice1e12) / 1e12).toPrecision(4)}</StatCell>
          <StatCell k="free liquidity">{fmtSol(s.freeLiquidity, 3)} SOL</StatCell>
        </div>
        <div className="row" style={{ gap: 6, color: "var(--gold)", fontWeight: 700, fontSize: 12.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>Play this machine →</div>
      </Window>
    </Link>
  );
}
