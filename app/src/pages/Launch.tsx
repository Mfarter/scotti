// VAULT-1 launch wizard (/launch) — permissionless dual-vault creation, wallet-
// signed. Four steps (each a Window): TOKEN → POOL SET → PARAMS → REVIEW+LAUNCH.
// Every client check MIRRORS the on-chain enforcement (checkPoolMember,
// validateParams, the margin floor) and NEVER replaces it — if the tx still
// fails, the raw program error is shown. Tx building mirrors
// scripts/vault1-live-proof.ts exactly (ixCreateVault).
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ComputeBudgetProgram, PublicKey, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Buffer } from "buffer";
import { Window, SectionHeader, StatCell, GlossButton } from "../components/os/index.ts";
import { PriceChip, Solscan } from "../components/ui.tsx";
import { fmtSol, shortKey } from "../lib/format.ts";
import { solscanAcct } from "../lib/constants.ts";
import { TOKEN_PROGRAM_ID } from "../lib/dual.ts";
import { priceStatus, poolObservationId, type PriceStatus } from "../lib/clmm.ts";
import { sleep } from "../lib/rpc.ts";
import {
  checkPoolMember, ixCreateVault, vaultMachineId, vaultMachinePda, poolSetPda,
  fetchMintRegistry, type MemberCheck, MAX_POOLS,
} from "../lib/poolset.ts";
import { DEFAULT_PARAMS, CLAMPS, validateParams, quorumOf, type VaultParams, type ParamIssue } from "../lib/vaultspec.ts";

// ---------- token (SPL mint) validation ----------
export interface TokenInfo { mint: string; decimals: number; supply: bigint; ok: boolean; error: string | null }
async function loadToken(conn: import("@solana/web3.js").Connection, mint: string): Promise<TokenInfo> {
  let key: PublicKey;
  try { key = new PublicKey(mint); } catch { return { mint, decimals: 0, supply: 0n, ok: false, error: "not a valid address" }; }
  const info = await conn.getAccountInfo(key);
  if (!info) return { mint, decimals: 0, supply: 0n, ok: false, error: "account not found on devnet" };
  if (!info.owner.equals(TOKEN_PROGRAM_ID)) return { mint, decimals: 0, supply: 0n, ok: false, error: "not an SPL Token mint (wrong owner)" };
  if (info.data.length < 82 || info.data[45] !== 1) return { mint, decimals: 0, supply: 0n, ok: false, error: "not an initialized mint" };
  const d = Buffer.from(info.data);
  return { mint, decimals: d[44], supply: d.readBigUInt64LE(36), ok: true, error: null };
}

// ---------- a validated pool-set member ----------
export interface Member {
  poolKey: PublicKey; obsKey: PublicKey | null;
  check: MemberCheck; status: PriceStatus | null; loading: boolean;
  // FIX-4: an account couldn't be FETCHED (RPC error / not-yet-indexed), which is
  // NOT the same as a fetched account with the wrong owner. When true the UI shows
  // a "couldn't verify — retry" affordance, never the ownership rejection.
  fetchFailed?: boolean;
}

// FIX-4: resilient single-account fetch. getAccountInfo returns null for a missing
// account AND (a lagging node) for a freshly-created one, and throws on RPC errors;
// retry on BOTH null and throw so a transient/lag doesn't masquerade as "wrong
// owner". Returns the account, or null if it truly can't be read after `tries`.
async function fetchAccount(conn: import("@solana/web3.js").Connection, key: PublicKey, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const info = await conn.getAccountInfo(key); if (info) return info; }
    catch { /* RPC error — retry */ }
    if (i < tries - 1) await sleep(600 * (i + 1));
  }
  return null;
}

// DEV-ONLY: the screenshot harness injects fabricated wizard state so each step can
// be captured deterministically without live RPC/clicks (never used in production).
export interface WizardInitial { step?: number; token?: TokenInfo; members?: Member[]; params?: VaultParams; label?: string; takenBy?: string }

export function LaunchWizard({ initial }: { initial?: WizardInitial } = {}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();

  const [step, setStep] = useState(initial?.step ?? 0);
  const [tokenInput, setTokenInput] = useState(initial?.token?.mint ?? "");
  const [token, setToken] = useState<TokenInfo | null>(initial?.token ?? null);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [takenBy, setTakenBy] = useState<string | null>(initial?.takenBy ?? null); // VAULT-3: mint already has a vault

  const [members, setMembers] = useState<Member[]>(initial?.members ?? []);
  const [poolInput, setPoolInput] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const [params, setParams] = useState<VaultParams>(initial?.params ?? { ...DEFAULT_PARAMS });
  const [label, setLabel] = useState(initial?.label ?? "");

  const [launchState, setLaunchState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [launchErr, setLaunchErr] = useState<string | null>(null);
  const [createdSig, setCreatedSig] = useState<string | null>(null);
  const [rentLamports, setRentLamports] = useState<bigint | null>(null);

  const setLen = members.length;
  const paramsWithDec = useMemo<VaultParams>(() => ({ ...params, tokenDecimals: token?.decimals ?? params.tokenDecimals }), [params, token]);
  const issues: ParamIssue[] = useMemo(() => validateParams(paramsWithDec, setLen || 1), [paramsWithDec, setLen]);
  const issueFor = (key: string) => issues.find((i) => i.key === key);

  const machineId = useMemo(() => vaultMachineId(label || "vault"), [label]);
  const machinePk = useMemo(() => vaultMachinePda(machineId), [machineId]);

  // rent estimate for the three inited accounts (DualMachine 409, PoolSet 394, ATA 165).
  useEffect(() => {
    let alive = true;
    Promise.all([409, 394, 165].map((n) => connection.getMinimumBalanceForRentExemption(n)))
      .then((r) => { if (alive) setRentLamports(BigInt(r[0] + r[1] + r[2]) + 10_000n); }).catch(() => {});
    return () => { alive = false; };
  }, [connection]);

  async function validateToken() {
    setTokenBusy(true);
    try {
      const t = await loadToken(connection, tokenInput.trim());
      setToken(t);
      // VAULT-3 courtesy: if this mint already has a vault, block here and link to it
      // (the chain enforces one-vault-per-mint regardless of this check).
      setTakenBy(t.ok ? (await fetchMintRegistry(connection, new PublicKey(t.mint)))?.machine.toBase58() ?? null : null);
    } finally { setTokenBusy(false); }
  }

  // FIX-4: validate one pool with the fetch/owner states kept DISTINCT. A null fetch
  // (after retries) → fetchFailed ("couldn't verify — retry"), never the ownership
  // rejection; only a successfully-FETCHED account whose owner ≠ CLMM gets that.
  async function validatePool(poolKey: PublicKey, already: PublicKey[]): Promise<Member> {
    const failed = (reason: string, obsKey: PublicKey | null = null): Member => ({
      poolKey, obsKey, status: null, loading: false, fetchFailed: true,
      check: { ok: false, clmmOwned: false, pairsMint: false, crossLinked: false, distinct: true, mintA: null, mintB: null, observation: null, reasons: [reason] },
    });
    const poolInfo = await fetchAccount(connection, poolKey);
    if (!poolInfo) return failed("couldn't verify this pool — the RPC returned nothing (rate-limited, or the pool isn't indexed yet). This is a network state, not a rejection — retry.");
    const poolData = Buffer.from(poolInfo.data);
    const obsKey = poolData.length >= 233 ? poolObservationId(poolData) : null;
    const obsInfo = obsKey ? await fetchAccount(connection, obsKey) : null;
    if (obsKey && !obsInfo) return failed("couldn't verify this pool's observation account — the RPC returned nothing. Retry.", obsKey);
    const obsData = obsInfo ? Buffer.from(obsInfo.data) : null;
    const check = checkPoolMember(poolKey, poolInfo.owner, poolData, obsKey ?? PublicKey.default, obsInfo?.owner ?? null, obsData, new PublicKey(token!.mint), already);
    const now = Math.floor(Date.now() / 1000);
    const status = obsData ? priceStatus(poolData, obsData, now, DEFAULT_PARAMS.twapWindowSecs, DEFAULT_PARAMS.maxStalenessSecs, DEFAULT_PARAMS.bandBp) : null;
    return { poolKey, obsKey, check, status, loading: false };
  }

  async function addPool() {
    if (!token?.ok) return;
    setAddBusy(true);
    try {
      let poolKey: PublicKey;
      try { poolKey = new PublicKey(poolInput.trim()); } catch {
        setMembers((m) => [...m, badMember(poolInput.trim(), "not a valid address")]); setPoolInput(""); return;
      }
      const member = await validatePool(poolKey, members.map((m) => m.poolKey));
      setMembers((m) => [...m, member]); setPoolInput("");
    } finally { setAddBusy(false); }
  }
  // FIX-4: re-run validation for a member that couldn't be fetched (the retry affordance).
  async function retryMember(i: number) {
    if (!token?.ok) return;
    setMembers((m) => m.map((x, j) => (j === i ? { ...x, loading: true } : x)));
    const member = await validatePool(members[i].poolKey, members.filter((_, j) => j !== i).map((m) => m.poolKey));
    setMembers((m) => m.map((x, j) => (j === i ? member : x)));
  }
  const removeMember = (i: number) => setMembers((m) => m.filter((_, j) => j !== i));

  async function launch() {
    if (!publicKey || !token?.ok || setLen < 1) return;
    setLaunchState("sending"); setLaunchErr(null);
    try {
      const memberAccts = members.map((m) => ({ pool: m.poolKey, observation: m.obsKey! }));
      const ix = ixCreateVault(machineId, publicKey, new PublicKey(token.mint), paramsWithDec, memberAccts);
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({
        payerKey: publicKey, recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ix],
      }).compileToV0Message();
      const sig = await sendTransaction(new VersionedTransaction(msg), connection);
      await connection.confirmTransaction(sig, "confirmed");
      setCreatedSig(sig); setLaunchState("done");
    } catch (e) { setLaunchErr((e as Error).message); setLaunchState("error"); }
  }

  const oddSet = setLen === 1 || setLen === 3 || setLen === 5;
  const allValid = members.length > 0 && members.every((m) => m.check.ok);
  const canGoParams = !!token?.ok && allValid;
  const canReview = canGoParams && issues.length === 0 && label.trim().length > 0;

  return (
    <div className="stack" style={{ gap: 22 }}>
      <SectionHeader kicker="Launch · permissionless" title="Launch a vault." titleSize={38}
        subline="Create your own SOL-in / token-out vault, priced by a set of 1–5 CLMM pools. Rent only — no protocol fee. You become the curator with pause rights only; the odds params are clamped and immutable." />
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {["Token", "Pool set", "Params", "Review & launch"].map((s, i) => (
          <span key={s} className={`os-chip ${i === step ? "sage" : i < step ? "peach" : "neutral"}`}>{i + 1}. {s}</span>
        ))}
        <span className="os-grow" />
        <Link className="link on-fresco" to="/docs">Read the builder docs →</Link>
      </div>

      {/* STEP 1 — TOKEN */}
      {step === 0 && (
        <Window icon="◈" title="1 · Payout token" bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p className="muted" style={{ margin: 0 }}>Paste the SPL mint your vault pays out. We read its decimals and supply straight from the chain.</p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="input mono" style={{ flex: "1 1 420px" }} placeholder="token mint address" value={tokenInput}
              onChange={(e) => { setTokenInput(e.target.value); setToken(null); setTakenBy(null); }} />
            <GlossButton onClick={validateToken} disabled={tokenBusy || !tokenInput.trim()}>{tokenBusy ? "Checking…" : "Validate"}</GlossButton>
          </div>
          {token && !token.ok && <div className="note bad">Not usable: {token.error}.</div>}
          {token?.ok && (
            <>
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))" }}>
                <StatCell k="mint"><Solscan acct={token.mint} /></StatCell>
                <StatCell k="decimals">{token.decimals}</StatCell>
                <StatCell k="supply">{(Number(token.supply) / 10 ** token.decimals).toLocaleString()}</StatCell>
              </div>
              {takenBy ? (
                <div className="note bad stack" style={{ gap: 8 }}>
                  <b>This token already has a vault.</b> Only one vault may exist per payout mint — the chain enforces
                  it, so a create for this mint would fail at the registry.
                  <Link className="btn gold sm" to={`/dual/${takenBy}`}>Open the existing vault →</Link>
                </div>
              ) : (
                <div className="row"><GlossButton variant="pink" onClick={() => setStep(1)}>Next — pool set →</GlossButton></div>
              )}
            </>
          )}
        </Window>
      )}

      {/* STEP 2 — POOL SET */}
      {step === 1 && (
        <Window icon="◈" title="2 · Pool set (1–5 CLMM pools)" bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="note warn">
            <b>Use an odd set — 1, 3, or 5 pools.</b> The price is the <b>median</b> of the pools, gated by a majority quorum.
            With an <b>even</b> set (2 or 4), an attacker controlling <b>exactly half</b> the pools can move the median — one pool
            short of the guarantee. Odd sets need a strict majority to move, so a minority can never budge the price.
          </div>
          <p className="muted" style={{ margin: 0 }}>Paste a Raydium CLMM pool address; we derive its observation account and validate it the way the program will.</p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input className="input mono" style={{ flex: "1 1 420px" }} placeholder="CLMM pool address" value={poolInput}
              onChange={(e) => setPoolInput(e.target.value)} disabled={setLen >= MAX_POOLS} />
            <GlossButton onClick={addPool} disabled={addBusy || !poolInput.trim() || setLen >= MAX_POOLS}>{addBusy ? "Checking…" : "Add pool"}</GlossButton>
          </div>
          {setLen >= MAX_POOLS && <div className="faint">Maximum of {MAX_POOLS} pools reached.</div>}

          <div className="stack" style={{ gap: 10 }}>
            {members.map((m, i) => (
              <div key={i} className="panel pad stack" style={{ gap: 8 }}>
                <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
                  <div className="row" style={{ gap: 10, alignItems: "center" }}>
                    <span className="tag">pool {i + 1}</span>
                    <Solscan acct={m.poolKey.toBase58()} />
                    {m.loading ? <span className="os-chip neutral spin-anim">verifying…</span>
                      : m.fetchFailed ? <span className="os-chip amber">couldn't verify</span>
                      : m.status ? <PriceChip kind={m.status.kind} label={m.status.commitAllowed ? "eligible" : m.status.label} title={m.status.reason} /> : null}
                  </div>
                  <div className="row" style={{ gap: 8 }}>
                    {m.fetchFailed && <button className="btn sm" onClick={() => retryMember(i)} disabled={m.loading}>retry</button>}
                    <button className="btn sm ghost" onClick={() => removeMember(i)}>remove</button>
                  </div>
                </div>
                {m.loading ? <div className="faint" style={{ fontSize: 12 }}>re-reading the pool + observation from the chain…</div>
                  : m.fetchFailed
                    ? <div className="note warn" style={{ fontSize: 12.5 }}>{m.check.reasons.join(" · ")}</div>
                  : m.check.ok
                    ? <div className="faint mono" style={{ fontSize: 12 }}>✓ CLMM-owned · pairs the mint · cross-linked · distinct{m.status?.twap != null ? ` · twap ${m.status.twap.toFixed(1)} CHIP/SOL` : ""}</div>
                    : <div className="note bad" style={{ fontSize: 12.5 }}>{m.check.reasons.join(" · ")}</div>}
              </div>
            ))}
          </div>

          {setLen > 0 && (
            <div className="note" style={{ fontSize: 13 }}>
              This is a <b>{setLen}-pool</b> {oddSet ? "(odd — recommended)" : "(even — see the warning above)"} set; the on-chain
              quorum will be <b>{quorumOf(setLen)} of {setLen}</b>.
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <GlossButton onClick={() => setStep(0)}>← Token</GlossButton>
            <GlossButton variant="pink" onClick={() => setStep(2)} disabled={!canGoParams}>Next — params →</GlossButton>
          </div>
          {!allValid && setLen > 0 && <div className="faint">Every pool must pass validation before continuing.</div>}
        </Window>
      )}

      {/* STEP 3 — PARAMS */}
      {step === 2 && (
        <Window icon="◈" title="3 · Parameters (clamped)" bodyStyle={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <p className="muted" style={{ margin: 0 }}>
            These are prefilled with the proven live-vault profile. Every field is clamped on-chain; a value out of range names
            the exact program error it would hit. The <b>margin floor</b> is checked live.
          </p>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="stack" style={{ gap: 4, flex: "1 1 200px" }}>
              <span className="tag">vault name (machine id)</span>
              <input className="input mono" placeholder="my-vault" value={label} maxLength={16} onChange={(e) => setLabel(e.target.value)} />
            </label>
          </div>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <NumField label="RTP ceiling (bp)" value={params.rtpMaxBp} onChange={(v) => setParams({ ...params, rtpMaxBp: v })} issue={issueFor("rtpMaxBp")} />
            <NumField label="Price band (bp)" value={params.bandBp} onChange={(v) => setParams({ ...params, bandBp: v })} issue={issueFor("bandBp")} />
            <NumField label="Margin floor (bp)" value={params.mBp} onChange={(v) => setParams({ ...params, mBp: v })} issue={issueFor("mBp")} />
            <NumField label="Haircut reserve (bp)" value={params.haircutBp} onChange={(v) => setParams({ ...params, haircutBp: v })} issue={issueFor("haircutBp")} />
            <NumField label="TWAP window (s)" value={params.twapWindowSecs} onChange={(v) => setParams({ ...params, twapWindowSecs: v })} issue={issueFor("twapWindowSecs")} />
            <NumField label="Max staleness (s)" value={params.maxStalenessSecs} onChange={(v) => setParams({ ...params, maxStalenessSecs: v })} issue={issueFor("maxStalenessSecs")} />
            <NumField label="Max exposure (bp)" value={params.maxExposureBp} onChange={(v) => setParams({ ...params, maxExposureBp: v })} issue={issueFor("maxExposureBp")} />
            <NumField label="Max pending spins" value={params.maxPendingSpins} onChange={(v) => setParams({ ...params, maxPendingSpins: v })} issue={issueFor("maxPendingSpins")} />
          </div>
          <div className="note" style={{ fontSize: 12.5 }}>
            token decimals <b>{token?.decimals ?? "—"}</b> (from the mint) · depth knees d_low/d_mid/d_high and the smoothing/epoch
            windows use the live-vault defaults (advanced; edit in the constants module).
          </div>
          {issues.length > 0
            ? <div className="note bad"><b>Not launchable yet:</b> {issues.map((i) => `${i.key}: ${i.message}`).join(" · ")}</div>
            : <div className="note good">All parameters satisfy the on-chain clamps and the margin-floor invariant.</div>}
          <div className="row" style={{ gap: 8 }}>
            <GlossButton onClick={() => setStep(1)}>← Pool set</GlossButton>
            <GlossButton variant="pink" onClick={() => setStep(3)} disabled={!canReview}>Next — review →</GlossButton>
          </div>
          {!label.trim() && <div className="faint">Give the vault a short name to continue.</div>}
        </Window>
      )}

      {/* STEP 4 — REVIEW + LAUNCH */}
      {step === 3 && (
        <div className="stack" style={{ gap: 16 }}>
          <Window icon="◈" title="4 · Review" bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <StatCell k="name">{label}</StatCell>
              <StatCell k="vault PDA"><span className="mono">{shortKey(machinePk.toBase58())}</span></StatCell>
              <StatCell k="payout token"><Solscan acct={token!.mint} /></StatCell>
              <StatCell k="pool set">{setLen} pools · quorum {quorumOf(setLen)}</StatCell>
              <StatCell k="RTP ceiling">{(params.rtpMaxBp / 100).toFixed(0)}%</StatCell>
              <StatCell k="band / floor">{params.bandBp}bp / {params.mBp}bp</StatCell>
              <StatCell k="rent (you pay)">{rentLamports !== null ? `${fmtSol(rentLamports, 5)} SOL` : "…"}</StatCell>
              <StatCell k="protocol fee">none</StatCell>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              {members.map((m, i) => <div key={i} className="row" style={{ gap: 8 }}><span className="tag">pool {i + 1}</span><Solscan acct={m.poolKey.toBase58()} /></div>)}
            </div>
          </Window>

          <Window icon="⚠" title="Before you launch — the disclosure" bodyStyle={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <ul className="stack" style={{ gap: 6, margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
              <li><b>Devnet demonstration only.</b> Test tokens, no real value.</li>
              <li>You become the <b>curator with pause rights ONLY</b> — you can halt spins, and nothing else. You cannot change the odds, drain the vault, or touch LP funds.</li>
              <li>The parameters are <b>immutable and clamped</b> — set once at creation, inside the protocol-safe ranges, and never editable.</li>
              <li>Running a token-denominated house with real value is <b>licensed-casino-plus-token-issuance activity</b> — the regulated thing itself, not a gray zone. This is a demonstration, not a product.</li>
            </ul>
          </Window>

          {!connected ? (
            <div className="stack" style={{ gap: 10, alignItems: "flex-start" }}>
              <div className="muted">Connect a wallet to sign the creation transaction (you pay the rent).</div>
              <WalletMultiButton />
            </div>
          ) : launchState === "done" && createdSig ? (
            <Window icon="✓" title="Vault created" bodyStyle={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="note good">Your vault is live on devnet and will appear on the Floor and in the Liquidity table automatically.</div>
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                <Link className="btn gold" to={`/dual/${machinePk.toBase58()}`}>Open the vault page →</Link>
                <Solscan tx={createdSig}>creation tx</Solscan>
                <a className="link mono" href={solscanAcct(machinePk.toBase58())} target="_blank" rel="noreferrer">vault {shortKey(machinePk.toBase58())} ↗</a>
                <a className="link mono" href={solscanAcct(poolSetPda(machinePk).toBase58())} target="_blank" rel="noreferrer">pool set ↗</a>
              </div>
            </Window>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row" style={{ gap: 8 }}>
                <GlossButton onClick={() => setStep(2)}>← Params</GlossButton>
                <GlossButton variant="pink" big onClick={launch} disabled={launchState === "sending"}>
                  {launchState === "sending" ? "Creating…" : "Create the vault (pay rent)"}
                </GlossButton>
              </div>
              {launchState === "error" && launchErr && (
                <div className="note bad"><b>The transaction failed.</b> {launchErr}<div className="faint" style={{ fontSize: 12, marginTop: 4 }}>Client checks can't catch everything — this is the raw program/RPC error.</div></div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function badMember(_key: string, reason: string): Member {
  return { poolKey: PublicKey.default, obsKey: null, loading: false, status: null,
    check: { ok: false, clmmOwned: false, pairsMint: false, crossLinked: false, distinct: true, mintA: null, mintB: null, observation: null, reasons: [reason] } };
}

function NumField({ label, value, onChange, issue }: { label: string; value: number; onChange: (v: number) => void; issue?: ParamIssue }) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="tag">{label}</span>
      <input className="input mono" type="number" value={value} onChange={(e) => onChange(Number(e.target.value))}
        style={issue ? { borderColor: "var(--bad, #c0483b)" } : undefined} />
      {issue && <span className="faint" style={{ fontSize: 11.5, color: "var(--bad, #c0483b)" }}>{issue.message} → {issue.error}</span>}
    </label>
  );
}

// re-export CLAMPS type usage so the docs and wizard share the module (referenced
// in /docs); nothing to compute here — the single source of truth is vaultspec.ts.
export { CLAMPS };
