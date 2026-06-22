/**
 * Public surface for the NemoClaw runtime transport (slice R11-NC-S10). The ONLY place the OpenShell
 * exec coupling is wired for the hosting path: `NemoClawAgentHosting` consumes only the injected
 * vendor-neutral `CommandSink` port, and this transport adapts that seam onto OpenShell's
 * `execSandbox`. Confining the vendor here keeps the `no-vendor-in-core` boundary intact (no core
 * governance module imports OpenShell). The composition-root wiring (binding a concrete
 * OpenShellSandboxAdapter + AgentContext) and the live e2e against a real OpenShell sandbox is
 * R11-NC-S11.
 */
export {
  createOpenShellExecCommandSink,
  type ExecLike,
  type OpenShellExecCommandSinkOpts,
} from "./exec-command-sink.js";
