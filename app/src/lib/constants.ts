import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey("EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ");
export const SOL = 1_000_000_000n;

// devnet-only module. Public RPC works but is rate-limited; set VITE_RPC_URL.
// Optional-chained so the module also imports cleanly under node (tests/harness).
export const RPC_URL = (import.meta.env?.VITE_RPC_URL as string | undefined) ?? "https://api.devnet.solana.com";
export const CLUSTER = "devnet" as const;

// Switchboard On-Demand (devnet).
export const SB_DEVNET_PID = new PublicKey("Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2");
export const SB_DEVNET_QUEUE = new PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7");

export const DEMO_MACHINE_LABEL = "house-demo-1";

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=${CLUSTER}`;
export const solscanAcct = (a: PublicKey | string) => `https://solscan.io/account/${a.toString()}?cluster=${CLUSTER}`;

export const lamportsToSol = (x: bigint, dp = 6) => (Number(x) / Number(SOL)).toFixed(dp);
