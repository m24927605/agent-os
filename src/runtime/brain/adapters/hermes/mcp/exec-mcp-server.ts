/**
 * SLICE-EXEC4a — a protocol-level, GOVERNED MCP server that advertises ONLY our two seed exec tools and
 * routes EVERY `tools/call` through the EXISTING governed pipeline (`runGovernedToolCall`).
 *
 * WHO EXECUTES (the EXEC4 thesis): in ACP+MCP the brain (Hermes) is the MCP *client*; it `tools/call`s
 * OUR server, and OUR handler executes + returns the result — the brain NEVER self-runs. This module is
 * the server side of that boundary, and it is TRANSPORT-AGNOSTIC: `handle(request)` takes a PARSED
 * JSON-RPC request object and returns a response object. The live stdio/http transport is EXEC4b.
 *
 * THE LOAD-BEARING EXEC4 GATE — single execution path: the `tools/call` handler routes EVERY call through
 * `runGovernedToolCall` ONLY (screen -> authorize -> cost -> commit-before-effect -> effect). It NEVER
 * calls `makeExecEffect` / the substrate / `bindingWrappedExecEffect` directly to *execute* — the effect
 * is INJECTED into the governed deps and is only reached by the pipeline AFTER every gate passes and the
 * audit receipt is in hand. There is exactly ONE execution edge: `runGovernedToolCall`.
 *
 * tools/list — advertises EXACTLY the `seedBindings()` keys (exec.echo, exec.ls). Each `inputSchema` is
 * DERIVED from that binding's STRICT `argSchema` via the in-house `argSchemaToJsonSchema` (single source
 * of truth — no hand-written constant that could drift from the schema enforcement actually applies).
 *
 * Fail-closed dispatch (mirrors `acp-stdio.ts`): a malformed request -> a parse/invalid-request error; an
 * unknown method -> `-32601` (method not found); NEVER a fabricated ok, NEVER a default-allow.
 *
 * HONEST BOUNDARY: EXEC4a proves the GOVERNED MCP boundary against a FAKE MCP client (scripted JSON-RPC
 * requests -> asserted responses) + a FAKE substrate. Advertising our mcpServers to a REAL Hermes + the
 * real descriptor shape (stdio vs http/sse) + autonomous discovery = EXEC4b (a posture + security
 * decision). `clientCapabilities` stay frozen-empty (acp-stdio.ts unchanged — orthogonal to mcpServers).
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (`adapters/hermes/mcp/`). Imports ONLY the
 * neutral public barrels (orchestration types, audit `redactSecrets`) + the sibling hermes modules
 * (`exec-closed-loop` for `bindingWrappedExecEffect`/`ExecToolBinding`). No deep cross-module import.
 */
import type { z } from "zod";
import { redactSecrets } from "../../../../../audit/index.js";
import type { CommitAppender } from "../../../../../commitgate/index.js";
import type { CostGate } from "../../../../../cost/index.js";
import {
  type AuthorizeDecision,
  type GovernedToolCallDeps,
  type ScreenOutcome,
  runGovernedToolCall,
} from "../../../../../orchestration/index.js";
import type { ExecCapableSandboxAdapter, ExecSecretDetector } from "../../../../substrate/index.js";
import { type ExecToolBinding, bindingWrappedExecEffect } from "../exec-closed-loop.js";
import { echoManifest, lsManifest } from "../exec-seed-tools.js";

// ------------------------------------------------------------------------------------------------
// JSON-RPC envelope (transport-agnostic). The live transport (stdio/http) is EXEC4b.
// ------------------------------------------------------------------------------------------------

/** A parsed JSON-RPC request object (the transport hands us this; we never read raw bytes here). */
export interface JsonRpcRequest {
  readonly jsonrpc?: string;
  readonly id?: number | string | null;
  readonly method?: unknown;
  readonly params?: unknown;
}

/** A JSON-RPC response object (the transport serializes this). */
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: number | string | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

// JSON-RPC error codes (subset; mirrors acp-stdio.ts).
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;

// ------------------------------------------------------------------------------------------------
// MCP tool descriptor + result shapes.
// ------------------------------------------------------------------------------------------------

/** A JSON-Schema object derived from a binding's strict zod argSchema (the only shape we emit/accept). */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Readonly<Record<string, { readonly type: string }>>;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

/** An MCP tool descriptor as returned by `tools/list`. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
}

/** An MCP `tools/call` result. `executed` -> isError:false; any deny / failure -> isError:true. */
export interface McpToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly isError: boolean;
}

// ------------------------------------------------------------------------------------------------
// In-house argSchema -> JSON-Schema converter (no new dep). Handles the 2 simple `{string}` cases.
// ------------------------------------------------------------------------------------------------

/**
 * Derive a JSON-Schema object from a binding's STRICT zod object schema — the SINGLE SOURCE OF TRUTH for
 * the advertised `inputSchema`. We DELIBERATELY do NOT hand-write a constant that could drift from the
 * schema enforcement actually applies at `tools/call` time. A tiny in-house converter (NOT
 * zod-to-json-schema) for the two simple `z.object({ k: z.string() }).strict()` shapes:
 *
 *   - REQUIRES a `ZodObject` with `unknownKeys === "strict"` -> emits `additionalProperties: false`
 *     (so a smuggled `argv` key is advertised as DISALLOWED, matching what the strict argSchema rejects).
 *   - each field is a `ZodString` (optionally wrapped in `ZodOptional`) -> `{ type: "string" }`;
 *     a NON-optional field is added to `required`.
 *   - any OTHER shape -> throws (fail-closed: we never advertise a schema we cannot faithfully derive).
 */
export function argSchemaToJsonSchema(argSchema: z.ZodType<unknown>): JsonSchemaObject {
  // Narrow via the zod internal def (zod 3.x). We read only the public-ish `_def` fields we need; an
  // unexpected shape THROWS (fail-closed) rather than silently advertising a looser/empty schema.
  const def = (argSchema as { _def?: unknown })._def as
    | { typeName?: string; unknownKeys?: string; shape?: () => Record<string, unknown> }
    | undefined;

  if (def === undefined || def.typeName !== "ZodObject") {
    throw new Error("argSchemaToJsonSchema: expected a ZodObject");
  }
  if (def.unknownKeys !== "strict") {
    // A non-strict object would let unknown keys through enforcement -> we must NOT advertise
    // additionalProperties:false against it (that would be a drift). Fail-closed: refuse to derive.
    throw new Error("argSchemaToJsonSchema: expected a .strict() ZodObject (no-drift requirement)");
  }
  const shape = typeof def.shape === "function" ? def.shape() : undefined;
  if (shape === undefined) {
    throw new Error("argSchemaToJsonSchema: ZodObject has no shape");
  }

  const properties: Record<string, { type: string }> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    const fieldDef = (field as { _def?: unknown })._def as
      | { typeName?: string; innerType?: { _def?: { typeName?: string } } }
      | undefined;
    let typeName = fieldDef?.typeName;
    let optional = false;
    if (typeName === "ZodOptional") {
      optional = true;
      typeName = fieldDef?.innerType?._def?.typeName;
    }
    if (typeName !== "ZodString") {
      // We only derive the simple {string} cases. Anything else -> fail-closed (never guess a type).
      throw new Error(`argSchemaToJsonSchema: unsupported field type for '${key}'`);
    }
    properties[key] = { type: "string" };
    if (!optional) required.push(key);
  }

  return { type: "object", properties, required, additionalProperties: false };
}

// ------------------------------------------------------------------------------------------------
// Server deps + construction.
// ------------------------------------------------------------------------------------------------

/** The proposal shape the governed pipeline + the binding-wrapped effect operate on. */
interface BoundExecCall {
  readonly tool: string;
  readonly context: unknown;
  readonly args?: Record<string, unknown>;
}

/**
 * Everything the governed MCP server needs. The screen/authorize/cost/appender are the SAME governance the
 * closed loop uses (the composition root wires them); the server builds the binding-wrapped effect from
 * `substrate + sandboxId + bindings` and injects it into `runGovernedToolCall`. `tools/list` reads
 * `registry`/`bindings` (the advertised set is the bounded seed tools; their schemas derive from the
 * bindings). `context` is the AgentContext the single-call layer governs under.
 */
export interface ExecMcpServerDeps {
  /** The exec-capable substrate (Fake in EXEC4a; real OpenShell in EXEC4b). */
  readonly substrate: ExecCapableSandboxAdapter;
  /** The sandbox id the effect targets (the host wires lifecycle; EXEC4a uses a fixed id). */
  readonly sandboxId: string;
  /** The composer-held bindings (parallel to the registry). tools/list advertises EXACTLY these keys. */
  readonly bindings: ReadonlyMap<string, ExecToolBinding>;
  /** The ToolRegistry the PDP admits against (deny-by-default for any unregistered name). */
  readonly registry: { has(name: string): boolean };
  /** Credential-blind screen (deps.screen) — the FIRST governed gate. */
  readonly screen: (toolCall: BoundExecCall) => ScreenOutcome;
  /** The SOLE authorization decision (deps.authorize). */
  readonly authorize: (toolCall: BoundExecCall) => AuthorizeDecision;
  /** Budget hard-cap (deps.cost). */
  readonly cost: CostGate;
  /** Token estimator (deps.estimateTokens). */
  readonly estimateTokens: (toolCall: BoundExecCall) => number;
  /** Append-before-effect appender (deps.appender / commitgate). */
  readonly appender: CommitAppender<unknown, unknown>;
  /** Cap (UTF-8 bytes) for the redacted combined output. Forwarded to the binding-wrapped effect. */
  readonly maxOutputBytes?: number;
  /** Secret detector for the credential-blind INPUT guard. Forwarded to the binding-wrapped effect. */
  readonly detectSecret?: ExecSecretDetector;
  /** The AgentContext the single MCP call is governed under. */
  readonly context: unknown;
  /** Optional probe invoked the moment the REAL effect starts (test hook for commit-before-effect order). */
  readonly onEffect?: () => void;
}

/** The transport-agnostic governed MCP server. */
export interface ExecMcpServer {
  /** Handle ONE parsed JSON-RPC request, returning a JSON-RPC response. Fail-closed. */
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse>;
}

const SERVER_INFO = { name: "agent-os-exec", version: "1.0.0" } as const;

/**
 * Build the governed MCP server. The returned `handle` dispatches `initialize` / `tools/list` /
 * `tools/call`; anything else or a malformed request is a fail-closed JSON-RPC error.
 */
export function createExecMcpServer(deps: ExecMcpServerDeps): ExecMcpServer {
  // Derive the advertised tool descriptors ONCE from the bindings (single source of truth). A binding
  // whose schema cannot be derived faithfully throws here — we never advertise a tool with a schema we
  // cannot enforce-match.
  const descriptors: McpToolDescriptor[] = [];
  for (const [name, binding] of deps.bindings) {
    descriptors.push({
      name,
      description: descriptionFor(name, binding),
      inputSchema: argSchemaToJsonSchema(binding.argSchema),
    });
  }

  return {
    handle(request: JsonRpcRequest): Promise<JsonRpcResponse> {
      const id = request.id ?? null;

      // Fail-closed parse/shape guard (mirror acp-stdio.ts: malformed -> error, never a fabricated ok).
      if (request === null || typeof request !== "object") {
        return Promise.resolve(errorResponse(id, PARSE_ERROR, "parse error"));
      }
      if (typeof request.method !== "string") {
        return Promise.resolve(
          errorResponse(id, INVALID_REQUEST, "invalid request: missing method"),
        );
      }

      switch (request.method) {
        case "initialize":
          return Promise.resolve(
            okResponse(id, {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO,
            }),
          );
        case "tools/list":
          return Promise.resolve(okResponse(id, { tools: descriptors }));
        case "tools/call":
          return handleToolsCall(deps, id, request.params);
        default:
          // Unknown method -> -32601 (deny-by-default at the protocol layer; never default-allow).
          return Promise.resolve(
            errorResponse(id, METHOD_NOT_FOUND, `method not found: ${request.method}`),
          );
      }
    },
  };
}

/**
 * The `tools/call` handler. It maps `{name, arguments}` to the `BoundExecCall` the loop already governs
 * and routes it through `runGovernedToolCall` — the SINGLE execution edge. It NEVER calls the substrate /
 * `makeExecEffect` / `bindingWrappedExecEffect` to EXECUTE outside the pipeline: the effect is INJECTED
 * into the governed deps and reached only by the pipeline after every gate + the audit receipt.
 */
async function handleToolsCall(
  deps: ExecMcpServerDeps,
  id: number | string | null,
  params: unknown,
): Promise<JsonRpcResponse> {
  // Malformed params -> deny (fail-closed). A non-object params, or a missing/non-string `name`, is an
  // invalid request — never a fabricated ok, never an exec.
  if (params === null || typeof params !== "object") {
    return errorResponse(id, INVALID_REQUEST, "invalid params: expected an object");
  }
  const name = (params as { name?: unknown }).name;
  if (typeof name !== "string") {
    return errorResponse(id, INVALID_REQUEST, "invalid params: missing tool name");
  }
  const rawArgs = (params as { arguments?: unknown }).arguments;
  const args =
    rawArgs !== null && typeof rawArgs === "object"
      ? (rawArgs as Record<string, unknown>)
      : undefined;

  // Build the binding-wrapped effect for the fixed (substrate, sandboxId). This is the INJECTED effect —
  // the pipeline is the ONLY caller of it. Tagging via `onEffect` lets a test observe commit-before-effect.
  const baseEffect = bindingWrappedExecEffect(deps.substrate, deps.sandboxId, deps.bindings, {
    ...(deps.maxOutputBytes !== undefined ? { maxOutputBytes: deps.maxOutputBytes } : {}),
    ...(deps.detectSecret !== undefined ? { detectSecret: deps.detectSecret } : {}),
  });
  // The pipeline maps a reached-but-failed effect (binding deny / strict-schema reject / failed exec) to an
  // "executed" outcome that DROPS `EffectResult.ok`. We capture that flag here so the MCP result reports
  // `isError:true` for a failed effect (e.g. a smuggled `argv` key the binding rejected) — a fabricated
  // ok would be the failure mode. `false` until an effect actually ran.
  let effectOk = false;
  const effect: GovernedToolCallDeps<BoundExecCall, unknown>["effect"] = async (toolCall) => {
    deps.onEffect?.();
    const res = await baseEffect(toolCall);
    effectOk = res.ok;
    return res;
  };

  const governedDeps: GovernedToolCallDeps<BoundExecCall, unknown> = {
    screen: deps.screen,
    authorize: deps.authorize,
    cost: deps.cost,
    estimateTokens: deps.estimateTokens,
    appender: deps.appender,
    effect,
  };

  const call: BoundExecCall = {
    tool: name,
    context: deps.context,
    ...(args !== undefined ? { args } : {}),
  };

  // THE SINGLE EXECUTION EDGE. Every tools/call goes through here — never a direct substrate/effect call.
  const outcome = await runGovernedToolCall(governedDeps, call);

  if (outcome.status === "executed") {
    // The effect RAN (commit-before-effect held). But a reached-but-failed effect (binding deny /
    // strict-schema reject of a smuggled key / failed exec) reports `ok:false` -> isError:true; only a
    // genuinely successful command is isError:false. The detail is already redacted by the exec effect;
    // redact again (defense-in-depth) before it egresses to the (untrusted) client.
    const text = redactSecrets(outcome.detail ?? "");
    return okResponse(id, toolResult(text, !effectOk));
  }
  // denied at a GOVERNED gate (screen/policy/cost/commit) -> isError:true. Redact the reason too
  // (defense-in-depth; e.g. a secret-shaped arg must not echo back in the deny text).
  const text = `DENIED: ${outcome.stage} — ${redactSecrets(outcome.reason)}`;
  return okResponse(id, toolResult(text, true));
}

/** Build an MCP tool result envelope. */
function toolResult(text: string, isError: boolean): McpToolResult {
  return { content: [{ type: "text", text }], isError };
}

/**
 * The advertised description for a seed tool — taken DIRECTLY from the shared seed manifests
 * (`exec-seed-tools.ts`), the SAME source the registry registers, so the advertised description cannot
 * drift from the registered manifest. A name with no known manifest falls back to the name (fail-safe).
 */
const MANIFEST_DESCRIPTIONS: ReadonlyMap<string, string> = new Map([
  [echoManifest.name, echoManifest.description],
  [lsManifest.name, lsManifest.description],
]);

function descriptionFor(name: string, _binding: ExecToolBinding): string {
  return MANIFEST_DESCRIPTIONS.get(name) ?? name;
}

function okResponse(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
