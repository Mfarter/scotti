import { useMemo, useSyncExternalStore } from "react";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "buffer";
import { connection } from "./rpc.ts";
import { PROGRAM_ID } from "./constants.ts";
import { acctDisc, decodeMachine } from "./program.ts";
import { computeMachineStatus, MachineStatus, lpStatus, LpStatus } from "./status.ts";
import { decodeDualMachine } from "./dual.ts";
import { computeDualStatus, DualStatus, fetchDualStatus, fetchDualLp, DualLpView, loadExtraMembers } from "./dualstatus.ts";
import { PollStore, StoreState, EMPTY_STATE, keyedStore } from "./pollstore.ts";

export interface FloorEntry { pubkey: PublicKey; status: MachineStatus; }
export interface DualFloorEntry { pubkey: PublicKey; status: DualStatus; }

// -------------------- useSyncExternalStore glue --------------------
const NOOP = () => () => {};
const getEmpty = () => EMPTY_STATE;
function useStore<T>(store: PollStore<T> | null): StoreState<T> {
  const sub = store ? store.subscribe : NOOP;
  const snap = (store ? store.getState : getEmpty) as () => StoreState<T>;
  return useSyncExternalStore(sub, snap, snap);
}

// -------------------- the floor: ONE program scan for single + dual --------------------
// A single getProgramAccounts (the rate-limited call) enumerates every program
// account; we split single vs dual client-side by the Anchor discriminator the
// decoders already define — no decoder change, and the two floor scans that used
// to be separate polls are now one shared poll.
async function fetchFloor(): Promise<{ singles: FloorEntry[]; duals: DualFloorEntry[] }> {
  const conn = connection();
  const all = await conn.getProgramAccounts(PROGRAM_ID);
  const mDisc = acctDisc("Machine"), dDisc = acctDisc("DualMachine");
  const disc = (data: Buffer) => data.subarray(0, 8);
  const singleAccts = all.filter((a) => disc(Buffer.from(a.account.data)).equals(mDisc));
  const dualAccts = all.filter((a) => disc(Buffer.from(a.account.data)).equals(dDisc));

  const slot = await conn.getSlot("confirmed");
  const s = BigInt(slot);
  const singles: FloorEntry[] = singleAccts
    .map((a) => ({ pubkey: a.pubkey, status: computeMachineStatus(a.pubkey, decodeMachine(Buffer.from(a.account.data)), s) }))
    .sort((a, b) => Number(b.status.realizedRtpBp - a.status.realizedRtpBp));

  const duals: DualFloorEntry[] = [];
  if (dualAccts.length > 0) {
    const now = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
    const dms = dualAccts.map((a) => ({ pubkey: a.pubkey, machine: decodeDualMachine(Buffer.from(a.account.data)) }));
    const keys = dms.flatMap((e) => [e.machine.pool, e.machine.observation]);
    // member 0 (m.pool/m.observation) is in the batched read; pool-set vaults also
    // fetch their PoolSet + members 1..n (a small extra read for the few set vaults).
    const [infos, extras] = await Promise.all([
      conn.getMultipleAccountsInfo(keys),
      Promise.all(dms.map((e) => loadExtraMembers(conn, e.pubkey, e.machine).catch(() => undefined))),
    ]);
    dms.forEach((e, i) => {
      const pool = infos[2 * i], obs = infos[2 * i + 1];
      if (pool && obs) duals.push({ pubkey: e.pubkey, status: computeDualStatus(e.pubkey, e.machine, Buffer.from(pool.data), Buffer.from(obs.data), now, s, extras[i]) });
    });
  }
  return { singles, duals };
}
export const floorStore = new PollStore(fetchFloor, 18000);

/** Single-asset floor. Shares one program scan with useDualFloor (same store).
 * `stale`/`lastUpdated` drive the "RPC rate-limited — retrying" chip; the last-good
 * list is kept rendered across failures. The pollMs arg is accepted for source
 * compatibility but the shared store owns the interval. */
export function useFloor(_pollMs?: number) {
  const st = useStore(floorStore);
  return { entries: st.data?.singles ?? null, error: st.error, stale: st.stale, lastUpdated: st.lastUpdated, refresh: () => floorStore.refreshNow() };
}

/** Dual-asset floor — the other half of the shared floor store. */
export function useDualFloor(_pollMs?: number) {
  const st = useStore(floorStore);
  return { entries: st.data?.duals ?? null, error: st.error, stale: st.stale, lastUpdated: st.lastUpdated, refresh: () => floorStore.refreshNow() };
}

// -------------------- focused per-machine / per-position reads --------------------
async function fetchMachineStatus(pubkey: string): Promise<MachineStatus> {
  const conn = connection();
  const key = new PublicKey(pubkey);
  const [info, slot] = await Promise.all([conn.getAccountInfo(key), conn.getSlot("confirmed")]);
  if (!info) throw new Error("machine not found");
  return computeMachineStatus(key, decodeMachine(Buffer.from(info.data)), BigInt(slot));
}

export function useMachine(pubkey: string | undefined, pollMs = 8000) {
  const store = useMemo(() => (pubkey ? keyedStore(`machine:${pubkey}`, () => fetchMachineStatus(pubkey), pollMs) : null), [pubkey, pollMs]);
  const st = useStore(store);
  return { status: st.data, error: st.data ? null : st.error, stale: st.stale, lastUpdated: st.lastUpdated, refresh: () => store?.refreshNow() };
}

export function useDualMachine(pubkey: string | undefined, pollMs = 8000) {
  const store = useMemo(() => (pubkey ? keyedStore(`dualmachine:${pubkey}`, () => fetchDualStatus(connection(), new PublicKey(pubkey)), pollMs) : null), [pubkey, pollMs]);
  const st = useStore(store);
  return { status: st.data, error: st.data ? null : st.error, stale: st.stale, lastUpdated: st.lastUpdated, refresh: () => store?.refreshNow() };
}

export function useLp(machine: string | undefined, owner: PublicKey | null, pollMs = 8000) {
  const ownerStr = owner ? owner.toBase58() : null;
  const store = useMemo(
    () => (machine && ownerStr ? keyedStore<LpStatus>(`lp:${machine}:${ownerStr}`, () => lpStatus(connection(), new PublicKey(machine), new PublicKey(ownerStr)), pollMs) : null),
    [machine, ownerStr, pollMs],
  );
  const st = useStore(store);
  return { lp: st.data, stale: st.stale, refresh: () => store?.refreshNow() };
}

export function useDualLp(machine: string | undefined, owner: PublicKey | null, pollMs = 8000) {
  const ownerStr = owner ? owner.toBase58() : null;
  const store = useMemo(
    () => (machine && ownerStr ? keyedStore<DualLpView>(`duallp:${machine}:${ownerStr}`, () => fetchDualLp(connection(), new PublicKey(machine), new PublicKey(ownerStr)), pollMs) : null),
    [machine, ownerStr, pollMs],
  );
  const st = useStore(store);
  return { lp: st.data, stale: st.stale, refresh: () => store?.refreshNow() };
}

// -------------------- shared slot (StatusBar) --------------------
const slotStore = new PollStore<number>(() => connection().getSlot("confirmed"), 12000);
export function useSlot(): number | null {
  return useStore(slotStore).data;
}
