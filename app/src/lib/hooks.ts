import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { Buffer } from "buffer";
import { listMachines } from "./rpc.ts";
import { computeMachineStatus, MachineStatus, lpStatus, LpStatus } from "./status.ts";
import { decodeMachine } from "./program.ts";
import { listDualMachines } from "./dual.ts";
import { computeDualStatus, DualStatus, fetchDualStatus, fetchDualLp, DualLpView } from "./dualstatus.ts";

export interface FloorEntry { pubkey: PublicKey; status: MachineStatus; }

/** Poll every machine (batched: one getProgramAccounts + one getSlot), compute
 * status at a shared slot, sorted by realized RTP descending. */
export function useFloor(pollMs = 5000) {
  const { connection } = useConnection();
  const [entries, setEntries] = useState<FloorEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async (conn: Connection) => {
    try {
      const [machines, slot] = await Promise.all([listMachines(conn), conn.getSlot("confirmed")]);
      const s = BigInt(slot);
      const list = machines
        .map((m) => ({ pubkey: m.pubkey, status: computeMachineStatus(m.pubkey, m.machine, s) }))
        .sort((a, b) => Number(b.status.realizedRtpBp - a.status.realizedRtpBp));
      if (alive.current) { setEntries(list); setError(null); }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load(connection);
    const t = setInterval(() => load(connection), pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [connection, load, pollMs]);

  return { entries, error, refresh: () => load(connection) };
}

/** Poll a single machine's status. */
export function useMachine(pubkey: string | undefined, pollMs = 5000) {
  const { connection } = useConnection();
  const [status, setStatus] = useState<MachineStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    if (!pubkey) return;
    try {
      const key = new PublicKey(pubkey);
      const [info, slot] = await Promise.all([connection.getAccountInfo(key), connection.getSlot("confirmed")]);
      if (!info) throw new Error("machine not found");
      if (alive.current) { setStatus(computeMachineStatus(key, decodeMachine(Buffer.from(info.data)), BigInt(slot))); setError(null); }
    } catch (e) { if (alive.current) setError((e as Error).message); }
  }, [connection, pubkey]);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, pollMs]);

  return { status, error, refresh: load };
}

export interface DualFloorEntry { pubkey: PublicKey; status: DualStatus; }

/** Poll every dual-asset machine (batched: list + one getMultipleAccounts for the
 * pools/observations), price-status computed client-side at a shared cluster time. */
export function useDualFloor(pollMs = 5000) {
  const { connection } = useConnection();
  const [entries, setEntries] = useState<DualFloorEntry[] | null>(null);
  const alive = useRef(true);

  const load = useCallback(async (conn: Connection) => {
    try {
      const list = await listDualMachines(conn);
      if (list.length === 0) { if (alive.current) setEntries([]); return; }
      const slot = await conn.getSlot("confirmed");
      const now = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
      const keys = list.flatMap((e) => [e.machine.pool, e.machine.observation]);
      const infos = await conn.getMultipleAccountsInfo(keys);
      const out: DualFloorEntry[] = [];
      list.forEach((e, i) => {
        const pool = infos[2 * i], obs = infos[2 * i + 1];
        if (pool && obs) out.push({ pubkey: e.pubkey, status: computeDualStatus(e.pubkey, e.machine, Buffer.from(pool.data), Buffer.from(obs.data), now, BigInt(slot)) });
      });
      if (alive.current) setEntries(out);
    } catch { /* transient; keep the last good render */ }
  }, []);

  useEffect(() => {
    alive.current = true; load(connection);
    const t = setInterval(() => load(connection), pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [connection, load, pollMs]);
  return { entries };
}

/** Poll a single dual-asset machine's status (machine + pool + observation). */
export function useDualMachine(pubkey: string | undefined, pollMs = 5000) {
  const { connection } = useConnection();
  const [status, setStatus] = useState<DualStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!pubkey) return;
    try { const s = await fetchDualStatus(connection, new PublicKey(pubkey)); if (alive.current) { setStatus(s); setError(null); } }
    catch (e) { if (alive.current) setError((e as Error).message); }
  }, [connection, pubkey]);
  useEffect(() => {
    alive.current = true; load();
    const t = setInterval(load, pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, pollMs]);
  return { status, error, refresh: load };
}

/** Poll the connected wallet's dual LP position on a machine. */
export function useDualLp(machine: string | undefined, owner: PublicKey | null, pollMs = 5000) {
  const { connection } = useConnection();
  const [lp, setLp] = useState<DualLpView | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!machine || !owner) { setLp(null); return; }
    try { const s = await fetchDualLp(connection, new PublicKey(machine), owner); if (alive.current) setLp(s); }
    catch { /* transient */ }
  }, [connection, machine, owner]);
  useEffect(() => {
    alive.current = true; load();
    const t = setInterval(load, pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, pollMs]);
  return { lp, refresh: load };
}

/** Poll the connected wallet's LP position on a machine. */
export function useLp(machine: string | undefined, owner: PublicKey | null, pollMs = 5000) {
  const { connection } = useConnection();
  const [lp, setLp] = useState<LpStatus | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!machine || !owner) { setLp(null); return; }
    try { const s = await lpStatus(connection, new PublicKey(machine), owner); if (alive.current) setLp(s); }
    catch { /* transient */ }
  }, [connection, machine, owner]);
  useEffect(() => {
    alive.current = true; load();
    const t = setInterval(load, pollMs);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, pollMs]);
  return { lp, refresh: load };
}
