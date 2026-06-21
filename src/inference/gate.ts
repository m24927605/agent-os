/**
 * InferenceRoutingGate — the SINGLE chokepoint that composes the four inference gates into one
 * verifiable `authorize` (docs/design/inference-routing-gate.md §2.2, §4.4, §5). No I/O of its own;
 * every collaborator (allowlists, PDP evaluator, cost map, CostGate) is constructor-INJECTED via
 * `deps`, so the gate is hard-wired to NO concrete implementation or vendor (low coupling).
 *
 * Composition order is a SECURITY decision (design §2.2 / §4.4):
 *   S1 model allowlist  → S2 egress allowlist → S3 PDP → S4 CostGate.reserve  (reserve LAST).
 *
 * Two invariants are the heart of this layer:
 *   - any-deny-wins: a deny at ANY gate denies the whole authorization; only when all four allow do
 *     we return `{ decision:"allow", reservationId }`.
 *   - never-reserve-on-deny (no orphan hold): `reserve` has a side effect (it HOLDS budget), so it
 *     runs ONLY after every upstream gate has allowed. When any upstream gate denies, `reserve` is
 *     NEVER called — there is never a held cost that will not be committed (the dual of
 *     reserve-before-effect).
 *
 * Fail-closed everywhere: a malformed request, an unpriced model, a reserve denial, or ANY thrown
 * error from an injected collaborator all resolve to `deny`, never `allow`. The PDP remains the SOLE
 * deny authority — the gate never flips a PDP deny to allow (it only ever adds MORE deny).
 *
 * Credential-blind by construction: neither this gate nor `InferenceDecision` accepts or returns any
 * credential; the validated request is credential-blind (see types.ts) and the reserve call carries
 * only token counts + a resource id (see cost/port.ts). A structural test asserts this source names
 * no credential-bearing field.
 *
 * Cohesion: intra-module imports (`./types.js`, `./model-allowlist.js`, `./egress-allowlist.js`,
 * `./pdp-adapter.js`, `./cost-map.js`) plus the cost module's PUBLIC barrel (`../cost/index.js`) and
 * the policy types via the policy barrel (`../policy/index.js`) — never a deep import into another
 * module's internals (dep-cruiser not-to-internal).
 */
import type { CostGate } from "../cost/index.js";
import type { PolicyDecision } from "../policy/index.js";
import type { CostMap } from "./cost-map.js";
import { estimateTokens } from "./cost-map.js";
import { isEgressAllowed } from "./egress-allowlist.js";
import { isModelAllowed } from "./model-allowlist.js";
import { evaluateInferencePolicy } from "./pdp-adapter.js";
import type { EgressAllowlist, InferenceRequest, ModelAllowlist } from "./types.js";

const GATE = "inference.gate";

/**
 * The decision of the composed gate. `allow` carries the reservationId (the caller settles it via
 * CostGate.commit AFTER the real egress); `deny` carries only a static reason naming the offending
 * gate — never the request payload (reason-does-not-leak).
 */
export type InferenceDecision =
  | { readonly decision: "allow"; readonly reservationId: string }
  | { readonly decision: "deny"; readonly reason: string };

/**
 * Everything the gate needs, all constructor-injected so the gate couples to NO concrete
 * implementation. `evaluate` is the PDP forwarded as a function (design §4.3 trade-off 3); `costGate`
 * is any CostGate implementation (InMemory / Null / a real adapter).
 */
export interface InferenceGateDeps {
  readonly modelAllowlist: ModelAllowlist;
  readonly egressAllowlist: EgressAllowlist;
  readonly evaluate: (input: unknown) => PolicyDecision;
  readonly costMap: CostMap;
  readonly costGate: CostGate;
}

/** Build the AgentContext the CostGate expects from the (already-validated) request ids. */
function toContext(req: InferenceRequest): unknown {
  return {
    actorId: req.actorId,
    tenantId: req.tenantId,
    projectId: req.projectId,
    taskId: req.taskId,
    requestId: req.requestId,
  };
}

/** The CostGate resource id — vendor-neutral, composed only of non-secret request fields. */
function toResource(req: InferenceRequest): string {
  return `inference:${req.providerType}/${req.model}@${req.egressHost}`;
}

function deny(reason: string): InferenceDecision {
  return { decision: "deny", reason };
}

export class InferenceRoutingGate {
  async authorize(req: unknown, deps: InferenceGateDeps): Promise<InferenceDecision> {
    try {
      // S1 — per-model deny-by-default. This also PARSES the request (fail-closed on a malformed /
      // extra-field shape); the validated request flows to the downstream gates.
      const model = isModelAllowed(req, deps.modelAllowlist);
      if (!model.allowed) {
        return deny(model.reason);
      }
      const validated = model.request;

      // S2 — egress host deny-by-default.
      const egress = isEgressAllowed(validated, deps.egressAllowlist);
      if (!egress.allowed) {
        return deny(egress.reason);
      }

      // S3 — PDP is the SOLE deny authority. A PDP deny denies; the gate never flips it.
      const pdp = evaluateInferencePolicy(validated, deps.evaluate);
      if (pdp.effect === "deny") {
        return deny(`${GATE}: denied by policy`);
      }

      // Cost estimate (fail-closed: an unpriced model has no estimate ⇒ deny). Computed BEFORE
      // reserve; still NO side effect yet.
      const estimate = estimateTokens(validated, deps.costMap);
      if (!estimate.ok) {
        return deny(estimate.reason);
      }

      // S4 — CostGate.reserve runs LAST and ONLY because S1–S3 all allowed (never-reserve-on-deny:
      // there is no path here from an upstream deny). reserve denied (hard-cap / no backend) ⇒ deny.
      const reserved = await deps.costGate.reserve(toContext(validated), {
        estimatedTokens: estimate.tokens,
        resource: toResource(validated),
      });
      if (reserved.status !== "ok") {
        return deny(`${GATE}: cost reservation denied (reserve-before-effect)`);
      }

      return { decision: "allow", reservationId: reserved.reservationId };
    } catch {
      // fail-closed: ANY thrown error from a collaborator denies — never allow. Reason is static
      // gate text and embeds no thrown message (which could echo a request value).
      return deny(`${GATE}: authorization error (fail-closed)`);
    }
  }
}
