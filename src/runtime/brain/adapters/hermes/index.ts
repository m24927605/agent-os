/**
 * Hermes brain adapter — vendor barrel. Re-exports ONLY the shim class and its injected turn-source
 * seam (+ the turn DTO types). Deliberately NOT re-exported from the brain package barrel
 * (src/runtime/brain/index.ts): a vendor adapter is wired by the composition root, never surfaced as
 * part of the neutral port API.
 */
export {
  type HermesMemoryOp,
  type HermesSkillOp,
  type HermesToolCall,
  type HermesTurn,
  type HermesTurnSource,
  HermesBrainShim,
} from "./shim.js";
