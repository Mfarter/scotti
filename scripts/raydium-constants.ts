// Raydium CLMM devnet constants — H6a ground-truth spike.
//
// SOURCE OF TRUTH for program ids: the Raydium SDK v2 `programId.ts`, read
// verbatim (not from memory — the spec §2 warns the remembered devnet id
// `devi51mZmdwUJGU9hjN27vEz64Gps7uUefqxg27EAtH` is a documented trap; Raydium
// migrated devnet to `DRay…` vanity addresses).
//   https://raw.githubusercontent.com/raydium-io/raydium-sdk-V2/master/src/common/programId.ts
//   (DEVNET_PROGRAM_ID block, lines ~99–134, fetched 2026-07-05)
//
// ON-CHAIN VERIFICATION (devnet, 2026-07-05):
//   CLMM program DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH
//     owner       = BPFLoaderUpgradeab1e11111111111111111111111
//     executable  = true
//     programData = Dfhg7W2iDF6Kmoefx4XNaSMd7MvpNeR7Dg8HkZ6rCTwW (1,470,141 bytes)
//     upgrade authority = DRayw6sn9fCvbhx5ZLtAVGAgAk6qAAX7UT7urzkXTeM5
//   → live, maintained, and permissionless for pool creation. NOT a dead shell.
import { PublicKey } from "@solana/web3.js";

/** Raydium Concentrated Liquidity Market Maker — DEVNET program id. */
export const CLMM_PROGRAM_ID = new PublicKey("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH");

/** Devnet CLMM ancillary programs (from the same SDK devnet block). */
export const CLMM_LOCK_PROGRAM_ID = new PublicKey("DRay25Usp3YJAi7beckgpGUC7mGJ2cR1AVPxhYfwVCUX");
export const CLMM_LOCK_AUTH_ID = new PublicKey("6Aoh8h2Lw2m5UGxYR8AdAL87jTWYeKoxM52mJRzfYwN");

/** Mainnet CLMM id, for reference / to make the devnet≠mainnet split explicit. */
export const CLMM_PROGRAM_ID_MAINNET = new PublicKey("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK");

/** WSOL mint (same on all clusters). */
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// ---------------------------------------------------------------------------
// Demo market — created on devnet 2026-07-05 (scripts/create-clmm-pool.ts +
// seed-clmm-lp.ts). Pool orientation: mintA = WSOL, mintB = CHIP, so the pool's
// internal price is CHIP-per-SOL (initialised at 1000, i.e. 1 CHIP = 0.001 SOL).
// Seeded 0.3 WSOL + 266.02 CHIP concentrated in ticks [63970, 74950]
// (≈ 600–1800 CHIP/SOL). AmmConfig index 2: tickSpacing 10, 0.05% fee.
// ---------------------------------------------------------------------------

/** Scotti Chip (CHIP) — the demo SPL token, 9 decimals, 10,000,000 supply. */
export const CHIP_MINT = new PublicKey("75zyWBYdFSNNFKDaTdEu9nZWdHaZCuuCd7tgCCxi2w6p");
/** PoolState (CLMM pool id). */
export const CLMM_POOL = new PublicKey("9n6LAVickwVAnDL4rHUZXAXkoMSG5794fKRgrXSfXn1n");
/** ObservationState — cumulative-tick TWAP ring buffer for this pool. */
export const OBSERVATION_STATE = new PublicKey("7nPBDXZVazj9w4GsuwjHx3qF5EffQCpvSKPj9p55QsgU");
/** Pool vaults (mintA = WSOL, mintB = CHIP). */
export const POOL_VAULT_A_WSOL = new PublicKey("3EUFyDquUtefjCbBzVb4u489XULqedKH14LJxwU57Fi9");
export const POOL_VAULT_B_CHIP = new PublicKey("EhArexxoDzkBeymW5UuJJvRPMLn6AZMTTzZ2nvHMHz1S");
export const AMM_CONFIG = new PublicKey("FZdkW5jiYsjTnCVqFqPrxrQisQkCYrohd7ArZhoKnM8q");
