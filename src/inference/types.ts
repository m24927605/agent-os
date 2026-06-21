/**
 * Inference layer types — the vendor-neutral contract for a routing-gate decision.
 *
 * An InferenceRequest describes "I want to route a prompt to (model, providerType) via egressHost,
 * carrying my agent identity". It is CREDENTIAL-BLIND BY CONSTRUCTION: the schema has NO field that
 * could hold a provider credential (no api_key / secret / bearer / token-bearing field). Credential
 * injection is the substrate's job (the OpenShell SecretResolver returns route material WITH
 * credentials only to an authenticated sandbox principal); the core gate only ever decides whether
 * to ALLOW routing — it never touches the secret. A structural test (model-allowlist.test.ts)
 * asserts this source carries no credential-bearing field name so the invariant cannot regress.
 *
 * `.strict()` makes the schema fail-closed against shape drift: an unexpected extra field is a
 * rejected request (deny), never a silently-ignored one — closing the door on a future field that
 * might smuggle a credential past review.
 *
 * Cohesion: this module imports only identity primitives (`../iam/ids.js`), exactly as the policy
 * and cost ports do. No egress, no I/O, no vendor.
 */
import { z } from "zod";
import { ActorId, ProjectId, RequestId, TaskId, TenantId } from "../iam/ids.js";

const nonEmpty = z.string().trim().min(1);

/**
 * Vendor-neutral inference request. `egressHost` and `estimatedTokens` are carried here for the
 * later S2 (egress allowlist) / S4 (CostGate reserve) gates; S1 only reads `model`/`providerType`.
 */
export const InferenceRequest = z
  .object({
    model: nonEmpty,
    providerType: nonEmpty,
    egressHost: nonEmpty,
    estimatedTokens: z.number().int().nonnegative().optional(),
    actorId: ActorId,
    tenantId: TenantId,
    projectId: ProjectId,
    taskId: TaskId,
    requestId: RequestId,
  })
  .strict();
export type InferenceRequest = z.infer<typeof InferenceRequest>;

/**
 * The explicit per-model allowlist: only a listed (model, providerType) PAIR may be routed. Empty
 * list ⇒ everything denies (deny-by-default). `readonly` so a gate cannot mutate it mid-decision.
 */
export type ModelAllowlist = readonly {
  readonly model: string;
  readonly providerType: string;
}[];

/**
 * The explicit egress host allowlist: only a listed host may be routed to (exact match, compared
 * case-insensitively after normalize). Empty list ⇒ everything denies (deny-by-default). No
 * wildcard / suffix matching — `evil-example.com` must NOT slip past an `example.com` entry.
 * `readonly` so a gate cannot mutate it mid-decision.
 */
export type EgressAllowlist = readonly string[];

/**
 * The decision shape for a single gate. `allowed: true` carries the parsed (validated) request so
 * downstream gates consume a trusted value, not the raw `unknown`. `allowed: false` carries only a
 * static `reason` (gate name / category) — NEVER the request payload (reason-does-not-leak-value).
 */
export type ModelDecision =
  | { readonly allowed: true; readonly request: InferenceRequest }
  | { readonly allowed: false; readonly reason: string };
