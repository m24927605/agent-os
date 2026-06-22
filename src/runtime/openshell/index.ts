/**
 * Public surface for the OpenShell vendor adapter (slices P2R-R1-S1/S2). The ONLY place the OpenShell
 * RPC vendor (`@connectrpc/connect{,-node}`) is wired; core governance modules consume only the
 * injected `OpenShellTransport` port + the `SandboxAdapter` it implements. provider-env (S5) exposes
 * placeholder-ONLY slots via a fail-closed shape guard; the remaining surface lands in S6.
 */
export {
  PINNED_SANDBOX_IMAGE,
  SandboxPhase,
  assertPinnedImageDigest,
  createOpenShellClient,
  type OpenShellClientOpts,
  type OpenShellTransport,
  type OpenShellLifecycleTransport,
  type OpenShellReadinessTransport,
  type CreateSandboxRequest,
  type DeleteSandboxRequest,
  type DeleteSandboxResponse,
  type SandboxResponse,
  type GetSandboxRequest,
  type WatchSandboxRequest,
  type SandboxStreamEvent,
  type OpenShellExecTransport,
  type ExecSandboxRequest,
  type ExecSandboxEvent,
  type OpenShellProviderEnvTransport,
  type GetSandboxProviderEnvironmentRequest,
  type GetSandboxProviderEnvironmentResponse,
  isExecEnvValueAllowed,
} from "./client.js";
export { assertPlaceholderOnly } from "./provider-env.js";
export {
  type AwaitReadyOpts,
  type ExecSandboxOpts,
  type ExecResult,
  type ExecOutcome,
  type ProviderEnvOutcome,
  OpenShellSandboxAdapter,
} from "./adapter.js";
export {
  type OpenShellGrpcTransportOpts,
  type ExecStreamHandle,
  type UnaryRequestFn,
  createOpenShellGrpcTransport,
} from "./grpc-transport.js";
export {
  EXEC_SANDBOX_METHOD,
  CREATE_SANDBOX_METHOD,
  GET_SANDBOX_METHOD,
  DELETE_SANDBOX_METHOD,
  type ExecSandboxRequestWire,
  type ExecSandboxEvent as ExecSandboxEventWire,
  type CreateSandboxRequestWire,
  type SandboxResponseWire,
  type GetSandboxRequestWire,
  type DeleteSandboxRequestWire,
  type DeleteSandboxResponseWire,
  encodeExecSandboxRequest,
  decodeExecSandboxEvent,
  encodeCreateSandboxRequest,
  encodeGetSandboxRequest,
  encodeDeleteSandboxRequest,
  decodeSandboxResponse,
  decodeDeleteSandboxResponse,
} from "./proto/openshell.subset.codec.js";
