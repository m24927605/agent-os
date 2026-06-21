/**
 * AGT policy adapter — vendor barrel. Re-exports ONLY the adapter class and its injected AGT evaluate
 * seam. Deliberately NOT re-exported from the policy package barrel: a vendor adapter is wired by the
 * composition root, never surfaced as part of the neutral port API (the OS = ports, never a vendor).
 */
export {
  type AgtDecision,
  type AgtEvaluateFn,
  type AgtEvaluationContext,
  AgtSecondaryPolicy,
} from "./adapter.js";
