/**
 * PDP-integration chokepoint — the THIRD gate of the inference routing gate
 * (docs/design/inference-routing-gate.md §2.2 step 3, §4.3 trade-off 3, §5). Pure conversion +
 * forward; no I/O, no vendor.
 *
 * The PDP (`src/policy/evaluate.ts`) is the SOLE deny authority for inference authorization. This
 * adapter does exactly two things and NO MORE:
 *   1. `toPolicyRequest` — turn a vendor-neutral `InferenceRequest` into a `PolicyRequest` with the
 *      fixed action "inference:invoke" and a resource derived from (model, egressHost). The agent
 *      identity ids are carried through verbatim — never fabricated, never dropped — so the PDP
 *      decides against the real principal (a malformed id would make the PDP's own schema parse fail
 *      and thus deny: fail-closed at the PDP).
 *   2. `evaluateInferencePolicy` — forward that PolicyRequest to an INJECTED evaluator and return its
 *      decision UNCHANGED. The PDP function is injected (not imported here) so the gate is not
 *      hard-wired to the PDP implementation (design §4.3 trade-off 3, low coupling).
 *
 * Invariants held by construction:
 *   - SOLE DENY AUTHORITY: a PDP `deny` is returned verbatim; this adapter NEVER flips a deny to an
 *     allow (it only ever flips toward MORE deny, on a throw — fail-safe direction).
 *   - FAIL-CLOSED: if the injected evaluator throws, the result is `deny`, never `allow`.
 *   - REASON-DOES-NOT-LEAK: on a throw the reason is STATIC gate text (it never embeds the thrown
 *     error message, which could echo a request value); a PDP-supplied reason is passed through
 *     unchanged (the PDP already guarantees it carries no request value — evaluate.ts:1-9).
 *
 * Cohesion: imports only `./types.js` (intra-module) and the policy types via the policy public
 * barrel `../policy/index.js` — never a deep import into policy internals (dep-cruiser not-to-internal).
 */
import type { PolicyDecision, PolicyRequest } from "../policy/index.js";
import type { InferenceRequest } from "./types.js";

const GATE = "inference.pdp";

/** The single, fixed action all inference routing is authorized under. */
const INFERENCE_ACTION = "inference:invoke";

/**
 * Derive the PDP `resource` from the request. It identifies WHAT is being routed and WHERE it
 * egresses — `inference:<providerType>/<model>@<egressHost>` — so a PDP rule can scope by model,
 * provider, or destination. It composes only the already-validated, non-secret fields of the request
 * (the schema is credential-blind by construction — see types.ts), so the resource can never carry a
 * credential.
 */
function toResource(req: InferenceRequest): string {
  return `inference:${req.providerType}/${req.model}@${req.egressHost}`;
}

/**
 * Convert a (validated) InferenceRequest into a PolicyRequest. Action is FIXED to "inference:invoke";
 * the agent identity ids are copied through verbatim (never fabricated, never dropped).
 */
export function toPolicyRequest(req: InferenceRequest): PolicyRequest {
  return {
    requestId: req.requestId,
    tenantId: req.tenantId,
    projectId: req.projectId,
    taskId: req.taskId,
    actorId: req.actorId,
    action: INFERENCE_ACTION,
    resource: toResource(req),
  };
}

/**
 * Forward the converted request to the injected PDP evaluator and return its decision unchanged.
 * The PDP is the sole deny authority: this adapter never flips a deny. If the evaluator throws, fail
 * closed to a static-reason deny.
 */
export function evaluateInferencePolicy(
  req: InferenceRequest,
  evaluate: (input: unknown) => PolicyDecision,
): PolicyDecision {
  try {
    // PDP decision is authoritative and returned verbatim (no flip, no augmentation).
    return evaluate(toPolicyRequest(req));
  } catch {
    // fail-closed: an evaluator failure denies. Reason is static gate text — it NEVER embeds the
    // thrown error (which could echo a request value), preserving reason-does-not-leak.
    return {
      effect: "deny",
      reason: `${GATE}: policy evaluation error (fail-closed)`,
      auditRequired: true,
    };
  }
}
