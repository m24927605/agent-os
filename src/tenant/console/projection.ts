/**
 * R8-S4 — operator console read-only fleet/timeline projection (the "open a company from one
 * screen" minimal data contract; NOT UI pixels).
 *
 * `ConsoleProjection.forTenant(binding)` returns a `TenantConsole` that is CLOSURE-BOUND to that one
 * tenant's `TenantScopedRepo` (R8-S2). The console surface is structurally read-only and structurally
 * single-tenant:
 *   - it exposes ONLY `fleet()` / `timeline()` — no mutate method, so it cannot "change the company"
 *     (privileged actions go through PDP + commit-before-effect in a later slice, NOT here);
 *   - those methods take NO tenantId argument — a holder of tenant A's console has no argument with
 *     which to name tenant B, so seeing another tenant's fleet is impossible BY CONSTRUCTION
 *     (design §2.5);
 *   - the projection lifts ONLY the allow-listed fields off each repo entry, so a secret-looking
 *     value stored alongside an agent/event never surfaces in a view.
 *
 * Tenant filtering is NOT this module's job: it only ever touches the single repo handed back by
 * `store.forTenant(binding)`. An unregistered binding fails closed via the store's own throw
 * (no empty/other-tenant view).
 *
 * Imports only the persistence port + the binding type (intra-module, src/tenant). No vendor, no I/O,
 * no secret.
 */
import type { TenantScopedRepo, TenantStore } from "../persistence/port.js";
import type { TenantBinding } from "../router.js";

/** Prefix conventions producers use when writing into the per-tenant repo. */
const AGENT_PREFIX = "agent:";
const EVENT_PREFIX = "event:";

/** Read-only fleet projection: the tenant's agent roster (hosting shape, allow-listed fields). */
export interface FleetView {
  readonly tenantId: string;
  readonly agents: readonly { sandboxId: string; agentName: string; phase: string }[];
}

/** Read-only timeline projection: the tenant's events, ordered by seq ascending. */
export interface TimelineView {
  readonly tenantId: string;
  readonly events: readonly { seq: number; summary: string }[];
}

/** The console surface: two read methods, no mutate, no tenantId parameter. */
export interface TenantConsole {
  fleet(): Promise<FleetView>;
  timeline(): Promise<TimelineView>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Lift the allow-listed fleet fields; fail-closed (return undefined) on any non-conforming entry. */
function projectAgent(
  value: unknown,
): { sandboxId: string; agentName: string; phase: string } | undefined {
  if (!isRecord(value)) return undefined;
  const { sandboxId, agentName, phase } = value;
  if (typeof sandboxId !== "string" || typeof agentName !== "string" || typeof phase !== "string") {
    return undefined;
  }
  return { sandboxId, agentName, phase };
}

/** Lift the allow-listed timeline fields; fail-closed (return undefined) on any non-conforming entry. */
function projectEvent(value: unknown): { seq: number; summary: string } | undefined {
  if (!isRecord(value)) return undefined;
  const { seq, summary } = value;
  if (typeof seq !== "number" || !Number.isFinite(seq) || typeof summary !== "string") {
    return undefined;
  }
  return { seq, summary };
}

export class ConsoleProjection {
  readonly #store: TenantStore;

  constructor(store: TenantStore) {
    this.#store = store;
  }

  /**
   * Bind a console to one tenant. The repo is resolved (fail-closed) HERE and closed over, so the
   * returned surface can never reach another tenant. Unregistered binding => store throws => deny.
   */
  forTenant(binding: TenantBinding): TenantConsole {
    const repo: TenantScopedRepo = this.#store.forTenant(binding);
    const tenantId = binding.tenantId;

    return {
      async fleet(): Promise<FleetView> {
        const keys = await repo.list();
        const agents: { sandboxId: string; agentName: string; phase: string }[] = [];
        for (const key of keys) {
          if (!key.startsWith(AGENT_PREFIX)) continue;
          const projected = projectAgent(await repo.get(key));
          if (projected !== undefined) agents.push(projected);
        }
        agents.sort((a, b) => a.sandboxId.localeCompare(b.sandboxId));
        return { tenantId, agents };
      },

      async timeline(): Promise<TimelineView> {
        const keys = await repo.list();
        const events: { seq: number; summary: string }[] = [];
        for (const key of keys) {
          if (!key.startsWith(EVENT_PREFIX)) continue;
          const projected = projectEvent(await repo.get(key));
          if (projected !== undefined) events.push(projected);
        }
        events.sort((a, b) => a.seq - b.seq);
        return { tenantId, events };
      },
    };
  }
}
