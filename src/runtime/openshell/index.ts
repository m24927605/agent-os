/**
 * Public surface for the OpenShell vendor adapter (slice P2R-R1-S1). The ONLY place the OpenShell RPC
 * vendor (`@connectrpc/connect{,-node}`) is wired; core governance modules consume only the injected
 * `OpenShellTransport` port. Sandbox-lifecycle surface (adapter / provider-env) is added in S2..S6.
 */
export {
  PINNED_SANDBOX_IMAGE,
  assertPinnedImageDigest,
  createOpenShellClient,
  type OpenShellClientOpts,
  type OpenShellTransport,
} from "./client.js";
