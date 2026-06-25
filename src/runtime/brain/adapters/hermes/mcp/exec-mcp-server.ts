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
  type ApprovalOutcome,
  type AuthorizeDecision,
  type GovernedToolCallDeps,
  type MaybePromise,
  type ScreenOutcome,
  runGovernedToolCall,
} from "../../../../../orchestration/index.js";
import type { ExecCapableSandboxAdapter, ExecSecretDetector } from "../../../../substrate/index.js";
import { type ExecToolBinding, bindingWrappedExecEffect } from "../exec-closed-loop.js";

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

/**
 * A JSON-Schema property the converter can emit. Either a scalar `{ type: "string" }` (HDI2a) or a
 * string ARRAY `{ type: "array", items: { type: "string" } }` (HDI2b's `exec.run {argv: string[]}`).
 * No other shape is emitted — the converter throws (fail-closed) for anything it cannot derive.
 */
export type JsonSchemaProperty =
  | { readonly type: "string" }
  | { readonly type: "array"; readonly items: { readonly type: "string" } };

/** A JSON-Schema object derived from a binding's strict zod argSchema (the only shape we emit/accept). */
export interface JsonSchemaObject {
  readonly type: "object";
  readonly properties: Readonly<Record<string, JsonSchemaProperty>>;
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
 * zod-to-json-schema) for the bounded set of field shapes our bindings actually use:
 *
 *   - REQUIRES a `ZodObject` with `unknownKeys === "strict"` -> emits `additionalProperties: false`
 *     (so a smuggled key is advertised as DISALLOWED, matching what the strict argSchema rejects).
 *   - a `ZodString` field (optionally wrapped in `ZodOptional`) -> `{ type: "string" }`.
 *   - a `ZodArray` field whose ELEMENT is a `ZodString` (HDI2b's `exec.run {argv: string[]}`),
 *     optionally wrapped in `ZodOptional` -> `{ type: "array", items: { type: "string" } }`. Note:
 *     a `.min(1)` non-empty constraint is an ENFORCEMENT detail of the strict argSchema (the binding
 *     rejects an empty argv) — it is NOT carried into the advertised JSON-Schema; the advertised array
 *     schema (array-of-strings, on a strict object) faithfully matches the SHAPE enforcement accepts.
 *   - a NON-string array element (e.g. `z.array(z.number())`), or ANY other shape -> throws
 *     (fail-closed: we never advertise a schema we cannot faithfully + enforceably derive).
 *
 * The string-array support is the ONLY change vs HDI2a; every other shape stays fail-closed (a number,
 * a number array, an array-of-arrays, an object field, etc. all still THROW).
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

  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(shape)) {
    // Unwrap a single ZodOptional layer (an optional field is derived but NOT required).
    type FieldDef =
      | {
          typeName?: string;
          innerType?: { _def?: FieldDef };
          // ZodEffects (.refine/.transform) carries its inner type under `schema`.
          schema?: { _def?: FieldDef };
          type?: { _def?: { typeName?: string } };
        }
      | undefined;
    const fieldDef = (field as { _def?: unknown })._def as FieldDef;
    let typeName = fieldDef?.typeName;
    let optional = false;
    // The (possibly unwrapped) def carrying the array element type — set when we descend into Optional.
    let resolvedDef = fieldDef;
    if (typeName === "ZodOptional") {
      optional = true;
      resolvedDef = fieldDef?.innerType?._def;
      typeName = resolvedDef?.typeName;
    }
    // SLICE-CAP6 — unwrap a single ZodEffects (`.refine(...)` runtime predicate, e.g. net.fetch's
    // `z.string().min(1).refine(isAllowedFetchUrl)`). The advertised JSON-Schema is the INNER type's
    // schema (a refined string advertises `{type:"string"}`); the refinement is an ENFORCEMENT detail (it
    // can only NARROW what is accepted, never widen) — so the advertised schema stays faithful (no-drift:
    // a value the schema claims valid may still be rejected by the refine, which is the safe direction).
    if (typeName === "ZodEffects") {
      resolvedDef = resolvedDef?.schema?._def;
      typeName = resolvedDef?.typeName;
    }

    if (typeName === "ZodString") {
      properties[key] = { type: "string" };
    } else if (typeName === "ZodArray") {
      // A ZodArray whose ELEMENT is a ZodString -> array/items:string. Any other element -> fail-closed.
      const elementTypeName = resolvedDef?.type?._def?.typeName;
      if (elementTypeName !== "ZodString") {
        // A non-string array element would be an UNENFORCEABLE advertised schema -> never advertise it.
        throw new Error(`argSchemaToJsonSchema: unsupported array element type for '${key}'`);
      }
      properties[key] = { type: "array", items: { type: "string" } };
    } else {
      // We only derive {string} and {string[]} cases. Anything else -> fail-closed (never guess a type).
      throw new Error(`argSchemaToJsonSchema: unsupported field type for '${key}'`);
    }
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
  /** The ToolRegistry the PDP admits against (deny-by-default for any unregistered name). `lookup` sources
   * each advertised tool's description from its registered manifest (single source of truth, no drift). */
  readonly registry: {
    has(name: string): boolean;
    lookup(name: string): { readonly description: string } | undefined;
  };
  /** Credential-blind screen (deps.screen) — the FIRST governed gate. */
  readonly screen: (toolCall: BoundExecCall) => ScreenOutcome;
  /**
   * The SOLE authorization decision (deps.authorize). `MaybePromise` (SLICE-R9a): a sync OR async
   * closure. The passthrough into `runGovernedToolCall` (which now `await`s authorize) needs no new
   * await here — the MCP server only forwards the seam.
   */
  readonly authorize: (toolCall: BoundExecCall) => MaybePromise<AuthorizeDecision>;
  /**
   * OPTIONAL pre-effect approval seam (deps.approve / SLICE-CAP4a). Forwarded VERBATIM into
   * `runGovernedToolCall`, which consults it ONLY when the PDP allow carries `requiresApproval === true`
   * (otherwise NEVER called — the stage is skipped, byte-identical). SLICE-CAP4b wires the bin's budget
   * approver here; absent => a tool that declared it needs approval is denied@approval (fail-closed). The
   * 14 seed tools are all `requiresApproval:false`, so an absent approve is byte-identical for them.
   */
  readonly approve?: (toolCall: BoundExecCall) => MaybePromise<ApprovalOutcome>;
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
      description: descriptionFor(name, deps.registry),
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
    // SLICE-CAP4b — forward the OPTIONAL approve seam VERBATIM. `runGovernedToolCall` consults it ONLY
    // when the PDP allow carries `requiresApproval === true` (the stage is skipped otherwise). Present-only
    // so the 14 requiresApproval:false seed tools stay byte-identical (the stage is never reached for them).
    ...(deps.approve !== undefined ? { approve: deps.approve } : {}),
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
 * The advertised description for a tool — sourced from the registered ToolManifest (the SINGLE source of
 * truth the registry holds, the SAME manifest the PDP admits + governs against), so the advertised
 * description cannot drift from what is registered. Every seed tool (not just echo/ls) thus gets its real
 * manifest description automatically. A name with no registered manifest falls back to the name (fail-safe).
 */
function descriptionFor(
  name: string,
  registry: { lookup(name: string): { readonly description: string } | undefined },
): string {
  return registry.lookup(name)?.description ?? name;
}

function okResponse(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
