import { Link } from "react-router-dom";
import { useFloor } from "../lib/hooks.ts";
import { MachineStatus } from "../lib/status.ts";
import { fmtPctBp, fmtSol, heatColor, rtpHeat } from "../lib/format.ts";
import { TierBadge } from "../components/ui.tsx";

export function Floor() {
  const { entries, error } = useFloor();
  return (
    <div className="stack" style={{ gap: 24 }}>
      <header className="stack" style={{ gap: 8 }}>
        <div className="eyebrow">The floor · live on devnet</div>
        <h1 style={{ fontSize: 40 }}>Find the cold machine.</h1>
        <p className="muted" style={{ maxWidth: 620, margin: 0 }}>
          Every machine's odds are a published function of its pool depth. Sorted by live realized
          RTP — the hotter the glow, the better the odds right now.
        </p>
        <div className="note warn" style={{ maxWidth: 720 }}>
          <b>The mechanic:</b> cold, shallow pools pay closer to the 97% ceiling; deep pools drop to
          the 92% floor but unlock the bigger-jackpot (500×) tier. Same house edge — different odds
          and different volatility.
        </div>
      </header>

      {error && <div className="note bad">Couldn't reach the RPC: {error}. Set <code>VITE_RPC_URL</code> to a devnet endpoint.</div>}
      {!entries && !error && <div className="muted spin-anim">Reading the floor…</div>}
      {entries && entries.length === 0 && <div className="note">No machines found for this program on devnet.</div>}

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {entries?.map((e) => <MachineCard key={e.pubkey.toBase58()} s={e.status} />)}
      </div>
    </div>
  );
}

function MachineCard({ s }: { s: MachineStatus }) {
  const heat = rtpHeat(s.realizedRtpBp);
  const glow = heatColor(heat);
  return (
    <Link to={`/machine/${s.machine}`} className="card pad stack" style={{ gap: 16, position: "relative", overflow: "hidden" }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, background: `radial-gradient(120px 90px at 85% 0%, ${heatColor(heat, 0.18)}, transparent 70%)`, pointerEvents: "none" }} />
      <div className="spread">
        <h3 style={{ fontSize: 21 }}>{s.name}</h3>
        <TierBadge tier={s.tier} topMult={s.topMult} paused={s.paused} />
      </div>
      <div className="row" style={{ gap: 14, alignItems: "baseline" }}>
        <div style={{ fontFamily: "var(--display)", fontWeight: 900, fontSize: 44, lineHeight: 1, color: glow, textShadow: `0 0 26px ${heatColor(heat, 0.5)}` }} className="num">
          {fmtPctBp(s.realizedRtpBp)}
        </div>
        <div className="stack" style={{ gap: 0 }}>
          <span className="tag">realized RTP</span>
          <span className="faint" style={{ fontSize: 12 }}>k {s.kBp.toString()}</span>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Mini k="pool depth" v={`${fmtSol(s.poolValue, 3)} SOL`} />
        <Mini k="max bet" v={`${fmtSol(s.maxBet, 5)} SOL`} />
        <Mini k="share price" v={`${(Number(s.sharePrice1e12) / 1e12).toPrecision(4)}`} />
        <Mini k="free liquidity" v={`${fmtSol(s.freeLiquidity, 3)} SOL`} />
      </div>
      <div className="row" style={{ gap: 6, color: "var(--gold)", fontWeight: 700, fontSize: 14 }}>Play this machine →</div>
    </Link>
  );
}

function Mini({ k, v }: { k: string; v: string }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <span className="tag">{k}</span>
      <span className="num" style={{ fontWeight: 600 }}>{v}</span>
    </div>
  );
}
