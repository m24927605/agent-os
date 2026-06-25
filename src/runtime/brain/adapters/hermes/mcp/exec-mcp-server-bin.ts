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
  type PolicyDecision,
  type PolicyRequest,
  type SecondaryPolicyAdapter,
  combineDecisions,
  evaluateSecondaries,
} from "../../../../../policy/index.js";
import type { TenantBinding } from "../../../../../tenant/index.js";
import { authorizeToolInvoke } from "../../../../../tools/index.js";
import { createPartitionedIngestSink, createRpcAppendTransport } from "../../../../ingest/index.js";
import { integrationsFromEnv } from "../../../../spendguard/index.js";
import type { ExecCapableSandboxAdapter } from "../../../../substrate/index.js";
import { FakeSandboxAdapter } from "../../../../substrate/index.js";
import { makeArgsCredentialScreen } from "../args-credential-screen.js";
import { seedBindings, seedRegistry } from "../exec-seed-tools.js";
import { type AgtScope, buildProjectionForCall } from "../governance-projection-for-call.js";
import type { ExecMcpServerDeps } from "./exec-mcp-server.js";
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
  const registry = seedRegistry();
  const allowRules = [
    {
      id: "allow-exec",
      action: "tool:invoke",
      resource: "exec.**",
      tenantId: BIN_CONTEXT.tenantId,
    },
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
  const bindings = seedBindings();
  const agtScope: AgtScope = integ.agtScope ?? "effectful";
  return {
    substrate,
    sandboxId,
    bindings,
    registry,
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
      const projection = buildProjectionForCall(
        { tool: tc.tool, ...(tc.args !== undefined ? { args: tc.args } : {}) },
        bindings,
        (name) => registry.lookup(name),
        agtScope,
      );
      if (projection !== undefined) req.governanceProjection = projection;
      // PDP = the SOLE deny authority (deny-by-default for an unregistered tool). It is a `PolicyDecision`.
      const pdp: PolicyDecision = authorizeToolInvoke(req, registry, allowRules);
      // Fold the advisory secondaries: any-deny-wins, PDP sovereign (an allow secondary can NEVER relax a
      // PDP deny). `evaluateSecondaries` is fail-closed (a throwing/rejecting advisor => a synthetic deny).
      // SLICE-R9a: it is async (it may await a cross-language advisory), so this closure is `async` and
      // `await`s it; the fold + redact semantics are otherwise unchanged. The structural `req` satisfies
      // `PolicyRequest` shape; the branded-id cast is the same object the PDP just validated.
      const combined = combineDecisions(
        pdp,
        await evaluateSecondaries(secondaries, req as unknown as PolicyRequest),
      );
      // SLICE-AGT1-A: redact the combined reason before it leaves the authorize boundary (mirrors the
      // three surfaces' `redactSecrets(combined.reason)` after their fold). An UNTRUSTED advisory
      // secondary's reason can carry a secret; without this scrub it would flow into the commit-before-
      // effect AuditEvent (`decisionReason: decision.reason`, pipeline.ts) -> the bin's WORM. `redactSecrets`
      // on a clean reason is the identity, so the no-secondary default path stays byte-identical.
      return { effect: combined.effect, reason: redactSecrets(combined.reason) };
    },
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
  const created = await substrate.createSandbox(BIN_CONTEXT, sandboxSpec);
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
