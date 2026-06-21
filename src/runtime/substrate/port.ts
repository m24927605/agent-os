/**
 * ExecutionSubstrate port — the vendor-neutral contract every sandbox substrate adapter implements.
 *
 * This is the OS-side seam (pluggability HARD CONSTRAINT): the core drives a sandbox ONLY through
 * `SandboxAdapter`. Vendors (OpenShell, …) live as ONE adapter each under `src/runtime/<vendor>/`;
 * this `substrate/` path carries NO vendor name. Default adapters shipped here: `NullSandboxAdapter`
 * (fail-closed deny-all, used when nothing is wired) and `FakeSandboxAdapter` (in-memory, for tests
 * + as the mandatory 2nd implementation that proves the port is genuinely swappable).
 *
 * Cohesion rule (enforced by review + deps:check): the port + its in-tree adapters hold NO
 * policy-decision logic (policy lives in the PDP) and reach NO egress — they import only identity
 * primitives + zod (asserted by sandbox-adapter.test.ts).
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

/**
 * Build a denied result + auditable event, fail-closed even on a malformed AgentContext. Shared by
 * every adapter so the deny path is identical regardless of vendor.
 */
export function deny(ctx: unknown, lifecycle: SandboxLifecycle, reason: string): AdapterResult {
  let event: SandboxLifecycleEvent;
  try {
    event = { lifecycle, result: "denied", context: parseAgentContext(ctx), reason };
  } catch {
    event = { lifecycle, result: "denied", contextError: "invalid agent context", reason };
  }
  return { status: "denied", reason, event };
}

/** Build an ok result + auditable event. The caller MUST pass an already-validated AgentContext. */
export function ok(
  ctx: AgentContext,
  lifecycle: SandboxLifecycle,
  sandboxId: SandboxIdType,
): AdapterResult {
  return {
    status: "ok",
    sandboxId,
    event: { lifecycle, result: "ok", context: ctx, sandboxId },
  };
}
