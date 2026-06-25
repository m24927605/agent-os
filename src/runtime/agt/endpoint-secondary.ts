/**
 * AGT endpoint-backed async SecondaryPolicyAdapter (SLICE-R9b-2a).
 *
 * Wraps an injected {@link AgtDecisionTransport} (the grpc-js UDS transport in production; a fake
 * `{ evaluate }` in tests) as an ASYNC `SecondaryPolicyAdapter` (R9a made `evaluate` MaybePromise).
 * It maps our PolicyRequest -> AgtEvaluateRequest -> `await transport.evaluate(...)` ->
 * AgtEvaluateResponse -> our advisory PolicyDecision, mirroring the in-process AgtSecondaryPolicy
 * mapping (src/policy/adapters/agt/adapter.ts):
 *   - allowed===true && action==="allow"  -> effect:"allow"
 *   - deny / warn / log / require_approval / unknown / malformed  -> effect:"deny" (fail-CLOSED).
 *
 * FAIL-CLOSED: the adapter does NOT catch a transport throw/reject (down / timeout / protocol error).
 * It lets the reject PROPAGATE so `evaluateSecondaries` (dedup.ts) records the canonical synthetic
 * deny (configured-but-down -> deny), keeping a single fail-closed path. A MALFORMED-but-resolved
 * response (wrong shape) is mapped to deny in-band.
 *
 * ADVISORY-ONLY: returns a `PolicyDecision`; `combineDecisions` keeps the PDP the sole deny authority
 * (an AGT allow can never relax a PDP deny).
 *
 * CREDENTIAL-BLIND: the AgtEvaluateRequest sent to the transport carries ONLY the neutral governance
 * fields + `req.governanceProjection` (the already-best-effort-redacted R9b-1 projection). It NEVER
 * carries raw args/env/stdin/the raw toolCall — the AgtEvaluateRequest shape has no such field. The
 * deny reason is passed through `redactSecrets`, so a secret-shaped token in the AGT reason is scrubbed
 * before it reaches our audit trail.
 *
 * This module lives in the runtime/agt vendor zone (it imports the transport + the generated stub
 * types). It imports the policy types/seam ONLY via the policy public barrel — no deep import.
 */
import { redactSecrets } from "../../audit/index.js";
import type { PolicyDecision, PolicyRequest, SecondaryPolicyAdapter } from "../../policy/index.js";
import type { AgtEvaluateRequest, AgtEvaluateResponse } from "./_generated/agt_decision.js";
import type { AgtDecisionTransport } from "./decision-transport.js";

/** Options for the endpoint adapter (room for future scope/feature flags; none needed in R9b-2a). */
export interface AgtEndpointSecondaryOpts {
  /** Reserved for R9b-2b wiring (scope gate, labels). Unused today; kept for a stable signature. */
  readonly label?: string;
}

/** ONLY an unambiguous AGT allow (allowed===true AND action==="allow") may map to our allow. */
function isAgtAllow(resp: AgtEvaluateResponse): boolean {
  return resp.allowed === true && resp.action === "allow";
}

/** Structural validation — a transport reply that is not the expected shape is treated as deny. */
function isAgtEvaluateResponse(value: unknown): value is AgtEvaluateResponse {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Record<string, unknown>;
  return typeof d.allowed === "boolean" && typeof d.action === "string";
}

/**
 * Build the credential-blind AgtEvaluateRequest from a PolicyRequest: ONLY the neutral governance
 * fields + the projection. NO raw args/toolCall — the message has no field for them.
 */
function toAgtRequest(req: PolicyRequest): AgtEvaluateRequest {
  return {
    requestId: req.requestId,
    tenantId: req.tenantId,
    projectId: req.projectId,
    taskId: req.taskId,
    actorId: req.actorId,
    action: req.action,
    resource: req.resource,
    governanceProjection:
      req.governanceProjection === undefined
        ? undefined
        : {
            version: req.governanceProjection.version,
            operationClass: req.governanceProjection.operationClass,
            argv0: req.governanceProjection.argv0,
            argc: req.governanceProjection.argc,
            argvRedacted: [...req.governanceProjection.argvRedacted],
            truncated: req.governanceProjection.truncated,
            usesShellInterpreter: req.governanceProjection.usesShellInterpreter,
            networkHosts: [...req.governanceProjection.networkHosts],
            destructiveFlags: [...req.governanceProjection.destructiveFlags],
          },
  };
}

class AgtEndpointSecondary implements SecondaryPolicyAdapter {
  constructor(private readonly transport: AgtDecisionTransport) {}

  /**
   * Map PolicyRequest -> AgtEvaluateRequest -> transport.evaluate -> advisory PolicyDecision.
   * Fail-CLOSED on any non-allow or malformed reply. A transport throw/reject is NOT caught here — it
   * propagates so evaluateSecondaries records the canonical synthetic deny (down -> deny).
   */
  async evaluate(req: PolicyRequest): Promise<PolicyDecision> {
    const agtReq = toAgtRequest(req);
    // No try/catch: a reject (down / timeout / protocol error) propagates -> evaluateSecondaries deny.
    const raw: unknown = await this.transport.evaluate(agtReq);
    if (!isAgtEvaluateResponse(raw)) {
      return {
        effect: "deny",
        reason: "AGT endpoint returned a malformed decision — deny-by-default (fail-closed)",
        auditRequired: true,
      };
    }
    // Annotate for audit; redactSecrets scrubs any secret-shaped token in the AGT reason/rule.
    const annotate = redactSecrets(
      `agt_action=${raw.action}${raw.matchedRule ? ` matched_rule=${raw.matchedRule}` : ""}${
        raw.reason ? ` reason=${raw.reason}` : ""
      }`,
    );
    if (isAgtAllow(raw)) {
      return { effect: "allow", reason: `allow (advisory) — ${annotate}`, auditRequired: true };
    }
    return {
      effect: "deny",
      reason: `deny (fail-closed; AGT non-allow is advisory-deny) — ${annotate}`,
      matchedRule: redactSecrets(raw.matchedRule) || undefined,
      auditRequired: true,
    };
  }
}

/**
 * Build an endpoint-backed async `SecondaryPolicyAdapter` over an injected `AgtDecisionTransport`.
 * INERT in R9b-2a: this is NOT registered into any surface / composition root / closure — wiring +
 * scope gate is R9b-2b.
 */
export function createAgtEndpointSecondary(
  transport: AgtDecisionTransport,
  _opts?: AgtEndpointSecondaryOpts,
): SecondaryPolicyAdapter {
  return new AgtEndpointSecondary(transport);
}
