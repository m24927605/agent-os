/**
 * Hermes brain adapter — vendor barrel. Re-exports ONLY the shim class and its injected turn-source
 * seam (+ the turn DTO types). Deliberately NOT re-exported from the brain package barrel
 * (src/runtime/brain/index.ts): a vendor adapter is wired by the composition root, never surfaced as
 * part of the neutral port API.
 */
export {
  type HermesMemoryOp,
  type HermesSkillOp,
  type HermesToolCall,
  type HermesTurn,
  type HermesTurnSource,
  HermesBrainShim,
} from "./shim.js";
export {
  type AcpUpdateFrame,
  type DesktopHermesTransport,
  DesktopHermesTurnSource,
  type DuplexDesktopHermesTransport,
  FakeDesktopHermesTransport,
  type HermesLoopSession,
  type HermesLoopTurn,
  parseFrame,
} from "./desktop.js";
export { AcpStdioTransport, type AcpStdioTransportOptions } from "./acp-stdio.js";
export {
  type ClosedLoopOptions,
  type ClosedLoopResult,
  type ClosedLoopStop,
  runClosedLoop,
} from "./closed-loop.js";
export {
  type BindingWrappedExecEffectOptions,
  type ExecClosedLoopOptions,
  type ExecToolBinding,
  bindingWrappedExecEffect,
  runExecClosedLoop,
} from "./exec-closed-loop.js";
export {
  echoBinding,
  echoManifest,
  lsBinding,
  lsManifest,
  seedBindings,
  seedRegistry,
} from "./exec-seed-tools.js";
// SLICE-ACT1 — the SIBLING ActionBinding family (NON-argv app/API actions: gmail/drive). Parallel to the
// exec family; the exec seam is UNCHANGED. The AgtScope/ManifestLookup/ProjectableCall types are already
// surfaced by the governance-projection-for-call export above (they are family-agnostic) — NOT re-exported
// here to avoid a duplicate-name conflict on the barrel.
export {
  type ActionBinding,
  type ActionConnector,
  type ActionDescriptor,
  type ActionResult,
  type BindingWrappedActionEffectOptions,
  FakeActionConnector,
  bindingWrappedActionEffect,
} from "./action-closed-loop.js";
export { buildActionProjectionForCall } from "./action-projection-for-call.js";
export {
  DRIVE_HOST,
  GMAIL_HOST,
  GMAIL_OAUTH_KEY_ENV,
  driveReadBinding,
  driveReadManifest,
  gmailSendBinding,
  gmailSendManifest,
  seedActionBindings,
  seedActionRegistry,
  toCredentialEnv,
} from "./action-seed-tools.js";
export { makeArgsCredentialScreen } from "./args-credential-screen.js";
export {
  type AgtScope,
  type ManifestLookup,
  type ProjectableCall,
  buildProjectionForCall,
} from "./governance-projection-for-call.js";
export {
  type HermesMcpAddOptions,
  buildHermesMcpAddArgv,
  renderHermesConfigYamlSnippet,
  renderHermesMcpServersConfigYaml,
} from "./hermes-desktop-install.js";
export {
  type ExecMcpServer,
  type ExecMcpServerDeps,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpToolDescriptor,
  argSchemaToJsonSchema,
  createExecMcpServer,
} from "./mcp/exec-mcp-server.js";
export {
  type ExecMcpLoopbackOptions,
  type ExecMcpLoopbackServer,
  type ExecMcpServerDescriptor,
  startExecMcpLoopbackServer,
} from "./mcp/exec-mcp-loopback.js";
export {
  type ExecMcpStdioDescriptor,
  type ExecMcpStdioIo,
  execMcpStdioDescriptor,
  runExecMcpStdio,
} from "./mcp/exec-mcp-stdio.js";
