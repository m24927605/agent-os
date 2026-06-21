/**
 * model → estimatedTokens cost map — feeds the FOURTH chokepoint (CostGate reserve) of the
 * inference routing gate (docs/design/inference-routing-gate.md §2.2 step 4, §4.2). Pure lookup,
 * no I/O, no vendor.
 *
 * The map only ever produces a vendor-neutral TOKEN COUNT (CostGate.reserve takes `estimatedTokens`,
 * never currency — design §4.2): real pricing lives inside the SpendGuard adapter, not here, so the
 * core stays credential-blind and vendor-neutral.
 *
 * Two invariants hold by construction:
 *   - fail-closed: a model NOT present in the map has NO estimate, so it returns `ok:false`. The gate
 *     turns "no estimate" into a deny — we never default to a free (0-token) or guessed estimate that
 *     could let an unpriced model slip past the budget gate.
 *   - reason-does-not-leak: the failure reason is static gate text — it never echoes the model id
 *     (which could be attacker-influenced), preserving reason-does-not-leak across the gate.
 */
import type { InferenceRequest } from "./types.js";

/** model id → estimated token count. A `ReadonlyMap` so a gate cannot mutate it mid-decision. */
export type CostMap = ReadonlyMap<string, number>;

export type EstimateResult =
  | { readonly ok: true; readonly tokens: number }
  | { readonly ok: false; readonly reason: string };

const GATE = "inference.cost-map";

/**
 * Look up the token estimate for the request's model. An unknown model (no mapping) is fail-closed:
 * no estimate => `ok:false`, which the gate converts into a deny (never a silent free pass).
 */
export function estimateTokens(req: InferenceRequest, costMap: CostMap): EstimateResult {
  const tokens = costMap.get(req.model);
  if (tokens === undefined) {
    // fail-closed: an unpriced model has no estimate and must be denied — never defaulted to 0.
    return { ok: false, reason: `${GATE}: no token estimate for model (fail-closed)` };
  }
  return { ok: true, tokens };
}
