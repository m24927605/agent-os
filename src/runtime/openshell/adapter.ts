/**
 * OpenShell sandbox-runtime adapter — the SINGLE chokepoint between Agent OS and OpenShell.
 *
 * This slice (SLICE-P0-004) lands only the typed CONTRACT plus a fail-closed `NullSandboxAdapter`:
 * with no real backend configured, every lifecycle operation is DENIED by construction
 * ("managed-path-is-only-path": unconfigured = nothing runs). The real connect-node gRPC client
 * (pinned proto + image digest) is P2.
 *
 * Cohesion rule (enforced by review + deps:check): the adapter holds NO policy-decision logic —
 * policy lives in the PDP. The adapter only imports identity primitives; it must not reach egress.
 */
import { z } from "zod";
import {
  AgentContext,
  SandboxId,
  type SandboxId as SandboxIdType,
  parseAgentContext,
} from "../../iam/ids.js";

export const SandboxLifecycle = z.enum(["create", "start", "stop", "destroy"]);
export type SandboxLifecycle = z.infer<typeof SandboxLifecycle>;

/** Minimal, auditable sandbox-lifecycle event skeleton (NOT yet appended to the evidence kernel). */
export const SandboxLifecycleEvent = z.object({
  lifecycle: SandboxLifecycle,
  result: z.enum(["ok", "denied"]),
  /** Present when the caller's AgentContext validated; otherwise `contextError` records why not. */
  context: AgentContext.optional(),
  contextError: z.string().optional(),
  sandboxId: SandboxId.optional(),
  reason: z.string().optional(),
});
export type SandboxLifecycleEvent = z.infer<typeof SandboxLifecycleEvent>;

export interface SandboxSpec {
  readonly image?: string;
  readonly labels?: Readonly<Record<string, string>>;
}

export type AdapterResult =
  | { status: "ok"; sandboxId: SandboxIdType; event: SandboxLifecycleEvent }
  | { status: "denied"; reason: string; event: SandboxLifecycleEvent };

export interface SandboxAdapter {
  createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult>;
  startSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult>;
  stopSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult>;
  destroySandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult>;
}

const DENY_REASON = "no OpenShell adapter configured (deny-by-default, fail-closed)";

/** Build a denied result + auditable event, fail-closed even on a malformed AgentContext. */
function deny(ctx: unknown, lifecycle: SandboxLifecycle): AdapterResult {
  let event: SandboxLifecycleEvent;
  try {
    event = { lifecycle, result: "denied", context: parseAgentContext(ctx), reason: DENY_REASON };
  } catch {
    event = {
      lifecycle,
      result: "denied",
      contextError: "invalid agent context",
      reason: DENY_REASON,
    };
  }
  return { status: "denied", reason: DENY_REASON, event };
}

/**
 * Fail-closed adapter used when no real OpenShell backend is wired. Every operation is denied and
 * performs NO I/O / network / process work (structurally — it imports nothing I/O-capable).
 */
export class NullSandboxAdapter implements SandboxAdapter {
  createSandbox(ctx: unknown, _spec: SandboxSpec): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "create"));
  }
  startSandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "start"));
  }
  stopSandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "stop"));
  }
  destroySandbox(ctx: unknown, _sandboxId: string): Promise<AdapterResult> {
    return Promise.resolve(deny(ctx, "destroy"));
  }
}
