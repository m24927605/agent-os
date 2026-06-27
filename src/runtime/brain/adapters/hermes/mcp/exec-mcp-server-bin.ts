#!/usr/bin/env node
/**
 * SLICE-EXEC4c-a/b — the Hermes-SPAWNABLE governed exec MCP server BIN (stdio transport).
 *
 * A real Hermes spawns this compiled Agent OS `.js` (`node dist/.../exec-mcp-server-bin.js`) and speaks
 * MCP to it over the child's stdin/stdout (newline-delimited JSON-RPC). The bin builds the EXEC4a
 * governed deps, provisions an EPHEMERAL sandbox on startup (destroyed on exit/SIGTERM/SIGINT), and runs
 * the stdio loop CORE (`runExecMcpStdio`) over `process.stdin`/`process.stdout`. EVERY `tools/call` still
 * routes through the single governed edge `runGovernedToolCall` — even though Hermes controls this
 * process's stdin/stdout/lifecycle, it CANNOT tamper with the governance (WE-stay-executor under
 * Hermes-spawn): adversarial JSON-RPC is still governed; killing the bin just stops it (fail-closed).
 *
 * TWO DEPS MODES:
 *   • REAL (default): a real OpenShell exec-capable substrate (`makeOpenShellExecCapable`) + an ephemeral
 *     OpenShell sandbox + seedRegistry/seedBindings + makeArgsCredentialScreen + the SHARED-KERNEL WORM
 *     appender + an in-memory cost hard-cap. The WORM appender is `createPartitionedIngestSink(<the
 *     grpc-js AppendTransport>, <the bin's tenant binding>)` — the SAME shared-kernel composition the
 *     Enterprise composition root wires — so EVERY tools/call receipt is shipped over the ingest wire to
 *     the kernel's PARTITIONED AppendService and lands in the SAME independently-verifiable WORM chain as
 *     the rest of the system (UNIFIED EVIDENCE), not a split in-memory log. The kernel ingest endpoint +
 *     the OpenShell endpoint arrive via the descriptor's MINIMAL env (NON-secret routing, NEVER a
 *     credential). The real OpenShell exec + the receipts landing in the real shared kernel chain are
 *     validated LIVE in EXEC4c-b (this REAL wiring's diagnostics route to stderr).
 *   • FAKE (gated by AGENTOS_EXEC_MCP_FAKE=1 — for the in-repo subprocess test ONLY): a FakeSandboxAdapter
 *     + an IN-MEMORY monotonic-receipt appender + a created fake sandbox. FAKE NEVER reaches the kernel.
 *     This is what EXEC4c-a's subprocess test exercises.
 *
 * COMMIT-BEFORE-EFFECT holds over the shared-kernel appender: `runGovernedToolCall` -> `commitBeforeEffect`
 * appends the AuditEvent, AWAITS the kernel receipt, and ONLY THEN runs the effect. A kernel reject/timeout
 * (the grpc-js adapter fails closed) aborts the commit so the effect never runs (no receipt => no effect).
 *
 * STDOUT PROTOCOL-ONLY: NOTHING but JSON-RPC protocol envelopes go to stdout (the loop core enforces it).
 * ALL diagnostics (mode, sandbox lifecycle, errors) route to stderr — a real Hermes parses stdout as the
 * MCP wire, so a single banner byte on stdout would corrupt the protocol.
 *
 * CREDENTIAL-BLIND / MINIMAL ENV: the bin NEVER reads `~/.hermes`; it puts NO Agent OS secret on stdout;
 * it reads only the env it needs (NON-secret endpoints + the OpenShell client materials' dir). The REAL
 * credential boundary is a zero-credential, no-egress sandbox — redaction is best-effort, defense-in-depth.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (`adapters/hermes/mcp/`). Imports ONLY Node
 * built-ins + sibling hermes modules + the neutral public barrels (audit/cost/tools/ingest/tenant) + the
 * OpenShell adapter barrel (REAL mode, lazy). No deep cross-module import. The ingest barrel is vendor-
 * neutral (no vendor token), and this zone is under an adapter sub-tree, so dependency-cruiser holds.
 */
import { pathToFileURL } from "node:url";
import { type AppendTransport, redactSecrets } from "../../../../../audit/index.js";
import type { CommitAppender } from "../../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate, failClosedCostGate } from "../../../../../cost/index.js";
import {
  type ApprovalOutcome,
  type EffectResult,
  type MaybePromise,
  createBudgetApprover,
} from "../../../../../orchestration/index.js";
import {
  type PolicyDecision,
  type PolicyRequest,
  type SecondaryPolicyAdapter,
  combineDecisions,
  egressDecisionForProjection,
  evaluateSecondaries,
  hostWriteDecisionForProjection,
} from "../../../../../policy/index.js";
import type { TenantBinding } from "../../../../../tenant/index.js";
import { type Primitive, authorizeToolInvoke } from "../../../../../tools/index.js";
import { createPartitionedIngestSink, createRpcAppendTransport } from "../../../../ingest/index.js";
import { integrationsFromEnv } from "../../../../spendguard/index.js";
import type { ExecCapableSandboxAdapter } from "../../../../substrate/index.js";
import { FakeSandboxAdapter } from "../../../../substrate/index.js";
// SLICE-ACT4 — the ACTION family (sibling modules; NON-argv app/API actions). The connector port + the
// binding-wrapped action effect + the seed action manifests/bindings. The REAL guarded connector pieces
// (transport / google connector / account resolver) are LAZILY imported on the live path ONLY (so no test
// path pulls a network vendor, and verify stays network-free).
import {
  type ActionBinding,
  type ActionConnector,
  bindingWrappedActionEffect,
} from "../action-closed-loop.js";
import { createGoogleAccountResolver } from "../action-google-account-resolver.js";
import { createGoogleActionConnector } from "../action-google-connector.js";
import {
  actionLiveFromEnv,
  createGuardedActionConnector,
  testAccountsFromEnv,
} from "../action-guard.js";
import { createHttpActionTransport } from "../action-http-transport.js";
import { buildActionProjectionForCall } from "../action-projection-for-call.js";
import { seedActionBindings, seedActionRegistry } from "../action-seed-tools.js";
import { makeArgsCredentialScreen } from "../args-credential-screen.js";
// SLICE-ACT5e — the BROWSER family (sibling modules; stateful, server-held-session UI primitives). The
// connector port + the binding-wrapped browser effect + the in-repo FakeBrowserConnector + the seed
// browser manifests/bindings/projector. NO real browser/network: the live bin's DEFAULT connector is the
// in-repo Fake (the REAL sandboxed-Chromium page connector needs an injected page — ACT5d, operator-gated),
// so advertising the browser family stays browser-free at the bin level until ACT5d wires a real page.
import {
  type BrowserBinding,
  type BrowserConnector,
  FakeBrowserConnector,
  bindingWrappedBrowserEffect,
} from "../browser-closed-loop.js";
import { buildBrowserProjectionForCall } from "../browser-projection-for-call.js";
import { seedBrowserBindings, seedBrowserRegistry } from "../browser-seed-tools.js";
import { type ExecToolBinding, bindingWrappedExecEffect } from "../exec-closed-loop.js";
import { seedBindings, seedRegistry } from "../exec-seed-tools.js";
import { type AgtScope, buildProjectionForCall } from "../governance-projection-for-call.js";
import {
  type ExecMcpServerDeps,
  type McpToolDescriptor,
  argSchemaToJsonSchema,
} from "./exec-mcp-server.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

/** A single diagnostic line — ALWAYS to stderr (stdout is the protocol-only MCP wire). */
function diag(message: string): void {
  process.stderr.write(`[agentos-exec-mcp] ${message}\n`);
}

/** The minimal AgentContext the spawned bin governs every tools/call under (placeholder, no secret). */
const BIN_CONTEXT = {
  actorId: "agent:hermes-spawned",
  tenantId: "tenant-bin",
  projectId: "proj-bin",
  taskId: "task-bin",
  requestId: "req-bin",
} as const;

/**
 * The bin's tenant binding for the SHARED-KERNEL WORM. partitionId routes every append to THIS tenant's
 * INDEPENDENT kernel partition chain (its own head + signing key); storeRef is the (non-secret) store ref.
 * Closure-bound to one binding inside `createPartitionedIngestSink`, so the bin can only ever write its
 * own partition — cross-tenant write is structurally impossible. All NON-secret routing metadata.
 */
const BIN_TENANT_BINDING: TenantBinding = {
  tenantId: BIN_CONTEXT.tenantId,
  partitionId: BIN_CONTEXT.tenantId,
  storeRef: `worm:${BIN_CONTEXT.tenantId}`,
};

/** A sandbox spec for the ephemeral sandbox the bin provisions on startup. */
interface BinSandboxSpec {
  readonly image: string;
  /**
   * SLICE-CAP6 — the per-sandbox EGRESS ALLOWLIST carried INTO sandbox creation (deny-all default). The
   * REAL OpenShell adapter carries this toward its network policy (the PRIMARY no-egress enforcement, a
   * deploy fact); the Fake substrate records it. This is the SAME allowlist the PDP egress fold uses, so
   * the substrate policy and the in-repo defense-in-depth never skew.
   */
  readonly egressAllow?: readonly string[];
  /**
   * SLICE-CAP9 — the per-sandbox HOST WRITE-TARGET ALLOWLIST carried INTO sandbox creation (deny-all
   * default). The REAL OpenShell adapter carries this toward its host-mount policy (the PRIMARY host-write
   * enforcement, a deploy fact); the Fake substrate records it. This is the SAME allowlist the PDP
   * host-write fold uses, so the substrate policy and the in-repo defense-in-depth never skew.
   */
  readonly hostWriteAllow?: readonly string[];
}

/** What `buildSubstrate` returns: the substrate + the spec to create an ephemeral sandbox against. */
interface SubstrateKit {
  readonly substrate: ExecCapableSandboxAdapter;
  readonly sandboxSpec: BinSandboxSpec;
}

/** Injectable seams so the in-repo test builds the bin's REAL deps with NO real kernel + NO real OpenShell. */
export interface BuildBinOpts {
  /**
   * Inject an `AppendTransport` for the REAL-mode WORM (the in-repo test injects a FAKE; the live bin omits
   * it and a grpc-js `createRpcAppendTransport(fromEnv)` is built). Ignored in FAKE mode (in-memory stub).
   */
  readonly ingestTransport?: AppendTransport;
  /**
   * Inject the exec-capable substrate (the in-repo test injects a Fake so it stays in-repo; the live bin
   * omits it and builds the real OpenShell adapter). When injected, the bin does NOT build OpenShell.
   */
  readonly substrate?: ExecCapableSandboxAdapter;
  /** Test hook invoked the moment the REAL effect starts (proves commit-before-effect order). */
  readonly onEffect?: () => void;
  /**
   * SLICE-SETUP1a — inject the cost gate (a TEST seam: a Fake always-deny / throwing gate proves the bin
   * GATES the autonomous path WITHOUT a real SpendGuard sidecar). The LIVE bin omits this and the gate is
   * derived from env via `integrationsFromEnv(process.env).costGate` (SPENDGUARD_* in the descriptor's
   * `mcp_servers.env`) — falling back to the byte-identical `InMemoryCostGate` when unset. Always wrapped
   * by `failClosedCostGate` (a thrown reserve/commit becomes a structured deny, never an escaping throw).
   */
  readonly costGate?: CostGate;
  /**
   * SLICE-SETUP1a — inject advisory secondaries (a TEST seam: an always-deny / always-allow secondary
   * proves the bin folds them via `combineDecisions` exactly as the three surfaces do — advisory,
   * any-deny-wins, PDP sovereign). The LIVE bin omits this and uses `integrationsFromEnv().secondaries`
   * (absent => []). Env alone cannot carry a code object, so an AGT-style endpoint-backed secondary is a
   * follow-up; this is the plumbing that lets it land without a bin rewrite.
   */
  readonly secondaries?: readonly SecondaryPolicyAdapter[];
  /**
   * SLICE-CAP4b — inject the approve seam (a TEST seam: a Fake approver proves the bin GATES a destructive
   * tool through the CAP4a approval stage WITHOUT needing a real pre-auth config). The LIVE bin omits this
   * and builds `createBudgetApprover(<env-driven pre-auth predicate>)` — UNCONFIGURED => deny-all (fail-
   * closed). Forwarded into `ExecMcpServerDeps.approve` and consulted by `runGovernedToolCall` ONLY when the
   * PDP allow carries `requiresApproval === true` (the 14 seed tools are all false => byte-identical).
   */
  readonly approve?: (toolCall: unknown) => MaybePromise<ApprovalOutcome>;
  /**
   * SLICE-CAP4b — EXTRA seed tools (a TEST seam) added to the bin's registry + bindings so a SYNTHETIC
   * destructive tool (the real destructive tool git.push is Slice 6) proves the END-TO-END approval gate.
   * The bin's registry is built with `wired ⊇ {"approval"}`, so a destructive (approval-requiring) manifest
   * here REGISTERS. Default empty => byte-identical (only the 14 seed tools). The LIVE bin omits this.
   */
  readonly extraSeedTools?: readonly { manifest: unknown; binding: ExecToolBinding }[];
  /**
   * SLICE-CAP4b — EXTRA PDP allow rules (a TEST seam) so an injected `extraSeedTools` name is PDP-
   * authorizable alongside `exec.**` / `git.**`. Advisory secondaries / PDP sovereignty are unchanged.
   * Default empty => byte-identical. The LIVE bin omits this (no extra tools to authorize).
   */
  readonly extraAllowRules?: readonly {
    id: string;
    action: string;
    resource: string;
    tenantId: string;
  }[];
  /**
   * SLICE-CAP5 — inject the bin's PER-SANDBOX EGRESS ALLOWLIST (a TEST seam: a Fake allowlist proves the
   * bin FOLDS the egress defense-in-depth decision into authorize for a tool whose projection carries
   * networkHosts). The LIVE bin omits this and reads `egressAllowFromEnv(process.env)` (the
   * `AGENTOS_EGRESS_ALLOW` allowlist; UNCONFIGURED => EMPTY => deny-all egress, fail-closed). Default
   * EMPTY => deny-all. A tool with NO networkHosts is never gated by it (byte-identical).
   */
  readonly egressAllow?: readonly string[];
  /**
   * SLICE-CAP9 — inject the bin's PER-SANDBOX HOST WRITE-TARGET ALLOWLIST (a TEST seam: a Fake allowlist
   * proves the bin FOLDS the host-write defense-in-depth decision into authorize for a tool whose
   * projection carries writeTargets). The LIVE bin omits this and reads `hostWriteAllowFromEnv(process.env)`
   * (the `AGENTOS_HOST_WRITE_ALLOW` allowlist; UNCONFIGURED => EMPTY => deny-all host-write, fail-closed).
   * Default EMPTY => deny-all. A tool with NO writeTargets is never gated by it (byte-identical).
   */
  readonly hostWriteAllow?: readonly string[];
  /**
   * SLICE-ACT4 — a TEST seam to force the ADVERTISE-ACTIONS master switch ON without setting env (a Fake
   * `true` proves the advertise-on wiring). The LIVE bin omits this and the switch is derived from env via
   * `actionAdvertiseFromEnv(process.env)` (`AGENTOS_ADVERTISE_ACTIONS`; UNCONFIGURED => off => byte-
   * identical). When OFF (default), NONE of the action wiring happens (no manifests/bindings/descriptors/
   * allow rules; the deps.effect stays the exec effect) and an action tools/call is denied at authorize.
   */
  readonly actionAdvertise?: boolean;
  /**
   * SLICE-ACT4 — inject the ACTION connector the dispatcher routes a brain-proposed action to (a TEST seam:
   * a `FakeActionConnector` proves the bin routes + governs an action WITHOUT a real network). Used ONLY
   * when advertise is ON. The LIVE bin omits this and builds the REAL guarded connector
   * (`createGuardedActionConnector(createGoogleActionConnector(createHttpActionTransport(env)), {live:
   * actionLiveFromEnv(env), testAccounts: testAccountsFromEnv(env), resolveAccount:
   * createGoogleAccountResolver(...)})`) — so live execution ADDITIONALLY needs `AGENTOS_ACTION_LIVE` on +
   * a valid token + the test-account allowlist (the ACT3a guard). verify NEVER touches the real network.
   */
  readonly actionConnector?: ActionConnector;
  /**
   * SLICE-ACT5e — a TEST seam to force the ADVERTISE-BROWSER master switch ON without setting env (a Fake
   * `true` proves the advertise-on wiring). The LIVE bin omits this and the switch is derived from env via
   * `browserAdvertiseFromEnv(process.env)` (`AGENTOS_ADVERTISE_BROWSER`; UNCONFIGURED => off => byte-
   * identical). When OFF (default), NONE of the browser wiring happens (no manifests/bindings/descriptors/
   * allow rule; the dispatcher/projection carry NO browser branch) and a browser tools/call is denied at
   * authorize. Exposing a real browser to an autonomous brain is the HEAVIEST posture => deny-by-default.
   */
  readonly browserAdvertise?: boolean;
  /**
   * SLICE-ACT5e — inject the BROWSER connector the dispatcher routes a brain-proposed browser step to (a
   * TEST seam: a `FakeBrowserConnector` proves the bin routes + governs a browser step WITHOUT a real
   * browser / network). Used ONLY when advertise-browser is ON. FAIL-CLOSED in REAL mode: if advertise-
   * browser is ON and this is OMITTED, the bin THROWS at startup (it will NOT back an advertised browser
   * capability with a test double) — the operator must inject the ACT5d sandboxed-Chromium page connector.
   * In FAKE mode an omitted connector defaults to a `FakeBrowserConnector` (the subprocess test stays
   * browser-free). The injected connector MUST expose `hasSession` (the UNKNOWN-SESSION gate) for the
   * advertised live path, or the bin throws (so a brain-supplied phantom sessionId cannot slip past the gate).
   */
  readonly browserConnector?: BrowserConnector;
}

/**
 * SLICE-CAP4b — the env var carrying the PERSONAL pre-authorized allowlist (comma-separated tool names).
 * NON-secret config (a budget/allowlist, not a credential). UNCONFIGURED (unset / empty) => an EMPTY set
 * => a deny-all pre-auth predicate => every approval-requiring tool is denied@approval (fail-closed). The
 * rich per-call budget can be a follow-up; the point of CAP4b is the end-to-end mechanism + deny-by-default.
 */
const APPROVE_PREAUTH_ENV = "AGENTOS_APPROVE_PREAUTH";

/**
 * Build the bin's PERSONAL pre-authorization predicate from env. Reads `AGENTOS_APPROVE_PREAUTH` as a
 * comma-separated allowlist of tool NAMES; a proposed call is pre-authorized iff its `tool` is in the set.
 * UNCONFIGURED (unset / blank / only-whitespace) => an EMPTY set => deny-all (fail-closed). Pure over env.
 */
function preAuthFromEnv(env: NodeJS.ProcessEnv): (toolCall: unknown) => boolean {
  const raw = env[APPROVE_PREAUTH_ENV] ?? "";
  const allow = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  return (toolCall: unknown): boolean => {
    const name = (toolCall as { tool?: unknown } | null)?.tool;
    return typeof name === "string" && allow.has(name);
  };
}

/**
 * SLICE-CAP5 — the env var carrying the bin's PER-SANDBOX EGRESS ALLOWLIST (comma-separated hosts).
 * NON-secret config (a host allowlist, not a credential). UNCONFIGURED (unset / blank / only-whitespace)
 * => an EMPTY list => DENY-ALL egress (the `matchEgressAllow` primitive fail-closes on an empty
 * allowlist). Per-surface allowlist CONTENT is a deploy/config decision; the default is deny-all.
 */
const EGRESS_ALLOW_ENV = "AGENTOS_EGRESS_ALLOW";

/**
 * Build the bin's egress allowlist from env. Reads `AGENTOS_EGRESS_ALLOW` as a comma-separated host
 * list. UNCONFIGURED (unset / blank / only-whitespace) => an EMPTY list => deny-all egress (fail-closed).
 * Pure over env. Mirrors `preAuthFromEnv`'s parse shape.
 */
function egressAllowFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env[EGRESS_ALLOW_ENV] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * SLICE-ACT4 — the env var that is the MASTER SWITCH for ADVERTISING the ACTION family to the brain.
 * DENY-BY-DEFAULT (mirrors `actionLiveFromEnv`): exposing "send an email / delete a file" to an untrusted/
 * autonomous brain is a deliberate security posture, so the action family is advertised + governed ONLY
 * when this is EXACTLY a true-token. UNSET / blank / any other string (incl. "TRUE"/"yes"/"true ") => off.
 */
const ADVERTISE_ACTIONS_ENV = "AGENTOS_ADVERTISE_ACTIONS";

/** The exact tokens that turn the advertise switch ON (mirrors action-guard's LIVE_TRUE_TOKENS). */
const ADVERTISE_TRUE_TOKENS: ReadonlySet<string> = new Set(["true", "1"]);

/**
 * Read the ADVERTISE-ACTIONS master switch from env (FAIL-CLOSED, mirroring `actionLiveFromEnv`). Returns
 * `true` ONLY when `AGENTOS_ADVERTISE_ACTIONS` is EXACTLY a true-token (`"true"` or `"1"`); unset / blank /
 * any other string (e.g. `"false"`, `"TRUE"`, `"yes"`, `"true "`) => `false`. Pure over env —
 * deny-by-default: the default-off bin is BYTE-IDENTICAL (no action manifests/bindings/descriptors/allow
 * rules; an action tools/call is denied at authorize — neither registered nor allow-ruled).
 */
export function actionAdvertiseFromEnv(env: NodeJS.ProcessEnv): boolean {
  return ADVERTISE_TRUE_TOKENS.has(env[ADVERTISE_ACTIONS_ENV] ?? "");
}

/**
 * SLICE-ACT5e — the env var that is the MASTER SWITCH for ADVERTISING the BROWSER family to the brain.
 * DENY-BY-DEFAULT (mirrors `actionAdvertiseFromEnv` / `actionLiveFromEnv`): driving a REAL browser as an
 * untrusted/autonomous brain is the HEAVIEST security posture in the system, so the browser family is
 * advertised + governed ONLY when this is EXACTLY a true-token. UNSET / blank / any other string (incl.
 * "TRUE"/"yes"/"true ") => off.
 */
const ADVERTISE_BROWSER_ENV = "AGENTOS_ADVERTISE_BROWSER";

/**
 * Read the ADVERTISE-BROWSER master switch from env (FAIL-CLOSED, mirroring `actionAdvertiseFromEnv`).
 * Returns `true` ONLY when `AGENTOS_ADVERTISE_BROWSER` is EXACTLY a true-token (`"true"` or `"1"`); unset /
 * blank / any other string (e.g. `"false"`, `"TRUE"`, `"yes"`, `"true "`) => `false`. Pure over env —
 * deny-by-default: the default-off bin is BYTE-IDENTICAL (no browser manifests/bindings/descriptors/allow
 * rule; the dispatcher + projection carry NO browser branch; a browser tools/call is denied at authorize —
 * neither registered nor allow-ruled).
 */
export function browserAdvertiseFromEnv(env: NodeJS.ProcessEnv): boolean {
  return ADVERTISE_TRUE_TOKENS.has(env[ADVERTISE_BROWSER_ENV] ?? "");
}

/**
 * SLICE-CAP6 — the SINGLE source of the bin's per-sandbox egress allowlist: a TEST seam (`opts.egressAllow`)
 * else `egressAllowFromEnv(process.env)` (AGENTOS_EGRESS_ALLOW; UNCONFIGURED => EMPTY => deny-all). Hoisted
 * so the SAME allowlist drives BOTH (a) the substrate `SandboxSpec.egressAllow` (deploy-intent the REAL
 * OpenShell adapter carries toward its network policy — the PRIMARY no-egress enforcement) AND (b) the PDP
 * egress fold in the authorize closure (the in-repo defense-in-depth). One source => no skew between them.
 */
function resolveBinEgressAllow(opts: BuildBinOpts): readonly string[] {
  return opts.egressAllow ?? egressAllowFromEnv(process.env);
}

/**
 * SLICE-CAP9 — the env var carrying the bin's PER-SANDBOX HOST WRITE-TARGET ALLOWLIST (comma-separated
 * absolute roots). NON-secret config (a path-root allowlist, not a credential). UNCONFIGURED (unset /
 * blank / only-whitespace) => an EMPTY list => DENY-ALL host-write (the `matchHostWriteTarget` primitive
 * fail-closes on an empty allowlist). Per-surface allowlist CONTENT is a deploy/config decision; the
 * default is deny-all.
 */
const HOST_WRITE_ALLOW_ENV = "AGENTOS_HOST_WRITE_ALLOW";

/**
 * Build the bin's host-write allowlist from env. Reads `AGENTOS_HOST_WRITE_ALLOW` as a comma-separated
 * root list. UNCONFIGURED (unset / blank / only-whitespace) => an EMPTY list => deny-all host-write
 * (fail-closed). Pure over env. Mirrors `egressAllowFromEnv`'s parse shape.
 */
function hostWriteAllowFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env[HOST_WRITE_ALLOW_ENV] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * SLICE-CAP9 — the SINGLE source of the bin's per-sandbox host-write allowlist: a TEST seam
 * (`opts.hostWriteAllow`) else `hostWriteAllowFromEnv(process.env)` (AGENTOS_HOST_WRITE_ALLOW;
 * UNCONFIGURED => EMPTY => deny-all). Hoisted so the SAME allowlist drives BOTH (a) the substrate
 * `SandboxSpec.hostWriteAllow` (deploy-intent the REAL OpenShell adapter carries toward its host-mount
 * policy — the PRIMARY host-write enforcement) AND (b) the PDP host-write fold in the authorize closure
 * (the in-repo defense-in-depth). One source => no skew between them. (Parallel to resolveBinEgressAllow.)
 */
function resolveBinHostWriteAllow(opts: BuildBinOpts): readonly string[] {
  return opts.hostWriteAllow ?? hostWriteAllowFromEnv(process.env);
}

/**
 * SLICE-ACT5e — resolve the BROWSER connector for the advertise-browser-ON path, FAIL-CLOSED on two fronts:
 *   (1) PROVENANCE — an injected `opts.browserConnector` (the TEST seam / ACT5d operator connector) wins;
 *       else FAKE mode gets a `FakeBrowserConnector` (the subprocess test path stays browser-free, and a
 *       fake actor is honest in fake mode); else (REAL mode + no injected connector) THROW — the live bin
 *       must NOT back an advertised browser capability with a test double.
 *   (2) SESSION-CAPABILITY — the resolved connector MUST expose a `hasSession` method (the UNKNOWN-SESSION
 *       gate `bindingWrappedBrowserEffect` consults). A connector lacking it would let the effect's
 *       session gate fall open (a brain-supplied phantom `sessionId` could reach `perform`), so we THROW
 *       before advertising rather than serve a session-blind browser. `FakeBrowserConnector` exposes it,
 *       so the fake/test paths are unaffected.
 * The bin fails closed at startup on either violation (main catches the throw -> fatal diag + exit 1).
 */
function resolveBrowserConnector(fake: boolean, opts: BuildBinOpts): BrowserConnector {
  const connector =
    opts.browserConnector ??
    (fake
      ? new FakeBrowserConnector()
      : (() => {
          throw new Error(
            "advertise-browser is ON in REAL mode but no browser connector was injected — refusing to " +
              "back an advertised browser capability with a test double (inject the ACT5d page connector; " +
              "fail-closed)",
          );
        })());
  // SESSION-CAPABILITY gate: the advertised path REQUIRES the UNKNOWN-SESSION gate to be enforceable.
  if (typeof (connector as { hasSession?: unknown }).hasSession !== "function") {
    throw new Error(
      "advertise-browser is ON but the browser connector does not expose hasSession — refusing to " +
        "advertise a session-blind browser (the UNKNOWN-SESSION gate must be enforceable; fail-closed)",
    );
  }
  return connector;
}

/**
 * Build the exec-capable substrate for the active mode. FAKE (AGENTOS_EXEC_MCP_FAKE=1): an in-memory
 * FakeSandboxAdapter (echoes argv) — the in-repo subprocess test path. REAL: a real OpenShell adapter
 * (the live exec is EXEC4c-b). REAL construction is lazy so the bin's FAKE path never pulls the OpenShell
 * RPC vendor at module load. An injected substrate short-circuits both (the in-repo REAL-WORM test path).
 */
async function buildSubstrate(
  fake: boolean,
  injected: ExecCapableSandboxAdapter | undefined,
): Promise<SubstrateKit> {
  if (injected !== undefined) {
    return { substrate: injected, sandboxSpec: { image: "injected" } };
  }
  if (fake) {
    diag("mode=FAKE (in-memory FakeSandboxAdapter)");
    return { substrate: new FakeSandboxAdapter(), sandboxSpec: { image: "fake" } };
  }
  diag("mode=REAL (OpenShell exec-capable substrate)");
  // Lazy import so FAKE mode never loads the OpenShell RPC vendor. REAL-mode wiring is best-effort
  // here — the live OpenShell exec is validated by EXEC4c-b.
  const { OpenShellSandboxAdapter, createOpenShellGrpcTransport, makeOpenShellExecCapable } =
    await import("../../../../openshell/index.js");
  const endpoint = process.env.AGENTOS_OPENSHELL_ENDPOINT ?? "127.0.0.1:17670";
  const mtlsDir = process.env.AGENTOS_OPENSHELL_MTLS ?? "";
  const transport = createOpenShellGrpcTransport({
    endpoint,
    caCertPath: `${mtlsDir}/ca.crt`,
    clientCertPath: `${mtlsDir}/tls.crt`,
    clientKeyPath: `${mtlsDir}/tls.key`,
    deadlineMs: 30_000,
  });
  const substrate = makeOpenShellExecCapable(new OpenShellSandboxAdapter(transport));
  const image =
    process.env.AGENTOS_OPENSHELL_IMAGE ??
    "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";
  return { substrate, sandboxSpec: { image } };
}

/**
 * Build the WORM appender for the active mode.
 *
 * FAKE mode: a pure IN-MEMORY monotonic-receipt appender (the EXEC4c-a subprocess test's invariant — FAKE
 * NEVER reaches the kernel, even if a transport is available).
 *
 * REAL mode: the SHARED-KERNEL appender `createPartitionedIngestSink(<AppendTransport>, BIN_TENANT_BINDING)`
 * — the SAME shared-kernel composition the Enterprise composition root wires. EVERY tools/call receipt is
 * canonicalized + redacted (inside `createIngestAppender`, reused by the partitioned sink) and shipped over
 * the wire to the kernel's PARTITIONED AppendService bound to the bin's tenant — so the bin's receipts land
 * in the SAME independently-verifiable chain (UNIFIED EVIDENCE). The transport is injectable: the in-repo
 * test supplies a Fake (no real kernel); the live bin omits it and a grpc-js `createRpcAppendTransport` is
 * built from the NON-secret `AGENTOS_KERNEL_INGEST_ENDPOINT` env. Fail-closed: the transport (and the S1
 * parser) REJECT on any non-receipt, which aborts the commit so the effect never runs.
 */
export function buildBinAppender(
  fake: boolean,
  opts: BuildBinOpts = {},
): CommitAppender<unknown, unknown> {
  if (fake) {
    // FAKE = in-memory monotonic receipt. NEVER the kernel transport (subprocess test stays green).
    let receiptId = 0;
    return { append: () => Promise.resolve({ id: ++receiptId }) };
  }
  // REAL = the shared-kernel partitioned sink over the (injected | grpc-js-from-env) AppendTransport.
  const transport: AppendTransport =
    opts.ingestTransport ??
    createRpcAppendTransport({
      // NON-secret routing endpoint (host:port) — NEVER a credential. Defaults to the conventional local.
      endpoint: process.env.AGENTOS_KERNEL_INGEST_ENDPOINT ?? "127.0.0.1:50051",
    });
  const sink = createPartitionedIngestSink(transport, BIN_TENANT_BINDING);
  // The sink is `(event) => Promise<AppendReceipt>`; the commitgate's CommitAppender is the same single-arg
  // `append(event)` shape, so this slots in with ZERO behavioural change (commit-before-effect preserved).
  return { append: (event) => sink(event as never) };
}

/**
 * Assemble the full EXEC4a governed deps over a (pre-provisioned) ephemeral sandbox + a WORM appender.
 *
 * SLICE-SETUP1a — the bin's governance is now wired FROM ENV so the IT1 SpendGuard/AGT turnkey gates the
 * AUTONOMOUS Hermes path (Hermes -> this spawned bin -> `runGovernedToolCall`), not just the three
 * surfaces. `integrationsFromEnv(process.env)` reads the descriptor's `mcp_servers.env`:
 *   - costGate: `failClosedCostGate(opts.costGate ?? integ.costGate ?? new InMemoryCostGate(...))`.
 *     SPENDGUARD_* set => a SpendGuardCostGate gates the budget (grpc-js LAZY: constructing it connects to
 *     nothing); unset => the byte-identical InMemoryCostGate. `opts.costGate` is a TEST seam (a Fake gate,
 *     no sidecar). `failClosedCostGate` wraps WHICHEVER gate so a thrown reserve/commit -> structured deny.
 *   - authorize: `combineDecisions(<PDP decision>, evaluateSecondaries(secondaries, <req>))`. The PDP
 *     (`authorizeToolInvoke`) stays the SOLE deny authority; advisory secondaries can only NARROW (any-
 *     deny-wins), never relax. `secondaries` defaults to [] => `combineDecisions(pdp, []) === pdp`
 *     (byte-identical). This is the SAME fold the three surfaces use — the bin path's governance == them.
 *
 * DEFAULT BYTE-IDENTICAL: no SPENDGUARD_* env + no opts => InMemoryCostGate (failClosedCostGate is
 * transparent over a non-throwing gate) + `combineDecisions(pdp, [])` === the PDP decision. FAKE mode
 * (`fake === true`, the EXEC4c-a subprocess test) NEVER reads env integrations at all — it is InMemory +
 * [] regardless of ambient SPENDGUARD_*, so the subprocess test is byte-identical by construction.
 */
function buildDeps(
  fake: boolean,
  substrate: ExecCapableSandboxAdapter,
  sandboxId: string,
  appender: CommitAppender<unknown, unknown>,
  opts: BuildBinOpts,
): ExecMcpServerDeps {
  // SLICE-CAP4b — the bin WIRES the "approval" governance primitive into ITS registry, because it injects
  // an `approve` seam (below). COUPLED INVARIANT: an `approve` seam ⟺ "approval" wired for THIS registry —
  // so a destructive (approval-requiring) tool can register here AND is gated by the approval stage. The 14
  // seed tools are all in-sandbox (require NO primitive), so wiring "approval" leaves them byte-identical
  // (it only unlocks registration of a tool that DECLARES it needs approval).
  //
  // SLICE-CAP5 — the bin ALSO WIRES "egress-allowlist", because its authorize closure now FOLDS the egress
  // defense-in-depth decision (`egressDecisionForProjection`) for any tool whose projection carries
  // networkHosts (below). COUPLED INVARIANT: the bin enforces egress ⟺ "egress-allowlist" wired for THIS
  // registry — so a future `containment:"network-egress"` tool (CAP6 git.push / net.fetch) can REGISTER
  // here. The 14 seed tools are all in-sandbox + carry no networkHosts, so wiring it is byte-identical for
  // them (it only unlocks registration of a network-egress tool + gates a tool that PROJECTS hosts).
  //
  // SLICE-CAP9 — the bin ALSO WIRES "host-write-target", because its authorize closure now FOLDS the
  // host-write defense-in-depth decision (`hostWriteDecisionForProjection`) for any tool whose projection
  // carries writeTargets (below). COUPLED INVARIANT: the bin enforces host-write ⟺ "host-write-target"
  // wired for THIS registry — so a future `containment:"host-fs-write"` tool can REGISTER here. The
  // existing seed tools are all in-sandbox + carry no writeTargets, so wiring it is byte-identical for them
  // (it only unlocks registration of a host-fs-write tool + gates a tool that PROJECTS write targets).
  const binWired: ReadonlySet<Primitive> = new Set<Primitive>([
    "approval",
    "egress-allowlist",
    "host-write-target",
  ]);
  // SLICE-ACT4 — the ADVERTISE-ACTIONS master switch. A TEST seam (opts.actionAdvertise) takes precedence;
  // else FAKE mode is ALWAYS off (the EXEC4c-a subprocess test stays byte-identical regardless of ambient
  // env), and REAL mode reads `actionAdvertiseFromEnv(process.env)` (AGENTOS_ADVERTISE_ACTIONS; UNSET =>
  // off). DENY-BY-DEFAULT: off => NONE of the action wiring below (the registry/bindings/allow rules/effect
  // are byte-identical to today; deps.actionDescriptors absent; an action tools/call is denied at authorize
  // — neither registered nor allow-ruled). Exposing actions to an autonomous brain is a deliberate opt-in.
  const advertiseActions =
    opts.actionAdvertise ?? (fake ? false : actionAdvertiseFromEnv(process.env));
  // The bin's `binWired` already contains {approval, egress-allowlist}, so `seedActionRegistry`/
  // `seedActionBindings` register the FULL set (the destructive gmail.send/drive.files.delete need BOTH;
  // the read/write actions need egress-allowlist). When advertise is OFF, we never call them — the action
  // family is fully absent (deny-by-default). The manifests are merged into the bin's SINGLE registry (so
  // the authorize closure's `registry.lookup` sees their containment/requiresApproval -> egress fold /
  // approval / external / boundary all apply, exactly as for net.fetch/git.push).
  const actionRegistry = advertiseActions ? seedActionRegistry(binWired) : undefined;
  const actionBindings: ReadonlyMap<string, ActionBinding> = advertiseActions
    ? seedActionBindings(binWired)
    : new Map<string, ActionBinding>();
  // The action manifests to MERGE into the bin's registry (drained from the freshly-seeded actionRegistry
  // so the SAME parsed manifests drive both lookup and the merge — no duplicate manifest source).
  const actionManifests: readonly unknown[] = advertiseActions
    ? [...actionBindings.keys()]
        .map((name) => actionRegistry?.lookup(name))
        .filter((m) => m !== undefined)
    : [];
  // SLICE-ACT5e — the ADVERTISE-BROWSER master switch (the THIRD family). A TEST seam (opts.browserAdvertise)
  // takes precedence; else FAKE mode is ALWAYS off (the EXEC4c-a subprocess test stays byte-identical), and
  // REAL mode reads `browserAdvertiseFromEnv(process.env)` (AGENTOS_ADVERTISE_BROWSER; UNSET => off).
  // DENY-BY-DEFAULT (heaviest posture): off => NONE of the browser wiring below (registry/bindings/allow
  // rule/descriptors absent; the dispatcher + projection carry NO browser branch — byte-identical; a
  // browser tools/call is denied at authorize — neither registered nor allow-ruled).
  const advertiseBrowser =
    opts.browserAdvertise ?? (fake ? false : browserAdvertiseFromEnv(process.env));
  // The bin's `binWired` contains {approval, egress-allowlist, host-write-target}, so `seedBrowserRegistry`/
  // `seedBrowserBindings` register the FULL browser family: the GOVERNED SESSION LIFECYCLE
  // session.open/close (ACT5f — in-sandbox write, benign, no extra primitive) + navigate (network-egress =>
  // egress-allowlist) + read (in-sandbox) + click/type (destructive => approval). When advertise is OFF, we
  // never call them — the browser family is fully absent (deny-by-default). The manifests are merged into
  // the bin's SINGLE registry (so the authorize closure's `registry.lookup` sees their
  // containment/requiresApproval -> the SAME egress fold / approval / external / boundary all apply, exactly
  // as for net.fetch / gmail.send).
  // INVARIANT (ACT5f): the seeders advertise {browser.session.open/close + navigate/read/click/type}. The
  // governed session lifecycle lets a brain MINT a sessionId and drive the browser end-to-end; the moat is
  // unchanged — session.open MINTS + returns ONLY the opaque sessionId (NEVER the handle/cookies/url), so
  // the brain holds a reference, the actor holds the session. The sessionId itself is never a tool.
  const browserRegistry = advertiseBrowser ? seedBrowserRegistry(binWired) : undefined;
  const browserBindings: ReadonlyMap<string, BrowserBinding> = advertiseBrowser
    ? seedBrowserBindings(binWired)
    : new Map<string, BrowserBinding>();
  const browserManifests: readonly unknown[] = advertiseBrowser
    ? [...browserBindings.keys()]
        .map((name) => browserRegistry?.lookup(name))
        .filter((m) => m !== undefined)
    : [];
  const extraSeedTools = opts.extraSeedTools ?? [];
  const registry = seedRegistry(binWired, [
    ...extraSeedTools.map((t) => t.manifest),
    // SLICE-ACT4 — merge the action manifests so the authorize closure admits + governs them. Empty when
    // advertise is OFF => byte-identical.
    ...actionManifests,
    // SLICE-ACT5e — merge the browser manifests the SAME way. Empty when advertise-browser is OFF =>
    // byte-identical.
    ...browserManifests,
  ]);
  const allowRules = [
    {
      id: "allow-exec",
      action: "tool:invoke",
      resource: "exec.**",
      tenantId: BIN_CONTEXT.tenantId,
    },
    // SLICE-CAP2 — the in-sandbox GIT FAMILY (git.status/diff/log/add/commit) is registered + advertised;
    // it must also be AUTHORIZABLE. PURE ADDITION: a second allow rule alongside `exec.**` (OR-combined),
    // so `exec.**` stays byte-identical. `git.push` is NOT registered (deny-by-default still blocks it —
    // an allow rule never admits an unregistered name), and remains DEFERRED to Slice 5/6.
    {
      id: "allow-git",
      action: "tool:invoke",
      resource: "git.**",
      tenantId: BIN_CONTEXT.tenantId,
    },
    // SLICE-CAP6 — the FIRST real network-egress tool `net.fetch` is registered + advertised on the bin
    // (its "egress-allowlist" primitive is wired below), so it must also be AUTHORIZABLE. PURE ADDITION: a
    // third allow rule alongside exec.**/git.** (OR-combined). The egress fold (below) still GATES it: an
    // allow rule admits the NAME, but a non-allowlisted host is denied@policy by the egress decision. The
    // unregistered git.push is still denied-by-default (an allow rule never admits an unregistered name).
    {
      id: "allow-net",
      action: "tool:invoke",
      resource: "net.**",
      tenantId: BIN_CONTEXT.tenantId,
    },
    // SLICE-ACT4 — the ACTION family allow rules (gmail.**/drive.**/calendar.**), OR-combined alongside the
    // exec.**/git.**/net.** rules, ONLY when advertise is ON. PURE ADDITION: an allow rule admits the NAME,
    // but the egress fold STILL gates the host (a non-allowlisted gmail host => denied@policy) and the
    // approval stage STILL gates a destructive action (gmail.send/drive.files.delete => denied@approval
    // without pre-auth). When advertise is OFF these rules are ABSENT, so an action name is denied at
    // authorize (no allow rule + not registered) — deny-by-default, byte-identical. The PDP still
    // deny-by-defaults an UNREGISTERED name even with these rules present, so they only admit the action
    // manifests merged into the registry above.
    ...(advertiseActions
      ? [
          {
            id: "allow-gmail",
            action: "tool:invoke",
            resource: "gmail.**",
            tenantId: BIN_CONTEXT.tenantId,
          },
          {
            id: "allow-drive",
            action: "tool:invoke",
            resource: "drive.**",
            tenantId: BIN_CONTEXT.tenantId,
          },
          {
            id: "allow-calendar",
            action: "tool:invoke",
            resource: "calendar.**",
            tenantId: BIN_CONTEXT.tenantId,
          },
        ]
      : []),
    // SLICE-ACT5e — the BROWSER family allow rule (`browser.**`), OR-combined alongside the
    // exec.**/git.**/net.**/gmail.**/... rules, ONLY when advertise-browser is ON. PURE ADDITION: an allow
    // rule admits the NAME, but the egress fold STILL gates the navigate host (a non-allowlisted host =>
    // denied@policy) and the approval stage STILL gates a destructive step (browser.click/type =>
    // denied@approval without pre-auth). When advertise-browser is OFF this rule is ABSENT, so a browser
    // name is denied at authorize (no allow rule + not registered) — deny-by-default, byte-identical. The
    // PDP still deny-by-defaults an UNREGISTERED name even with this rule present, so it only admits the
    // browser manifests merged into the registry above.
    ...(advertiseBrowser
      ? [
          {
            id: "allow-browser",
            action: "tool:invoke",
            resource: "browser.**",
            tenantId: BIN_CONTEXT.tenantId,
          },
        ]
      : []),
    // SLICE-CAP4b — EXTRA allow rules (TEST seam: makes an injected synthetic tool PDP-authorizable). Empty
    // by default => byte-identical (the live bin injects none — no extra tools, no extra rules).
    ...(opts.extraAllowRules ?? []),
  ];
  // SLICE-SETUP1a — derive integrations FROM ENV (descriptor `mcp_servers.env`) in REAL mode ONLY. Throws
  // fail-closed on a PARTIAL SpendGuard config (IT1b). FAKE mode skips the env read entirely so the
  // subprocess test stays byte-identical (InMemory + []) regardless of any ambient SPENDGUARD_* on the
  // developer's machine — FAKE never reaches a sidecar, so it must never honor SpendGuard env.
  const integ: {
    costGate?: CostGate;
    secondaries?: readonly SecondaryPolicyAdapter[];
    agtScope?: AgtScope;
  } = fake ? {} : integrationsFromEnv(process.env);
  // The cost gate that GATES the autonomous path: injected (test) | env (SpendGuard) | InMemory default,
  // ALWAYS wrapped fail-closed (a thrown reserve/commit from an external gate -> a structured deny@cost).
  const cost: CostGate = failClosedCostGate(
    opts.costGate ?? integ.costGate ?? new InMemoryCostGate(1_000_000),
  );
  // Advisory secondaries folded into authorize (advisory, any-deny-wins, PDP sovereign). [] => no-op.
  const secondaries: readonly SecondaryPolicyAdapter[] =
    opts.secondaries ?? integ.secondaries ?? [];
  // SLICE-R9b-2b — the bin's bindings + AGT scope drive the governance projection. The scope is "effectful"
  // by default; it is only set non-default when AGT is configured (integ.agtScope from AGT_SCOPE). When AGT
  // is unconfigured, integ.agtScope is absent — but the projection only MATTERS to a configured AGT
  // secondary (an absent secondary never reads it), so building it is harmless and the no-AGT path stays
  // byte-identical (no projection consumer => no behavioural change).
  // SLICE-CAP6 — pass `binWired` so seedBindings INCLUDES net.fetch's binding (and thus its tools/list
  // advertisement) ONLY because the bin has wired "egress-allowlist" AND folds the egress decision below.
  // A composition that has NOT wired egress (the default seedBindings()) advertises neither net.fetch's
  // binding nor its manifest — "a WIRED primitive ⟺ enforcement present" stays honest.
  const bindings = seedBindings(
    new Map<string, ExecToolBinding>(
      extraSeedTools.map((t) => [(t.manifest as { name: string }).name, t.binding]),
    ),
    binWired,
  );
  const agtScope: AgtScope = integ.agtScope ?? "effectful";
  // SLICE-CAP4b — the bin's PERSONAL approve seam. A TEST seam (opts.approve) takes precedence; the LIVE
  // bin builds `createBudgetApprover(<env-driven pre-auth predicate>)` — UNCONFIGURED => deny-all (fail-
  // closed). This is the COUPLED counterpart of wiring "approval" into the registry above: the bin both
  // (a) lets a destructive tool register AND (b) gates it through the approval stage. `runGovernedToolCall`
  // consults `approve` ONLY when the PDP allow carries `requiresApproval === true` (the 14 seed tools are
  // all false => the stage is skipped => byte-identical; the approver is never even called for them).
  const approve: (toolCall: unknown) => MaybePromise<ApprovalOutcome> =
    opts.approve ?? createBudgetApprover(preAuthFromEnv(process.env));
  // SLICE-CAP5 — the bin's PER-SANDBOX EGRESS ALLOWLIST. A TEST seam (opts.egressAllow) takes precedence;
  // the LIVE bin reads `egressAllowFromEnv(process.env)` (AGENTOS_EGRESS_ALLOW; UNCONFIGURED => EMPTY =>
  // deny-all egress, fail-closed). FAKE mode is unaffected (the subprocess test injects no egressAllow and
  // its seed tools carry no networkHosts, so the fold never fires). This is the COUPLED counterpart of
  // wiring "egress-allowlist" into the registry above: the bin both (a) lets a network-egress tool register
  // AND (b) folds the egress decision for a tool whose projection carries networkHosts.
  const binEgressAllow: readonly string[] = resolveBinEgressAllow(opts);
  // SLICE-CAP9 — the bin's PER-SANDBOX HOST WRITE-TARGET ALLOWLIST. A TEST seam (opts.hostWriteAllow) takes
  // precedence; the LIVE bin reads `hostWriteAllowFromEnv(process.env)` (AGENTOS_HOST_WRITE_ALLOW;
  // UNCONFIGURED => EMPTY => deny-all host-write, fail-closed). FAKE mode is unaffected (the subprocess test
  // injects no hostWriteAllow and its seed tools carry no writeTargets, so the fold never fires). This is
  // the COUPLED counterpart of wiring "host-write-target" into the registry above: the bin both (a) lets a
  // host-fs-write tool register AND (b) folds the host-write decision for a tool whose projection carries
  // writeTargets.
  const binHostWriteAllow: readonly string[] = resolveBinHostWriteAllow(opts);
  // SLICE-ACT4 — when advertise is ON, build (a) the ACTION descriptors for tools/list (derived from each
  // binding's STRICT argSchema via the SAME `argSchemaToJsonSchema` converter the exec path uses — no
  // hand-written drift), and (b) the deps.effect DISPATCHER. The dispatcher routes a brain-proposed ACTION
  // (`actionBindings.has(tc.tool)`) to the action connector and an exec tool to the substrate — BOTH still
  // reached ONLY by `runGovernedToolCall` (the single execution edge; no gate bypass). When advertise is
  // OFF, BOTH are `undefined` => the MCP server advertises the exec set only + builds the exec effect
  // exactly as today (byte-identical).
  let actionDescriptors: McpToolDescriptor[] | undefined;
  // SLICE-ACT5e — the BROWSER descriptors for tools/list (derived the SAME no-drift way as the action ones).
  let browserDescriptors: McpToolDescriptor[] | undefined;
  let effect:
    | ((toolCall: {
        tool: string;
        context: unknown;
        args?: Record<string, unknown>;
      }) => Promise<EffectResult>)
    | undefined;
  if (advertiseActions) {
    actionDescriptors = [...actionBindings].map(([name, binding]) => ({
      name,
      description: registry.lookup(name)?.description ?? name,
      inputSchema: argSchemaToJsonSchema(binding.argSchema),
    }));
  }
  // SLICE-ACT5e/ACT5f — when advertise-browser is ON, build the BROWSER descriptors (derived from each
  // browser binding's STRICT argSchema via the SAME `argSchemaToJsonSchema` converter — no hand-written
  // drift). ACT5f's governed session.open/close ARE descriptors now (so a brain can MINT a sessionId);
  // session.open's schema is the empty `{}` (it takes no params — it MINTS), session.close's is `{sessionId}`.
  // The minted sessionId is surfaced ONLY in the session.open RESULT (the moat), never as an input field.
  // OFF => `undefined` => tools/list carries no browser tool (byte-identical).
  if (advertiseBrowser) {
    browserDescriptors = [...browserBindings].map(([name, binding]) => ({
      name,
      description: registry.lookup(name)?.description ?? name,
      inputSchema: argSchemaToJsonSchema(binding.argSchema),
    }));
  }
  // SLICE-ACT4 + ACT5e — when EITHER family is advertised, build the deps.effect DISPATCHER. The dispatcher
  // routes a brain-proposed BROWSER step (`browserBindings.has(tc.tool)`) to the browser connector, an
  // ACTION (`actionBindings.has(tc.tool)`) to the action connector, and an exec tool to the substrate — all
  // three reached ONLY by `runGovernedToolCall` (the single execution edge; no gate bypass). The families
  // are mutually exclusive by name, so the THREE-WAY order is unambiguous. When NEITHER is advertised,
  // `effect` is `undefined` => the MCP server builds the exec effect exactly as today (byte-identical).
  if (advertiseActions || advertiseBrowser) {
    const execEffect = bindingWrappedExecEffect(substrate, sandboxId, bindings);
    // The ACTION connector the dispatcher routes to (only relevant when advertise-actions is ON): a TEST
    // seam (opts.actionConnector — a Fake, no network) takes precedence; the LIVE bin builds the REAL
    // guarded connector. The guard is the live-safety ring: deny-all unless AGENTOS_ACTION_LIVE is on AND
    // the resolved account ∈ the test allowlist. The transport/connector/resolver factories do NO network at
    // construction — `fetch` fires ONLY on a real send, and ONLY when the guard has admitted the call (live
    // + allowlisted). verify always injects the Fake, so no test path touches the network.
    const actionEffect = advertiseActions
      ? bindingWrappedActionEffect(
          opts.actionConnector ??
            (() => {
              const transport = createHttpActionTransport({ env: process.env });
              return createGuardedActionConnector(createGoogleActionConnector(transport), {
                live: actionLiveFromEnv(process.env),
                testAccounts: testAccountsFromEnv(process.env),
                resolveAccount: createGoogleAccountResolver(transport),
              });
            })(),
          actionBindings,
        )
      : undefined;
    // The BROWSER connector the dispatcher routes to (only relevant when advertise-browser is ON). FAIL-
    // CLOSED resolution: a TEST seam (opts.browserConnector) takes precedence; else in FAKE mode a
    // FakeBrowserConnector (the subprocess test path stays browser-free; a fake actor is honest in fake
    // mode); else (REAL mode + advertise-browser ON + NO injected connector) we THROW — the REAL sandboxed-
    // Chromium page connector is ACT5d / operator-injected, so the live bin must NOT silently back an
    // advertised browser capability with a test double (that would expose a fake/unusable browser to an
    // autonomous brain). The operator turns AGENTOS_ADVERTISE_BROWSER on AND injects the ACT5d connector, or
    // the bin fails closed at startup (main catches the throw -> fatal diag + non-zero exit).
    const browserEffect = advertiseBrowser
      ? bindingWrappedBrowserEffect(resolveBrowserConnector(fake, opts), browserBindings)
      : undefined;
    effect = (toolCall) =>
      browserEffect !== undefined && browserBindings.has(toolCall.tool)
        ? browserEffect(toolCall)
        : actionEffect !== undefined && actionBindings.has(toolCall.tool)
          ? actionEffect(toolCall)
          : execEffect(toolCall);
  }
  return {
    substrate,
    sandboxId,
    bindings,
    registry,
    ...(actionDescriptors !== undefined ? { actionDescriptors } : {}),
    ...(browserDescriptors !== undefined ? { browserDescriptors } : {}),
    ...(effect !== undefined ? { effect } : {}),
    screen: makeArgsCredentialScreen(),
    authorize: async (tc) => {
      const c = tc.context as typeof BIN_CONTEXT;
      // The SAME request object fed to BOTH the PDP and the advisory secondaries (a faithful fold — the
      // advisors see EXACTLY what the PDP saw). For `tool:invoke`, `resource` IS the tool name. Built as a
      // plain structural object: `authorizeToolInvoke` takes `unknown` and fail-closed `safeParse`s it
      // (deny-by-default on a malformed shape), so we keep the bin's existing fail-closed PDP semantics
      // unchanged rather than `.parse`-throwing on the branded-id schema.
      const req: {
        requestId: string;
        tenantId: string;
        projectId: string;
        taskId: string;
        actorId: string;
        action: string;
        resource: string;
        governanceProjection?: ReturnType<typeof buildProjectionForCall>;
      } = {
        requestId: c.requestId,
        tenantId: c.tenantId,
        projectId: c.projectId,
        taskId: c.taskId,
        actorId: c.actorId,
        action: "tool:invoke",
        resource: tc.tool,
      };
      // SLICE-R9b-2b — for an IN-SCOPE effectful tool (exec.run) build the R9b-1 governance projection from
      // the BINDING-VALIDATED args and ATTACH it to the request. PRESENT-ONLY: a read-only / out-of-scope /
      // invalid-args / no-projector call yields `undefined`, so the request is left UNCHANGED (byte-identical).
      // The projection is what a configured AGT secondary consumes; an absent AGT secondary never reads it,
      // so attaching it when AGT is unconfigured is a behavioural no-op (PDP ignores it; [] secondaries skip it).
      // SLICE-ACT4 — the projection source is FAMILY-AWARE: an EXEC tool projects via the exec helper
      // (`buildProjectionForCall` over the exec `bindings`); an ACTION tool projects via the SIBLING action
      // helper (`buildActionProjectionForCall` over `actionBindings`). The action helper emits the SAME
      // credential-blind GovernanceProjection (networkHosts = composer-fixed provider host + operationClass
      // + destructiveFlags, NEVER the params), so the SAME egress fold / boundary summary below gate the
      // action exactly as they gate net.fetch. When advertise is OFF, `actionBindings` is EMPTY so the
      // action branch never fires (byte-identical) — and an action tool is denied at the PDP anyway (no
      // allow rule + not registered). An exec tool never appears in `actionBindings`, so only ONE helper
      // ever produces a projection for a given call (no double-projection).
      // SLICE-ACT5e — the projection source is now THREE-WAY (exec | action | browser). A BROWSER tool
      // projects via the SIBLING browser helper (`buildBrowserProjectionForCall` over `browserBindings`).
      // The browser helper emits the SAME credential-blind GovernanceProjection (host-only networkHosts for
      // navigate = `new URL(url).hostname` + operationClass, NEVER the params), so the SAME egress fold /
      // boundary summary below gate browser.navigate exactly as they gate net.fetch. When advertise-browser
      // is OFF, `browserBindings` is EMPTY so the browser branch never fires (byte-identical) — and a browser
      // tool is denied at the PDP anyway (no allow rule + not registered). The three families are mutually
      // exclusive by name, so only ONE helper ever produces a projection for a given call (no double-projection).
      // NON-VACUITY: dropping the browser branch here leaves browser.navigate with NO projectable host => the
      // per-navigation egress gate cannot compare the host against the allowlist (it is keyed on
      // `projection.networkHosts`), so an allowlisted-host navigate would erroneously skip the egress decision
      // (CAP6 fail-closed catches the no-host case, but the per-navigation allow path breaks).
      const projection =
        buildProjectionForCall(
          { tool: tc.tool, ...(tc.args !== undefined ? { args: tc.args } : {}) },
          bindings,
          (name) => registry.lookup(name),
          agtScope,
        ) ??
        buildActionProjectionForCall(
          { tool: tc.tool, ...(tc.args !== undefined ? { args: tc.args } : {}) },
          actionBindings,
          (name) => registry.lookup(name),
          agtScope,
        ) ??
        buildBrowserProjectionForCall(
          { tool: tc.tool, ...(tc.args !== undefined ? { args: tc.args } : {}) },
          browserBindings,
          (name) => registry.lookup(name),
          agtScope,
        );
      if (projection !== undefined) req.governanceProjection = projection;
      // PDP = the SOLE deny authority (deny-by-default for an unregistered tool). It is a `PolicyDecision`.
      const pdp: PolicyDecision = authorizeToolInvoke(req, registry, allowRules);
      // SLICE-CAP5 — the EGRESS defense-in-depth fold. When the tool's credential-blind projection carries
      // networkHosts, build `egressDecisionForProjection(networkHosts, binEgressAllow)` and fold it in as
      // an extra decision (any-deny-wins; PDP sovereign). For an IN-SANDBOX tool with NO projection or NO
      // networkHosts this contributes NOTHING (`[]`), so the 14 seed tools are BYTE-IDENTICAL.
      //
      // SLICE-CAP6 — FAIL-CLOSED for a `containment:"network-egress"` MANIFEST: such a tool punches the seal
      // to the network, so its egress MUST be decided. If its projection is MISSING or carries NO host (a
      // broken/removed projector, an unparseable URL), the gate cannot see the destination -> DENY (never
      // skip). So net.fetch is fail-closed even if its projector were stripped (a hard non-vacuity that does
      // not rely on the e2e host test). An IN-SANDBOX tool is unaffected (no network-egress containment).
      const toolContainment = registry.lookup(tc.tool)?.containment;
      let egressDecisions: PolicyDecision[];
      if (projection !== undefined && projection.networkHosts.length > 0) {
        egressDecisions = [egressDecisionForProjection(projection.networkHosts, binEgressAllow)];
      } else if (toolContainment === "network-egress") {
        // A network-egress tool with no projectable host => fail-closed deny (the destination is unknown).
        egressDecisions = [
          {
            effect: "deny",
            reason:
              "egress: network-egress tool with no projectable host — denied (fail-closed, CAP6)",
            auditRequired: true,
          },
        ];
      } else {
        egressDecisions = [];
      }
      // SLICE-EXEC-HARDENING — the CAP6 cross-cutting gap: a KNOWN network BINARY run via exec.run
      // (containment:"in-sandbox") with an UNVERIFIABLE target. `buildExecRunProjection` classifies
      // basename(argv0) ∈ NETWORK_CMDS {curl,wget,nc,ssh,scp,ftp} as `operationClass === "network"`. A
      // URL-shaped target (`curl https://evil.com`) yields networkHosts -> the egress fold above ALREADY
      // gates it. But a BARE-HOST target with NO scheme (`curl evil.com`) yields networkHosts=[] -> the
      // egress fold (networkHosts.length > 0) does NOT fire, leaving only the substrate seal. FAIL-CLOSED:
      // a network-class projection with NO projectable host => DENY (the destination cannot be verified
      // against the egress allowlist). Keyed PURELY on the projection (operationClass + empty networkHosts),
      // NOT on containment, so it fires for the in-sandbox exec.run too — folded the SAME way the egress
      // decision is (over the projection). A NON-network operationClass (echo/cat/git/…) is UNAFFECTED even
      // if an arg merely CONTAINS a hostname-like string; net.fetch/git.push (network-egress with a
      // projectable host) are UNAFFECTED (they hit the networkHosts.length > 0 branch above). This SHRINKS
      // the PDP's exec.run network blind spot — best-effort defense-in-depth; the substrate seal stays
      // PRIMARY (a non-NETWORK_CMDS custom binary or a shell-wrapped network call can still evade the PDP).
      const networkCommandDecisions: PolicyDecision[] =
        projection !== undefined &&
        projection.operationClass === "network" &&
        projection.networkHosts.length === 0
          ? [
              {
                effect: "deny",
                reason:
                  "network command with unverifiable target — denied (deny-by-default egress, EXEC-HARDENING)",
                auditRequired: true,
              },
            ]
          : [];
      // SLICE-CAP9 — the HOST-WRITE defense-in-depth fold (precise PARALLEL to the CAP5/CAP6 egress fold).
      // When the tool's credential-blind projection carries writeTargets, build
      // `hostWriteDecisionForProjection(writeTargets, binHostWriteAllow)` and fold it in as an extra
      // decision (any-deny-wins; PDP sovereign). For an IN-SANDBOX tool with NO projection or NO
      // writeTargets this contributes NOTHING (`[]`), so the existing seed tools are BYTE-IDENTICAL.
      //
      // FAIL-CLOSED for a `containment:"host-fs-write"` MANIFEST: such a tool punches the seal to the host
      // disk, so its write target MUST be decided. If its projection is MISSING or carries NO writeTarget
      // (a broken/removed projector), the gate cannot see the destination -> DENY (never skip). So a
      // host-fs-write tool is fail-closed even if its projector were stripped (a hard non-vacuity that does
      // not rely on the e2e target test). An IN-SANDBOX tool is unaffected (no host-fs-write containment).
      let hostWriteDecisions: PolicyDecision[];
      if (projection !== undefined && projection.writeTargets.length > 0) {
        hostWriteDecisions = [
          hostWriteDecisionForProjection(projection.writeTargets, binHostWriteAllow),
        ];
      } else if (toolContainment === "host-fs-write") {
        // A host-fs-write tool with no projectable target => fail-closed deny (the destination is unknown).
        hostWriteDecisions = [
          {
            effect: "deny",
            reason:
              "host-write: host-fs-write tool with no projectable write target — denied (fail-closed, CAP9)",
            auditRequired: true,
          },
        ];
      } else {
        hostWriteDecisions = [];
      }
      // Fold the advisory secondaries: any-deny-wins, PDP sovereign (an allow secondary can NEVER relax a
      // PDP deny). `evaluateSecondaries` is fail-closed (a throwing/rejecting advisor => a synthetic deny).
      // SLICE-R9a: it is async (it may await a cross-language advisory), so this closure is `async` and
      // `await`s it; the fold + redact semantics are otherwise unchanged. The structural `req` satisfies
      // `PolicyRequest` shape; the branded-id cast is the same object the PDP just validated.
      const combined = combineDecisions(pdp, [
        ...(await evaluateSecondaries(secondaries, req as unknown as PolicyRequest)),
        ...egressDecisions,
        ...networkCommandDecisions,
        ...hostWriteDecisions,
      ]);
      // SLICE-AGT1-A: redact the combined reason before it leaves the authorize boundary (mirrors the
      // three surfaces' `redactSecrets(combined.reason)` after their fold). An UNTRUSTED advisory
      // secondary's reason can carry a secret; without this scrub it would flow into the commit-before-
      // effect AuditEvent (`decisionReason: decision.reason`, pipeline.ts) -> the bin's WORM. `redactSecrets`
      // on a clean reason is the identity, so the no-secondary default path stays byte-identical.
      //
      // SLICE-CAP4b: set `requiresApproval` FROM THE MANIFEST (`registry.lookup(tc.tool)?.requiresApproval`)
      // so CAP4a's approval stage fires for a destructive (approval-requiring) tool — a SECOND, pre-effect
      // authorization on top of the PDP allow. PDP-SUBORDINATE: this rides ONLY the combined `effect`; a PDP/
      // secondary DENY short-circuits at the policy stage first (the approval stage is never reached). The 14
      // seed tools are all requiresApproval:false (and an unregistered name => `undefined` => `?? false`), so
      // the stage is SKIPPED for them => byte-identical. NON-VACUITY: drop this and the destructive tool's
      // approval gate is bypassed (it executes unapproved) — the bin's deny@approval e2e test flips RED.
      // SLICE-CAP7 — classify the call as EXTERNAL from the SAME manifest `containment` the CAP6 egress
      // fold already read: a seal-PUNCHING containment (network-egress / host-fs-write) is external; an
      // in-sandbox effect is not. When external AND the effect executes, the pipeline appends a DISTINCT
      // post-effect boundary WORM event carrying the ALREADY-redacted `projection` (the SAME R9b-1
      // projection built above for AGT/egress — credential-blind, never raw args). AUDIT-ONLY: this rides
      // ONLY the executed path and NEVER changes the combined allow/deny (PDP sovereign). The 14 in-sandbox
      // seed tools are containment:"in-sandbox" => external:false => NO boundary => byte-identical; only
      // net.fetch (network-egress) flips external:true. NON-VACUITY: drop `external` here and net.fetch's
      // executed call appends ONLY the intent (no boundary) — the bin's CAP7 net.fetch e2e test flips RED.
      const external = toolContainment === "network-egress" || toolContainment === "host-fs-write";
      return {
        effect: combined.effect,
        reason: redactSecrets(combined.reason),
        requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false,
        external,
        ...(projection !== undefined ? { projection } : {}),
      };
    },
    approve,
    cost,
    estimateTokens: () => 10,
    appender,
    context: BIN_CONTEXT,
    ...(opts.onEffect !== undefined ? { onEffect: opts.onEffect } : {}),
  };
}

/**
 * Build the bin's full governed deps for the active mode + provision the ephemeral sandbox. Exported so the
 * in-repo test can construct the bin's REAL deps (REAL shared-kernel appender via an injected Fake
 * transport + an injected Fake substrate) and drive a governed tools/call through `runExecMcpStdio` to
 * prove commit-before-effect over the shared-kernel appender. Returns the deps + the substrate (for
 * teardown / observation). The bin's `main` calls this with no injections (REAL OpenShell + REAL kernel).
 */
export async function buildBinDeps(
  fake: boolean,
  opts: BuildBinOpts = {},
): Promise<{ deps: ExecMcpServerDeps; substrate: ExecCapableSandboxAdapter; sandboxId: string }> {
  const { substrate, sandboxSpec } = await buildSubstrate(fake, opts.substrate);
  // SLICE-CAP6 — thread the bin's egress allowlist INTO the sandbox spec (deny-all default), so the
  // substrate (the PRIMARY no-egress enforcement) gets the SAME policy the PDP egress fold uses. The REAL
  // OpenShell adapter carries it toward its network policy; the Fake records it. One source, no skew.
  const binEgressAllow = resolveBinEgressAllow(opts);
  // SLICE-CAP9 — thread the bin's host-write allowlist INTO the sandbox spec (deny-all default), so the
  // substrate (the PRIMARY host-write enforcement) gets the SAME policy the PDP host-write fold uses. The
  // REAL OpenShell adapter carries it toward its host-mount policy (documented deploy-intent); the Fake
  // records it. One source, no skew.
  const binHostWriteAllow = resolveBinHostWriteAllow(opts);
  const created = await substrate.createSandbox(BIN_CONTEXT, {
    ...sandboxSpec,
    egressAllow: binEgressAllow,
    hostWriteAllow: binHostWriteAllow,
  });
  if (created.status !== "ok") {
    throw new Error(`buildBinDeps: sandbox create denied — ${created.reason}`);
  }
  const sandboxId = created.sandboxId;
  const started = await substrate.startSandbox(BIN_CONTEXT, sandboxId);
  if (started.status !== "ok") {
    await safeDestroy(substrate, sandboxId);
    throw new Error(`buildBinDeps: sandbox start denied — ${started.reason}`);
  }
  const appender = buildBinAppender(fake, opts);
  const deps = buildDeps(fake, substrate, sandboxId, appender, opts);
  return { deps, substrate, sandboxId };
}

/** The bin's entry point: provision an ephemeral sandbox, run the stdio loop, destroy on exit. */
async function main(): Promise<void> {
  const fake = process.env.AGENTOS_EXEC_MCP_FAKE === "1";

  // ── Provision the EPHEMERAL sandbox + assemble deps (REAL: OpenShell substrate + shared-kernel WORM). ──
  let assembled: {
    deps: ExecMcpServerDeps;
    substrate: ExecCapableSandboxAdapter;
    sandboxId: string;
  };
  try {
    assembled = await buildBinDeps(fake);
  } catch (e) {
    diag(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  const { deps, substrate, sandboxId } = assembled;
  diag(`ephemeral sandbox created: ${sandboxId}`);

  // ── Destroy the ephemeral sandbox on ANY exit path (clean EOF, SIGTERM, SIGINT). ──
  let destroyed = false;
  const teardown = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    await safeDestroy(substrate, sandboxId);
    diag(`ephemeral sandbox destroyed: ${sandboxId}`);
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    diag(`received ${sig} — tearing down`);
    void teardown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  // ── Run the stdio loop CORE over process.stdin/stdout (protocol-only stdout). Resolves on EOF. ──
  diag("ready: serving newline-delimited JSON-RPC over stdin/stdout");
  try {
    await runExecMcpStdio(deps, { input: process.stdin, output: process.stdout });
  } finally {
    await teardown();
  }
}

/** Destroy the sandbox, swallowing any error (best-effort teardown never masks the bin's outcome). */
async function safeDestroy(substrate: ExecCapableSandboxAdapter, sandboxId: string): Promise<void> {
  try {
    await substrate.destroySandbox(BIN_CONTEXT, sandboxId);
  } catch (e) {
    diag(`teardown: destroy failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Run `main` ONLY when this module is the process entry point (a real Hermes spawns `node <bin>`). When
// IMPORTED (the in-repo test importing the exported builders), `main` does NOT run — no sandbox, no loop,
// no side effect. This keeps the testable factory functions importable without the bin's startup effect.
const entryUrl = process.argv[1] !== undefined ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl !== undefined && import.meta.url === entryUrl) {
  main().catch((e) => {
    // Fail-closed: any unexpected error is a stderr diagnostic + a non-zero exit — NEVER a stdout banner.
    diag(`fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  });
}
