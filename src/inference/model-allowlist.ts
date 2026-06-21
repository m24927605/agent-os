/**
 * Per-model deny-by-default gate — the FIRST chokepoint of the inference routing gate
 * (docs/design/inference-routing-gate.md §2.2 step 1). Pure function, no I/O.
 *
 * Two invariants hold by construction:
 *   - deny-by-default: only a (model, providerType) PAIR present on the explicit allowlist passes;
 *     an unknown model, an unknown provider, or a known model with a mismatched provider all deny.
 *     An empty allowlist denies everything.
 *   - fail-closed: a malformed request (Zod parse failure — missing/empty/wrong-typed field, or an
 *     unexpected extra field rejected by `.strict()`) DENIES and never throws and never allows.
 *
 * The deny `reason` is static gate text — it never echoes the request payload (reason-does-not-leak).
 */
import { InferenceRequest, type ModelAllowlist, type ModelDecision } from "./types.js";

const GATE = "inference.model-allowlist";

export function isModelAllowed(req: unknown, allowlist: ModelAllowlist): ModelDecision {
  const parsed = InferenceRequest.safeParse(req);
  if (!parsed.success) {
    // fail-closed: any shape that is not a well-formed InferenceRequest is denied, not inspected.
    return { allowed: false, reason: `${GATE}: malformed request` };
  }
  const { model, providerType } = parsed.data;
  const onAllowlist = allowlist.some(
    (entry) => entry.model === model && entry.providerType === providerType,
  );
  if (!onAllowlist) {
    return { allowed: false, reason: `${GATE}: (model, providerType) not on allowlist` };
  }
  return { allowed: true, request: parsed.data };
}
