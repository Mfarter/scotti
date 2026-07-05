// The devnet floor manifest — one source of truth for every machine's band,
// placement, and founding seed. bootstrap-machines.ts creates and seeds any that
// are missing (idempotent). The three are placed at visibly different points on
// their k-curves so the Floor shows a real RTP spread, and differ in tier so the
// depth↔volatility axis is legible: two shallow (50× frequent-win) at the
// ceiling and mid-band, one deep (500× jackpot) at the floor.
import { SOL } from "./common.ts";

export interface MachineSpec {
  label: string;
  dLow: bigint; dMid: bigint; dHigh: bigint;
  maxExposureBp: bigint; smoothWindow: bigint; epochLength: bigint;
  seedLamports: bigint;
  // placement note (README / floor copy)
  placement: string;
}

export const MACHINES: MachineSpec[] = [
  {
    // existing, untouched. seed ~1.0 SOL, band 0.5/2/10 → depth 1.0 sits just
    // above d_low → k near k_max → ~96.7%, SHALLOW (50× top).
    label: "house-demo-1",
    dLow: SOL / 2n, dMid: 2n * SOL, dHigh: 10n * SOL,
    maxExposureBp: 100n, smoothWindow: 9_000n, epochLength: 1_350n,
    seedLamports: SOL,
    placement: "near ceiling · SHALLOW · ~96.7%",
  },
  {
    // seed 0.3 SOL, band 0.1/0.4/0.5 → depth 0.3 is the exact midpoint of
    // [d_low, d_high] → k ≈ midpoint → ~94.5%, SHALLOW (< d_mid, 50× top).
    label: "Cold Comfort",
    dLow: SOL / 10n, dMid: (4n * SOL) / 10n, dHigh: SOL / 2n,
    maxExposureBp: 100n, smoothWindow: 9_000n, epochLength: 1_350n,
    seedLamports: (3n * SOL) / 10n,
    placement: "mid-band · SHALLOW · ~94.5%",
  },
  {
    // seed 1.2 SOL, band 0.05/0.2/0.5 → depth 1.2 ≥ d_high → k = k_min → ~92%
    // (floor), and ≥ d_mid → DEEP tier (500× jackpot profile).
    label: "Leviathan",
    dLow: SOL / 20n, dMid: SOL / 5n, dHigh: SOL / 2n,
    maxExposureBp: 100n, smoothWindow: 9_000n, epochLength: 1_350n,
    seedLamports: (12n * SOL) / 10n,
    placement: "at the floor · DEEP · ~92% · 500× jackpot",
  },
];
