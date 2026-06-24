#!/usr/bin/env node
/**
 * SLICE-EXEC4c-a — the Hermes-SPAWNABLE governed exec MCP server BIN (stdio transport).
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
 *     OpenShell sandbox + seedRegistry/seedBindings + makeArgsCredentialScreen + an in-process WORM
 *     appender + an in-memory cost hard-cap. The shared-kernel WORM topology + the real OpenShell exec are
 *     validated LIVE in EXEC4c-b (this REAL wiring is best-effort here — diagnostics route to stderr).
 *   • FAKE (gated by AGENTOS_EXEC_MCP_FAKE=1 — for the in-repo subprocess test ONLY): a FakeSandboxAdapter
 *     + an in-memory appender + a created fake sandbox. This is what EXEC4c-a's subprocess test exercises.
 *
 * STDOUT PROTOCOL-ONLY: NOTHING but JSON-RPC protocol envelopes go to stdout (the loop core enforces it).
 * ALL diagnostics (mode, sandbox lifecycle, errors) route to stderr — a real Hermes parses stdout as the
 * MCP wire, so a single banner byte on stdout would corrupt the protocol.
 *
 * CREDENTIAL-BLIND / MINIMAL ENV: the bin NEVER reads `~/.hermes`; it puts NO Agent OS secret on stdout;
 * it reads only the env it needs. The REAL credential boundary is a zero-credential, no-egress sandbox —
 * redaction is best-effort, defense-in-depth.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone (`adapters/hermes/mcp/`). Imports ONLY Node
 * built-ins + sibling hermes modules + the neutral public barrels (cost/tools) + the OpenShell adapter
 * barrel (REAL mode). No deep cross-module import.
 */
import type { CommitAppender } from "../../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../../cost/index.js";
import { authorizeToolInvoke } from "../../../../../tools/index.js";
import type { ExecCapableSandboxAdapter } from "../../../../substrate/index.js";
import { FakeSandboxAdapter } from "../../../../substrate/index.js";
import { makeArgsCredentialScreen } from "../args-credential-screen.js";
import { seedBindings, seedRegistry } from "../exec-seed-tools.js";
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

/** A sandbox spec for the ephemeral sandbox the bin provisions on startup. */
interface BinSandboxSpec {
  readonly image: string;
}

/** What `buildSubstrate` returns: the substrate + the spec to create an ephemeral sandbox against. */
interface SubstrateKit {
  readonly substrate: ExecCapableSandboxAdapter;
  readonly sandboxSpec: BinSandboxSpec;
}

/**
 * Build the exec-capable substrate for the active mode. FAKE (AGENTOS_EXEC_MCP_FAKE=1): an in-memory
 * FakeSandboxAdapter (echoes argv) — the in-repo subprocess test path. REAL: a real OpenShell adapter
 * (best-effort here; the live exec is EXEC4c-b). REAL construction is lazy so the bin's FAKE path never
 * pulls the OpenShell RPC vendor at module load.
 */
async function buildSubstrate(fake: boolean): Promise<SubstrateKit> {
  if (fake) {
    diag("mode=FAKE (in-memory FakeSandboxAdapter)");
    return { substrate: new FakeSandboxAdapter(), sandboxSpec: { image: "fake" } };
  }
  diag("mode=REAL (OpenShell exec-capable substrate)");
  // Lazy import so FAKE mode never loads the OpenShell RPC vendor. REAL-mode wiring is best-effort
  // here — the live OpenShell exec + the shared-kernel WORM are validated by EXEC4c-b.
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
 * Build an in-process WORM appender. FAKE mode: a pure in-memory monotonic-receipt appender. REAL mode:
 * best-effort the SAME in-memory appender (the shared-kernel `createIngestAppender` topology needs the
 * live ingest transport + materials — wired + validated in EXEC4c-b, not in this in-repo slice).
 */
function buildAppender(): CommitAppender<unknown, { id: number }> {
  let receiptId = 0;
  return { append: () => Promise.resolve({ id: ++receiptId }) };
}

/** Assemble the full EXEC4a governed deps over a (pre-provisioned) ephemeral sandbox. */
function buildDeps(substrate: ExecCapableSandboxAdapter, sandboxId: string): ExecMcpServerDeps {
  const registry = seedRegistry();
  const allowRules = [
    {
      id: "allow-exec",
      action: "tool:invoke",
      resource: "exec.**",
      tenantId: BIN_CONTEXT.tenantId,
    },
  ];
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  return {
    substrate,
    sandboxId,
    bindings: seedBindings(),
    registry,
    screen: makeArgsCredentialScreen(),
    authorize: (tc) => {
      const c = tc.context as typeof BIN_CONTEXT;
      const decision = authorizeToolInvoke(
        {
          requestId: c.requestId,
          tenantId: c.tenantId,
          projectId: c.projectId,
          taskId: c.taskId,
          actorId: c.actorId,
          action: "tool:invoke",
          resource: tc.tool,
        },
        registry,
        allowRules,
      );
      return { effect: decision.effect, reason: decision.reason };
    },
    cost,
    estimateTokens: () => 10,
    appender: buildAppender(),
    context: BIN_CONTEXT,
  };
}

/** The bin's entry point: provision an ephemeral sandbox, run the stdio loop, destroy on exit. */
async function main(): Promise<void> {
  const fake = process.env.AGENTOS_EXEC_MCP_FAKE === "1";
  const { substrate, sandboxSpec } = await buildSubstrate(fake);

  // ── Provision the EPHEMERAL sandbox on startup (the surface every tools/call exec targets). ──
  const created = await substrate.createSandbox(BIN_CONTEXT, sandboxSpec);
  if (created.status !== "ok") {
    diag(`fatal: sandbox create denied — ${created.reason}`);
    process.exitCode = 1;
    return;
  }
  const sandboxId = created.sandboxId;
  diag(`ephemeral sandbox created: ${sandboxId}`);
  const started = await substrate.startSandbox(BIN_CONTEXT, sandboxId);
  if (started.status !== "ok") {
    diag(`fatal: sandbox start denied — ${started.reason}`);
    await safeDestroy(substrate, sandboxId);
    process.exitCode = 1;
    return;
  }

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
  const deps = buildDeps(substrate, sandboxId);
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

main().catch((e) => {
  // Fail-closed: any unexpected error is a stderr diagnostic + a non-zero exit — NEVER a stdout banner.
  diag(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
