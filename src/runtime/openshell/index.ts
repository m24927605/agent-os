/**
 * Public surface for the OpenShell vendor adapter (slices P2R-R1-S1/S2). The ONLY place the OpenShell
 * RPC vendor (`@connectrpc/connect{,-node}`) is wired; core governance modules consume only the
 * injected `OpenShellTransport` port + the `SandboxAdapter` it implements. Remaining sandbox-lifecycle
 * surface (readiness / exec / provider-env) is added in S3..S6.
 */
export {
  PINNED_SANDBOX_IMAGE,
  assertPinnedImageDigest,
  createOpenShellClient,
  type OpenShellClientOpts,
  type OpenShellTransport,
  type OpenShellLifecycleTransport,
  type CreateSandboxRequest,
  type DeleteSandboxRequest,
  type DeleteSandboxResponse,
  type SandboxResponse,
} from "./client.js";
export { OpenShellSandboxAdapter } from "./adapter.js";
