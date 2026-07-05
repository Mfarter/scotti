import { useCallback, useEffect, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import { useConnection } from "@solana/wallet-adapter-react";
import { Buffer } from "buffer";
import { listMachines } from "./rpc.ts";
import { computeMachineStatus, MachineStatus, lpStatus, LpStatus } from "./status.ts";
import { decodeMachine } from "./program.ts";

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
