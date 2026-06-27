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
// SLICE-ACT3a-guard — the real-connector SAFETY GATE (live-off-by-default + test-account allowlist;
// fail-closed). Wraps any ActionConnector; the REAL transport + real account resolver are ACT3a-live
// (deploy/auth-gated). PURE ADDITION — the un-wrapped ACT1/ACT2 composition is unchanged.
export {
  type AccountResolver,
  type ActionGuardConfig,
  type FakeAccountResolverMode,
  FakeAccountResolver,
  actionGuardConfigFromEnv,
  actionLiveFromEnv,
  createGuardedActionConnector,
  testAccountsFromEnv,
} from "./action-guard.js";
export { buildActionProjectionForCall } from "./action-projection-for-call.js";
export {
  CALENDAR_HOST,
  DRIVE_HOST,
  GCAL_OAUTH_KEY_ENV,
  GMAIL_HOST,
  GMAIL_OAUTH_KEY_ENV,
  calendarEventsCreateBinding,
  calendarEventsCreateManifest,
  calendarEventsListBinding,
  calendarEventsListManifest,
  driveFilesDeleteBinding,
  driveFilesDeleteManifest,
  driveReadBinding,
  driveReadManifest,
  gmailSearchBinding,
  gmailSearchManifest,
  gmailSendBinding,
  gmailSendManifest,
  seedActionBindings,
  seedActionRegistry,
  toCredentialEnv,
} from "./action-seed-tools.js";
// SLICE-ACT3a-live-structure — the GoogleActionConnector STRUCTURE (descriptor -> pinned Google REST request)
// + the HttpActionTransport port + in-repo FakeHttpActionTransport. Host per-service PINNED (descriptor can't
// retarget); credential carried as the PLACEHOLDER only (connector never holds a real token); fail-closed
// response mapping. PURE ADDITION — NOT wired into the production bin's live deps; the REAL transport + token
// resolution are ACT3a-live-real (BLOCKED). Wrap with createGuardedActionConnector in composition.
export {
  FakeHttpActionTransport,
  type HttpActionRequest,
  type HttpActionResponse,
  type HttpActionTransport,
  createGoogleActionConnector,
} from "./action-google-connector.js";
// SLICE-ACT3-live — the REAL HttpActionTransport (egress actor: resolves the credential placeholder from env
// at the network boundary, then node fetch) + the PURE testable `resolveCredentialHeaders`. The real `fetch`
// is LIVE-ONLY (operator runner); tests inject a fake fetch. PURE ADDITION — NOT wired into verify's network.
export {
  type FetchImpl,
  type HttpActionTransportOptions,
  type ResolveCredentialError,
  type ResolvedHeaders,
  createHttpActionTransport,
  resolveCredentialHeaders,
} from "./action-http-transport.js";
// SLICE-ACT3-live — the REAL AccountResolver: GET Google userinfo via the injected transport (carrying the
// placeholder), parse `email`; any error/missing/non-2xx => undefined (guard denies, fail-closed).
export { createGoogleAccountResolver } from "./action-google-account-resolver.js";
// SLICE-ACT3-live — the importable CORE of the live self-send runner (the full governed pipeline for
// gmail.send + guard + google connector + real transport). Tested with a FAKE fetch + FAKE resolver (no
// network); the operator runner injects globalThis.fetch (live egress). PURE ADDITION.
export {
  type CapturedHttp,
  type LiveGmailPreflight,
  // SLICE-REPORT-FIX — the HONEST send/not-sent verdict the operator script keys on (never "ok executed"
  // on a non-send): sent === true ONLY when the effect's ActionResult.ok is true.
  type LiveOutcomeVerdict,
  type RunGmailSelfSendOptions,
  type RunGmailSelfSendResult,
  classifyLiveOutcome,
  liveGmailPreflight,
  runGmailSelfSend,
} from "./action-live-gmail-runner.js";
export { makeArgsCredentialScreen } from "./args-credential-screen.js";
export {
  type AgtScope,
  type ManifestLookup,
  type ProjectableCall,
  buildProjectionForCall,
} from "./governance-projection-for-call.js";
// SLICE-ACT5a+b — the BROWSER sub-family: a DISTINCT, STATEFUL, screen-driven governed UI binding (sibling
// to the stateless ActionBinding family; the exec/action seams are UNCHANGED). The brain holds ONLY an
// opaque server-held sessionId (never a handle/cookie); browser.navigate is per-navigation egress-gated;
// browser.read's page content is run through the returnContentSanitizer (data-OUT gate: redact + bound +
// untrusted) BEFORE it reaches the brain. Fake-proven only (no real browser/network; real Chromium = ACT5d;
// NOT advertised to the brain yet = ACT5e). The AgtScope/ManifestLookup/ProjectableCall types are already
// surfaced above (family-agnostic) — NOT re-exported here to avoid a duplicate-name conflict on the barrel.
export {
  type BindingWrappedBrowserEffectOptions,
  type BrowserBinding,
  type BrowserConnector,
  type BrowserPrimitive,
  type BrowserStep,
  type BrowserStepResult,
  type FakeBrowserConnectorOptions,
  type ResolveTextError,
  type ResolvedText,
  type SanitizedContent,
  DEFAULT_READ_MAX_BYTES,
  FakeBrowserConnector,
  bindingWrappedBrowserEffect,
  resolveCredentialText,
  returnContentSanitizer,
} from "./browser-closed-loop.js";
export { buildBrowserProjectionForCall } from "./browser-projection-for-call.js";
export {
  browserClickBinding,
  browserClickManifest,
  browserNavigateBinding,
  browserNavigateManifest,
  browserReadBinding,
  browserReadManifest,
  browserTypeBinding,
  browserTypeManifest,
  seedBrowserBindings,
  seedBrowserRegistry,
} from "./browser-seed-tools.js";
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
