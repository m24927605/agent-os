/**
 * AgentHosting module public surface — the vendor-neutral port + in-tree default adapters (Null =
 * fail-closed deny-all; InMemory = tenant-scoped). Real vendor adapters (e.g. NemoClaw) land under
 * src/hosting/adapters/<vendor>/ and implement `AgentHosting` from here.
 *
 * Only the PUBLIC contract is re-exported; the adapter-authoring helpers (contextOrError/denyEvent)
 * stay module-internal (imported directly from ./port.js by the in-tree adapters) so they do not leak
 * onto the package barrel or collide with another module's identically-named helper.
 */
export type {
  AgentHosting,
  AgentLifecycleEvent,
  AgentPhase,
  HostResult,
  HostSpec,
  HostingOperation,
  ReconcileAction,
  ReconcileResult,
  StatusResult,
} from "./port.js";
export { NullAgentHosting } from "./null.js";
export { InMemoryAgentHosting } from "./in-memory.js";
