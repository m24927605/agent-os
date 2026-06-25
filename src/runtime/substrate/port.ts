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
  /**
   * SLICE-CAP5 — the per-sandbox OUTBOUND EGRESS ALLOWLIST (deny-all by default). The exact, vendor-
   * neutral host list a sandbox is permitted to reach. OPTIONAL: absent OR empty => DENY-ALL (the
   * `matchEgressAllow` primitive fail-closes on an empty allowlist), so every existing `SandboxSpec`
   * literal (none carry `egressAllow`) is BYTE-IDENTICAL — absent maps to today's behavior (no network
   * tool exists yet, so deny-all is the status quo).
   *
   * HONEST BOUNDARY: the REAL no-egress enforcement is a DEPLOY FACT (the OpenShell network policy). A
   * substrate adapter carries this allowlist toward its network-policy configuration BEST-EFFORT; where
   * the substrate's create request has NO field to carry it (the pinned OpenShell `CreateSandboxRequest`
   * proto subset does NOT), the adapter treats it as DOCUMENTED DEPLOY-INTENT (see the OpenShell adapter
   * `createSandbox`), never fabricating a wire field. The substrate seal is PRIMARY; the PDP egress
   * decision (`egressDecisionForProjection`) is the in-repo, testable defense-in-depth layer.
   */
  readonly egressAllow?: readonly string[];
}

export type AdapterResult =
  | { status: "ok"; sandboxId: SandboxIdType; event: SandboxLifecycleEvent }
  | { status: "denied"; reason: string; event: SandboxLifecycleEvent };

/**
 * A BUFFERED command to run inside an already-created sandbox. Crosses the port boundary, so it is
 * zod-validated (`ExecCommandSpecSchema`) by every adapter before use — a malformed spec is fail-closed
 * (denied), never executed.
 *
 * `env` values are PLACEHOLDER / bundleRef strings ONLY. A raw secret in `env` is a credential-blind
 * violation and is rejected UPSTREAM by `makeExecEffect` (the substrate/process never sees it); the port
 * type documents that contract — it does not itself scan, because the port holds no audit dependency
 * (cohesion chokepoint: port/null/fake import only zod + identity primitives).
 */
export interface ExecCommandSpec {
  readonly argv: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /**
   * OPTIONAL stdin payload (raw bytes). The substrate streams this to the command's stdin. Content that
   * must NOT pass through argv/shell (e.g. `exec.write_file`'s file content via `tee -- <path>`) travels
   * here as BYTES — never an argv element, never a shell string. Like `env` values, stdin bytes are
   * credential-blind: `makeExecEffect` screens the decoded stdin and DENIES fail-closed BEFORE any exec
   * if it is secret-shaped (the substrate/process never sees a raw secret). An oversized payload is a
   * resource bound enforced by the substrate adapter (deny-by-default), not by this buffered port.
   */
  readonly stdin?: Uint8Array;
}

/** Boundary validator for `ExecCommandSpec`. argv must be non-empty (a command with no program is denied). */
export const ExecCommandSpecSchema = z.object({
  argv: z.array(z.string()).nonempty(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  // stdin is raw bytes (a Uint8Array); validated as an instance so a malformed (non-bytes) stdin is
  // fail-closed at the port boundary, never coerced.
  stdin: z.instanceof(Uint8Array).optional(),
});

/**
 * BUFFERED exec result — a fail-closed discriminated union. `ok:true` carries the captured exit code +
 * stdout/stderr (+ a `truncated` flag if the substrate itself capped its capture). `ok:false` carries a
 * reason and NOTHING else: a failed/garbled/no-terminal-exit exec is NEVER reported as a (possibly
 * fabricated) successful exit 0 — mirrors the OpenShell transport's fail-closed contract (client.ts:213-214).
 */
export type ExecResult =
  | { ok: true; exitCode: number; stdout: string; stderr: string; truncated: boolean }
  | { ok: false; reason: string };

export interface SandboxAdapter {
  createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult>;
  startSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult>;
  stopSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult>;
  destroySandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult>;
}

/**
 * The exec primitive — the substrate's BUFFERED run-a-command capability, added as an EXTENSION of the
 * four frozen lifecycle methods rather than a mutation of `SandboxAdapter`.
 *
 * Why an extension (the honest EXEC1 boundary): the four lifecycle methods are frozen (P2-A), and the
 * real OpenShell adapter already carries its OWN richer, STREAMING exec (`ExecOutcome`, a different
 * shape) consumed by the nemoclaw `/bin/sh -c` seam — wiring OpenShell onto THIS buffered shape is
 * EXEC2, explicitly out of scope here. So EXEC1 adds the buffered primitive to the port as a separate
 * contract that the in-tree defaults (Fake, Null) implement and `makeExecEffect` consumes; OpenShell
 * reconciling to it is EXEC2. No existing lifecycle adapter is touched.
 *
 * Fail-closed: invalid context / unknown sandbox / malformed spec / a failed run all resolve to
 * `{ok:false, reason}` — never a thrown error across the port boundary and never a fabricated exit code.
 */
export interface ExecCapableSandboxAdapter extends SandboxAdapter {
  execSandbox(ctx: unknown, sandboxId: string, spec: ExecCommandSpec): Promise<ExecResult>;
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
