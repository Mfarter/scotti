// Env-driven config. Every value has a default so the service runs with none set.
import { PublicKey } from "@solana/web3.js";

const env = (k: string, d: string) => process.env[k] ?? d;

export const RPC_URL = env("RPC_URL", "https://api.devnet.solana.com");
export const PROGRAM_ID_STR = env("PROGRAM_ID", "EewsDJqfDEEfF8mKhQRED6NSB987LhkKL9wawjM7SBQ");
export const PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);
export const INTERVAL_SECS = Number(env("INTERVAL", "60"));
export const DB_PATH = env("DB_PATH", "./scotti-indexer.db");
export const PORT = Number(env("PORT", "8787"));

// How far back the spin-feed backfill reaches per pass. Devnet public RPC returns
// getSignaturesForAddress in pages of up to 1000; the whole program history today
// fits in one page, so we page until exhausted (bounded for safety).
export const MAX_SIG_PAGES = Number(env("MAX_SIG_PAGES", "20"));
