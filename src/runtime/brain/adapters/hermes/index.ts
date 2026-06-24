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
export { makeArgsCredentialScreen } from "./args-credential-screen.js";
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
