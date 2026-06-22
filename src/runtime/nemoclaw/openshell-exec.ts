/**
 * Composition-root binding for the NemoClaw hosting path (slice SLICE-NC-S11b §B).
 *
 * The S10 `CommandSink` (exec-command-sink.ts) consumes an `ExecLike` — a thin `(sandboxId, command,
 * opts) => Promise<ExecOutcome>` string-command seam. The concrete `OpenShellSandboxAdapter.execSandbox`
 * instead takes `(ctx, sandboxId, cmd: readonly string[], opts?)`. This module is the SINGLE place that
 * bridges the two: it closes over the AgentContext and wraps the string `command` as
 * `["/bin/sh","-c",command]`, so a NemoClaw shell command (nohup launch / curl probe / pkill recovery)
 * executes under a shell inside the sandbox exactly as NemoClaw's runtime intends.
 *
 * Keeping the wrap HERE (not in the sink, not in the adapter) preserves the layering: the sink stays a
 * vendor-neutral string seam; the adapter stays a faithful argv-based exec; only the composition root
 * knows both shapes. It is CREDENTIAL-BLIND — only the command string + sandboxId + non-secret opts
 * cross the seam; the bound ctx carries identity, never a secret.
 */
import type { ExecSandboxOpts, OpenShellSandboxAdapter } from "../openshell/index.js";
import type { ExecLike } from "./exec-command-sink.js";

/**
 * Bind a concrete `OpenShellSandboxAdapter` + an `AgentContext` into the `ExecLike` the S10
 * `CommandSink` consumes. The returned fn wraps each string `command` as `["/bin/sh","-c",command]`
 * (so the gateway launch / probe / recovery shells run under `/bin/sh -c`) and dispatches through
 * `adapter.execSandbox(ctx, sandboxId, argv, opts)`. The adapter's `ExecOutcome` (ok OR denied) is
 * returned UNCHANGED — the sink decides what a deny means (it fails closed; it never fabricates success).
 */
export function createNemoClawOpenShellExec(
  adapter: OpenShellSandboxAdapter,
  ctx: unknown,
): ExecLike {
  return (sandboxId: string, command: string, opts?: ExecSandboxOpts) =>
    adapter.execSandbox(ctx, sandboxId, ["/bin/sh", "-c", command], opts);
}
