/**
 * Public surface for the NemoClaw runtime transport (slice R11-NC-S10). The ONLY place the OpenShell
 * exec coupling is wired for the hosting path: `NemoClawAgentHosting` consumes only the injected
 * vendor-neutral `CommandSink` port, and this transport adapts that seam onto OpenShell's
 * `execSandbox`. Confining the vendor here keeps the `no-vendor-in-core` boundary intact (no core
 * governance module imports OpenShell). The composition-root wiring (`createNemoClawOpenShellExec`,
 * binding a concrete OpenShellSandboxAdapter + AgentContext via a `/bin/sh -c` wrap) lands in NC-S11b;
 * the gated live e2e against a real OpenShell sandbox is `nemoclaw.live.test.ts`.
 */
export {
  createOpenShellExecCommandSink,
  type ExecLike,
  type OpenShellExecCommandSinkOpts,
} from "./exec-command-sink.js";
export { createNemoClawOpenShellExec } from "./openshell-exec.js";
export {
  type CreateNemoClawOnOpenShellOpts,
  type NemoClawOnOpenShell,
  createNemoClawOnOpenShell,
} from "./openshell-host.js";
