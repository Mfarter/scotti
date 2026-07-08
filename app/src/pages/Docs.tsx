// VAULT-2 /docs — the builder docs, Polymarket-builders format in SCOTTI OS
// style: a grouped left-sidebar nav, one section at a time as Windows, benefit
// cards, numbered how-it-works steps, the clamp table rendered from the SHARED
// vaultspec module (the same constants the wizard validates against — one source
// of truth, no duplicated numbers), the pool-set/median/quorum explainer with the
// odd-set recommendation, a launch walkthrough, and prev/next footer links.
import { useState } from "react";
import { Link } from "react-router-dom";
import { Window, SectionHeader, GlossButton } from "../components/os/index.ts";
import { CLAMPS, quorumOf, DUAL_RTP_MIN_BP, DUAL_RTP_MAX_BP, BAND_CAP_BP, MARGIN_FLOOR_BP, MAX_POOLS } from "../lib/vaultspec.ts";

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 14, alignItems: "flex-start" }}>
      <div style={{ flex: "none", width: 34, height: 34, borderRadius: 10, display: "grid", placeItems: "center", background: "var(--gloss-hi), var(--gloss-pink)", border: "1px solid var(--line2)", boxShadow: "var(--inset-top)", color: "var(--ink)", fontWeight: 700, fontFamily: "var(--serif)" }}>{n}</div>
      <div className="stack" style={{ gap: 3 }}>
        <b style={{ fontFamily: "var(--serif)", fontSize: 16 }}>{title}</b>
        <div className="muted" style={{ fontSize: 13.5 }}>{children}</div>
      </div>
    </div>
  );
}
function Benefit({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="panel pad stack" style={{ gap: 6 }}>
      <span aria-hidden style={{ fontSize: 22 }}>{icon}</span>
      <b style={{ fontFamily: "var(--serif)", fontSize: 15 }}>{title}</b>
      <span className="muted" style={{ fontSize: 13 }}>{children}</span>
    </div>
  );
}

interface Section { id: string; group: string; nav: string; title: string; desc: string; body: React.ReactNode }

const SECTIONS: Section[] = [
  {
    id: "overview", group: "Start here", nav: "Overview", title: "Build a vault on Scotti",
    desc: "A permissionless SOL-in / token-out house game, priced by a set of on-chain AMM pools you choose.",
    body: (
      <div className="stack" style={{ gap: 16 }}>
        <p className="muted" style={{ margin: 0 }}>
          A Scotti vault takes a SOL wager and pays a prize in an SPL token you nominate, at odds that are a
          published function of the vault's depth. Anyone can create one — you pay rent, nothing else — and you
          become its curator with pause rights only. The price comes from a <b>set of 1–{MAX_POOLS} Raydium CLMM
          pools</b> of your token, combined by a manipulation-resistant median.
        </p>
        <div className="docs-benefits">
          <Benefit icon="◈" title="Permissionless">No allowlist, no admin. One transaction, rent only — no protocol fee.</Benefit>
          <Benefit icon="⚖" title="Clamped &amp; solvent">Every risk parameter is bounded so no vault can pay above the house floor — proven, not promised.</Benefit>
          <Benefit icon="◫" title="Median-priced">1–5 pools, aggregated by median + quorum. A minority of rigged pools can't move the price.</Benefit>
          <Benefit icon="✓" title="Verifiable">Every spin's payout and price recomputes from chain data in your browser.</Benefit>
        </div>
        <div className="note">Curator rights are <b>pause only</b>: you can halt spins, and nothing else — you cannot change the odds, drain the vault, or touch LP funds.</div>
      </div>
    ),
  },
  {
    id: "how", group: "Start here", nav: "How it works", title: "How a vault prices a spin",
    desc: "The same snapshot discipline as every Scotti game, extended to a pool set.",
    body: (
      <div className="stack" style={{ gap: 18 }}>
        <Step n={1} title="Read each pool's TWAP">Every pool in the set is read the same way: a time-weighted average price from its Raydium observation ring, plus its live spot.</Step>
        <Step n={2} title="Gate each pool">A pool counts only if it's <b>fresh</b> (recent observations) and its spot is within the price <b>band</b> of its own TWAP. Stale or drifting pools are dropped.</Step>
        <Step n={3} title="Take the median, check quorum">The price is the <b>median</b> of the eligible pools' TWAPs. The spin is allowed only if enough pools are eligible to meet a <b>majority quorum</b>.</Step>
        <Step n={4} title="Freeze the odds at commit">k, tier, and the median price are snapshotted at commit. A price move between commit and settle can't re-price your spin — slippage is zero by construction.</Step>
        <Step n={5} title="Pay deterministically, reserve the worst case">Settle pays tokens at the frozen price; a haircut reserve pre-funds the worst outcome so the vault stays solvent through reveal-window drift.</Step>
      </div>
    ),
  },
  {
    id: "poolsets", group: "Pool sets", nav: "Pool sets", title: "Pool sets, median & quorum",
    desc: "Why a set of pools beats a single oracle — and why odd sizes are recommended.",
    body: (
      <div className="stack" style={{ gap: 16 }}>
        <p className="muted" style={{ margin: 0 }}>
          A single price source has a single point of failure: corrupt it and you move the payout. A pool set replaces
          it with the <b>median</b> of up to {MAX_POOLS} pools. To move a median you must corrupt a <b>majority</b> of
          the pools — and each pool still has to pass its own freshness + band gate, so every corrupted pool costs the
          full single-pool manipulation price. The set multiplies the attacker's cost by the honest-majority threshold.
        </p>
        <div className="panel pad stack" style={{ gap: 8 }}>
          <b style={{ fontFamily: "var(--serif)" }}>Quorum by set size</b>
          <div className="mono" style={{ fontSize: 13 }}>
            {[1, 2, 3, 4, 5].map((n) => <span key={n} style={{ display: "inline-block", marginRight: 18 }}>{n} pool{n > 1 ? "s" : ""} → {quorumOf(n)} of {n}</span>)}
          </div>
        </div>
        <div className="note warn">
          <b>Use an odd set — 1, 3, or 5.</b> With an odd set the attacker needs a strict majority to move the median, so a
          minority (fewer than quorum) can never budge the price — the bound proven exhaustively in house-math. With an
          <b> even</b> set (2 or 4), an attacker controlling <b>exactly half</b> the pools can move the median — one pool short
          of the guarantee. Even sets stay solvent (the band + margin floor still bind) but are strictly weaker.
        </div>
        <div className="chip-states row" style={{ gap: 10, flexWrap: "wrap" }}>
          <span className="os-chip sage"><span className="os-chip-dot" />LIVE — quorum met, median priced</span>
          <span className="os-chip amber"><span className="os-chip-dot" />QUORUM NOT MET — too few eligible pools</span>
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>The Floor and each vault page show a live <b>n/m pools</b> read computed in your browser from the pools themselves — the same verdict the on-chain aggregate produces for the same accounts.</p>
      </div>
    ),
  },
  {
    id: "params", group: "Pool sets", nav: "Params & clamps", title: "Parameters & clamps",
    desc: "Every value you set is bounded on-chain; here are the exact ranges and the error each violation raises.",
    body: (
      <div className="stack" style={{ gap: 14 }}>
        <div style={{ overflowX: "auto" }}>
          <table className="docs-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--line2)" }}>
                <th style={{ padding: "8px 10px" }}>Parameter</th><th style={{ padding: "8px 10px" }}>Min</th><th style={{ padding: "8px 10px" }}>Max</th>
                <th style={{ padding: "8px 10px" }}>What it does</th><th style={{ padding: "8px 10px" }}>On violation</th>
              </tr>
            </thead>
            <tbody>
              {CLAMPS.map((c) => (
                <tr key={c.key} style={{ borderBottom: "1px solid var(--line)" }}>
                  <td style={{ padding: "8px 10px", fontWeight: 700 }}>{c.label}</td>
                  <td style={{ padding: "8px 10px" }} className="mono">{c.min ?? "—"}</td>
                  <td style={{ padding: "8px 10px" }} className="mono">{c.max ?? "—"}</td>
                  <td style={{ padding: "8px 10px" }} className="muted">{c.note}</td>
                  <td style={{ padding: "8px 10px" }} className="mono faint">{c.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note">
          <b>The margin floor is the binding invariant.</b> The RTP ceiling ({DUAL_RTP_MIN_BP / 100}–{DUAL_RTP_MAX_BP / 100}%), the
          band cap ({BAND_CAP_BP}bp) and the floor ({MARGIN_FLOOR_BP}bp min) together must satisfy
          <span className="mono"> rtpMax·(BP+band) ≤ (BP−m)·BP</span> — checked live in the wizard and enforced on-chain over
          ~14.6M configurations, so no accepted vault can ever pay above the house floor.
        </div>
        <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>This table is rendered from the same constants module the launch wizard validates against — the numbers are never restated by hand.</p>
      </div>
    ),
  },
  {
    id: "onepermint", group: "Pool sets", nav: "One per token", title: "One vault per token",
    desc: "A payout mint can back at most one vault — enforced atomically on-chain.",
    body: (
      <div className="stack" style={{ gap: 16 }}>
        <p className="muted" style={{ margin: 0 }}>
          Each SPL mint gets a single vault. When you create one, the program also creates a tiny <b>registry
          account</b> keyed by the mint (<span className="mono">["mint-vault", token_mint]</span>); a second create for
          the same mint fails at that account's initialization — atomically, in the same transaction, no race. The
          registry records <b>which</b> vault claimed the mint, so the wizard can point you at it.
        </p>
        <div className="docs-benefits">
          <Benefit icon="◈" title="Atomic">The gate is an account init, not a check-then-write — there's no window for two vaults to slip through.</Benefit>
          <Benefit icon="◫" title="Grandfathered">Vaults created before the registry can be registered permissionlessly; first registration wins.</Benefit>
          <Benefit icon="✓" title="Create-time only">The registry gates CREATION. Existing vaults keep spinning, depositing, and withdrawing regardless.</Benefit>
        </div>
        <div className="note warn">
          <b>The squatting residual (named, not hidden).</b> Vault params are immutable and there is no close
          instruction, so a mint's slot is claimed <b>forever</b> — a rent-only junk vault can permanently squat a
          popular mint. This is accepted for the devnet demonstration, exactly like the even-set tie; a close/reclaim
          design is future work, deliberately out of scope here.
        </div>
      </div>
    ),
  },
  {
    id: "launch", group: "Build", nav: "Launch guide", title: "Launching your vault",
    desc: "The four steps of the wizard, and what each one checks before you sign.",
    body: (
      <div className="stack" style={{ gap: 18 }}>
        <Step n={1} title="Token">Paste your payout SPL mint. The wizard reads its decimals and supply from the chain, confirms it's an initialized mint, and checks the mint registry — if the token already has a vault it links you there and stops (one vault per token).</Step>
        <Step n={2} title="Pool set">Add 1–{MAX_POOLS} Raydium CLMM pool addresses. Each is validated the way the program will — CLMM-owned, pairs your mint, pool↔observation cross-linked, distinct — with a live fresh/stale read so you see what you're linking. Prefer odd sizes.</Step>
        <Step n={3} title="Params">Prefilled with the proven live-vault profile. Every field is clamped; an out-of-range value names the exact program error, and the margin floor is checked live before you can continue.</Step>
        <Step n={4} title="Review & launch">A full summary, the rent estimate, and the creator disclosure — then one wallet signature builds and sends the create_vault transaction. Your vault appears on the Floor and in Liquidity automatically.</Step>
        <div className="row"><Link className="btn gold" to="/launch">Open the launch wizard →</Link></div>
      </div>
    ),
  },
  {
    id: "verify", group: "Build", nav: "Verify everything", title: "Don't trust — verify",
    desc: "Every claim here is checkable; the residuals are named, not hidden.",
    body: (
      <div className="stack" style={{ gap: 14 }}>
        <p className="muted" style={{ margin: 0 }}>
          The price status you see, the quorum verdict, and every spin's payout are recomputed in your browser from the
          raw pool, observation, and spin accounts — the same math the program runs. If the client and the chain ever
          disagree for the same accounts, that's a bug to report, not a number to trust.
        </p>
        <div className="docs-benefits">
          <Benefit icon="◈" title="Per-pool status">The Floor and vault pages classify every pool with the same freshness + band gate the on-chain commit applies.</Benefit>
          <Benefit icon="◫" title="Median verdict">The n/m quorum read mirrors house-math's aggregator exactly — median of the eligible pools, majority gate.</Benefit>
          <Benefit icon="✓" title="Spin recompute">The verifier reconstructs a settled spin and recomputes both the token payout and price_at_commit from chain.</Benefit>
        </div>
        <div className="note">
          The honest residual: with an <b>even</b> pool set, a half-of-set attacker can move the median. It's named in the pool-set
          section and in the wizard, and it's why odd sizes are recommended. Full proofs live in <span className="mono">H6-DUAL-ASSET-SPEC.md §8</span>.
        </div>
        <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
          <Link className="link" to="/fair">The Fair? page →</Link>
          <Link className="link" to="/">Back to the Floor →</Link>
        </div>
      </div>
    ),
  },
];

const GROUPS = ["Start here", "Pool sets", "Build"];

export function Docs() {
  const [active, setActive] = useState(0);
  const sec = SECTIONS[active];
  return (
    <div className="stack" style={{ gap: 22 }}>
      <SectionHeader kicker="Docs · for builders" title="Build on Scotti." titleSize={38}
        subline="Everything you need to launch a permissionless, verifiable house vault — the pool-set pricing, the clamps, and the launch flow." />
      <div className="docs-layout">
        <nav className="docs-nav" aria-label="Docs sections">
          {GROUPS.map((g) => (
            <div key={g} className="stack" style={{ gap: 3 }}>
              <div className="group">{g}</div>
              {SECTIONS.map((s, i) => s.group === g ? (
                <a key={s.id} className={i === active ? "on" : ""} onClick={() => setActive(i)}>{s.nav}</a>
              ) : null)}
            </div>
          ))}
        </nav>

        <div className="stack" style={{ gap: 16, minWidth: 0 }}>
          <Window icon="◆" title={sec.title} bodyStyle={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="subline" style={{ fontSize: 14, color: "var(--ink2)" }}>{sec.desc}</div>
            {sec.body}
          </Window>

          <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
            {active > 0
              ? <GlossButton onClick={() => setActive(active - 1)}>← {SECTIONS[active - 1].nav}</GlossButton>
              : <span />}
            {active < SECTIONS.length - 1
              ? <GlossButton variant="pink" onClick={() => setActive(active + 1)}>{SECTIONS[active + 1].nav} →</GlossButton>
              : <Link className="btn gold" to="/launch">Launch a vault →</Link>}
          </div>
        </div>
      </div>
    </div>
  );
}
