/**
 * TenantRouter — the gateway-per-tenant routing boundary (connection/namespace, NOT a row filter).
 *
 * It turns "tenant isolation" into a PDP-style verifiable invariant: an untrusted `ctx` can only
 * resolve to ITS OWN tenant's `TenantBinding`. Malformed / unregistered tenant => deny (no
 * fall-through to any default tenant). Cross-tenant access is structurally impossible: the router
 * exposes no API to enumerate bindings or fetch a binding by an arbitrary string — the only way in
 * is `resolve(ctx)`, and `ctx.tenantId` is an upstream-validated identity, not a free-choice field.
 *
 * Imports only the identity primitive (`parseAgentContext`, fail-closed). No vendor, no I/O.
 */
import { parseAgentContext } from "../iam/ids.js";

/**
 * The per-tenant binding. Holds NO secret: an opaque persistence handle (`storeRef`) and an opaque
 * kernel partition id (`partitionId`), both materialized by later slices (R8-S2 / R8-S3). It is the
 * connection/namespace edge — possessing tenant A's binding gives zero reach into tenant B.
 */
export interface TenantBinding {
  readonly tenantId: string;
  readonly partitionId: string;
  readonly storeRef: string;
}

export type RouteResult = { ok: true; binding: TenantBinding } | { ok: false; reason: string };

// Static deny reasons — never echo any value from `ctx` (no leak of secret-looking tenant ids).
const REASON_INVALID_CONTEXT = "invalid agent context (fail-closed)";
const REASON_UNKNOWN_TENANT = "unknown tenant (deny-by-default)";

export class TenantRouter {
  // True ECMAScript private field (#): the registry is not reachable via property access on the
  // instance, so cross-tenant enumeration is structurally impossible — not merely a TS `private`
  // (which is erased at runtime and leaks via `(router as Record).bindings`). Defensive-copied so
  // post-construction mutation of the caller's Map cannot silently add a routable tenant.
  readonly #bindings: ReadonlyMap<string, TenantBinding>;

  constructor(bindings: ReadonlyMap<string, TenantBinding>) {
    this.#bindings = new Map(bindings);
  }

  /**
   * Resolve an untrusted context to its own tenant's binding. Fail-closed at every step:
   *  1. parseAgentContext throws on malformed/empty ids => deny (invalid agent context).
   *  2. registry miss => deny (unknown tenant); never fall through to a default.
   */
  resolve(ctx: unknown): RouteResult {
    let tenantId: string;
    try {
      tenantId = parseAgentContext(ctx).tenantId;
    } catch {
      return { ok: false, reason: REASON_INVALID_CONTEXT };
    }

    const binding = this.#bindings.get(tenantId);
    if (binding === undefined) {
      return { ok: false, reason: REASON_UNKNOWN_TENANT };
    }
    return { ok: true, binding };
  }
}
