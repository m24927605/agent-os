/**
 * The real `CommandSink` transport for the NemoClaw AgentHosting adapter (slice R11-NC-S10).
 *
 * R11-NC GROUND TRUTH (docs/slices/nemoclaw-live/INDEX.md §0): NemoClaw is NOT a standalone daemon —
 * it is an OpenClaw plugin running INSIDE an OpenShell sandbox. The only reachable surface is the
 * OpenShell sandbox lifecycle (Create/Get/Exec/Delete) plus the gateway dashboard WebSocket. The
 * NemoClawAgentHosting adapter therefore speaks "sandbox-internal shell commands" (launch / probe /
 * recovery) through an injected `CommandSink` seam (src/hosting/adapters/nemoclaw/adapter.ts:41), and
 * the REAL transport for that seam is OpenShell's `execSandbox`
 * (src/runtime/openshell/adapter.ts:445). So NemoClaw live == OpenShell live.
 *
 * Like SpendGuard's `createDecisionLedgerTransport` (src/runtime/spendguard/decision-transport.ts),
 * this is the vendor CHOKEPOINT for the hosting path: the OpenShell coupling is confined to
 * src/runtime/nemoclaw/ so the `no-vendor-in-core` boundary stays intact (the hosting core imports
 * ONLY the injected vendor-neutral `CommandSink` port; it never names OpenShell). The composition root
 * wires this transport onto a concrete `OpenShellSandboxAdapter.execSandbox` (binding the AgentContext
 * + the string->argv split there) and injects the resulting `CommandSink` into NemoClawAgentHosting.
 *
 * MAPPING (string command -> exec outcome):
 *   - exec status:"ok"      -> { exitCode: result.exitCode, stdout: <utf8-decode result.stdout> }.
 *       A NON-ZERO exit code is forwarded AS-IS — it is a faithful command result, NOT a transport
 *       error (the adapter's own dispatch decides what a non-zero exit means).
 *   - exec status:"denied"  -> REJECT with the denied reason (fail-closed). We NEVER fabricate a
 *       { exitCode: 0 } success on a deny — that is the exact class of fake-masking bug this slice
 *       exists to forbid.
 *   - exec throws / rejects -> the rejection propagates unchanged (deny-by-default). The adapter's
 *       `dispatch` catch (adapter.ts:130-138) converts any rejection into a denied result.
 *
 * CREDENTIAL-BLIND: the only thing crossing this seam is the command string the adapter built (which
 * carries only non-secret env, adapter.ts:52) + the configured sandboxId + optional non-secret
 * ExecSandboxOpts. No credential is assembled, read, or logged here.
 */
import type { CommandSink } from "../../hosting/adapters/nemoclaw/index.js";
import type { ExecOutcome, ExecSandboxOpts } from "../openshell/index.js";

/**
 * An `execSandbox`-like function. Mirrors `OpenShellSandboxAdapter.execSandbox`
 * (src/runtime/openshell/adapter.ts:445) reduced to the surface this transport needs: a bound
 * AgentContext + the string->argv conversion are supplied by the composition root that constructs
 * this `ExecLike` from a concrete adapter, so the transport itself stays a thin string-command seam.
 */
export type ExecLike = (
  sandboxId: string,
  command: string,
  opts?: ExecSandboxOpts,
) => Promise<ExecOutcome>;

export interface OpenShellExecCommandSinkOpts {
  /** The bound `execSandbox`-like transport (the vendor chokepoint; the only OpenShell coupling). */
  readonly exec: ExecLike;
  /** The OpenShell sandbox every dispatched command is scoped to (the agent's host sandbox). */
  readonly sandboxId: string;
  /** Optional non-secret exec options (workdir / timeout / output caps) forwarded on every command. */
  readonly opts?: ExecSandboxOpts;
}

/**
 * Build the real `CommandSink` that runs each command through OpenShell's `execSandbox`. Every
 * non-ok outcome (a served deny, a thrown/rejected transport) REJECTS — there is NO path that resolves
 * a fabricated `{ exitCode: 0 }` success, so the adapter's deny-by-default discipline holds end-to-end.
 */
export function createOpenShellExecCommandSink(opts: OpenShellExecCommandSinkOpts): CommandSink {
  const { exec, sandboxId, opts: execOpts } = opts;
  return {
    async run(command: string): Promise<{ exitCode: number; stdout: string }> {
      // A synchronous throw OR an async rejection from `exec` propagates unchanged (deny-by-default):
      // we do NOT catch it into a success. `await` normalises both into this promise's rejection.
      const outcome = await exec(sandboxId, command, execOpts);
      if (outcome.status === "denied") {
        // Fail-closed: surface the deny as a rejection carrying the reason. NEVER return {exitCode:0}.
        throw new Error(`OpenShell exec denied: ${outcome.reason}`);
      }
      return {
        exitCode: outcome.result.exitCode,
        stdout: new TextDecoder().decode(outcome.result.stdout),
      };
    },
  };
}
