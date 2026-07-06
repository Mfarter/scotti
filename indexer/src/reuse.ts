// The single reuse boundary. The indexer NEVER re-derives an account layout or a
// line of house-math: everything decoding/numeric comes from the canonical node
// home under ../scripts — the exact code scripts/verify-spin.ts runs — re-exported
// here so the rest of the indexer imports from one place.
//
// The only thing not already exported from ../scripts is the DualMachine /
// DualPendingSpin decoder (verify-spin.ts reads those fields inline); it lives in
// ./dual-decode.ts, ported verbatim from the pinned offsets in app/src/lib/dual.ts.
export {
  ixDisc,
  decodeMachine,
  epochLengthEff,
  smoothedUpdate,
  reelsFromRandomness,
  spinPayout,
  payoutBp,
  realizedRtpBp,
  kBoundsConst,
  maxMultBp,
  BP,
  STOPS,
  DEEP,
  SHALLOW,
  DEEP_NUM,
  SHALLOW_NUM,
  SYMBOL_NAME,
  type Machine,
  type Tier,
} from "../../scripts/common.ts";

export { collectObservations, computeTwap } from "../../scripts/twap.ts";
export { decodePool, base58 } from "../../scripts/layouts.ts";
