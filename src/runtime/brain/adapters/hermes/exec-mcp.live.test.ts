/**
 * SLICE-EXEC4b — the GATED LIVE AUTONOMOUS-MCP HARNESS: a REAL desktop `hermes acp` brain is handed our
 * in-process governed MCP loopback server in `session/new.mcpServers`, AUTONOMOUSLY discovers our bounded
 * exec tools via `tools/list`, calls one via `tools/call`, and the call lands in OUR in-process
 * `runGovernedToolCall` -> REAL OpenShell exec -> real result. This is the autonomous SUCCESS path that
 * EXEC3b (A)+(B) structurally could NOT show (a real Hermes proposing OUR tools needs MCP advertisement).
 *
 * WHO EXECUTES (the EXEC4 thesis, live): Hermes is the MCP *client*; it POSTs `tools/call` to the loopback
 * URL Agent OS hosts IN-PROCESS; OUR handler routes it through the single governed edge and returns the
 * real OpenShell output. Hermes NEVER self-executes. The WORM/governance stay in OUR process (the
 * loopback transport keeps them whole — it does not split them into a child).
 *
 * ⚠️ DO NOT RUN UNDER `pnpm run verify`. Dual-gated (both must be "1"):
 *   AGENTOS_LIVE_DESKTOP_HERMES (real Hermes, real model credits) AND AGENTOS_LIVE_OPENSHELL (real sandbox
 *   side effects). Unset -> the suite is `describe.skip` (NO-OP, hermetic, zero credits). Run via the live
 *   harness: `pnpm run e2e:live-exec-mcp` (preflight BLOCKS clean if the gates are unset).
 *
 * ASSERTIONS (the things ONLY the live run can pin — the real descriptor shape + autonomous discovery):
 *   1. >=1 EXECUTED outcome over the loopback server for a registered+bound tool (exec.echo/exec.ls) with
 *      a real exit=0 — the real Hermes AUTONOMOUSLY discovered (tools/list) + called (tools/call) -> our
 *      governed pipeline -> real OpenShell exec.
 *   2. DENY-BY-DEFAULT / PROPOSE-ONLY still hold for any of Hermes's OTHER (non-advertised / built-in) tool
 *      attempts surfaced as session/update tool_calls — they re-enter the closed-loop governance and are
 *      denied (not our registered names) / never self-executed.
 *   3. EPHEMERAL sandbox create+destroy (loopback server's sandbox AND the closed loop's sandbox).
 *   4. OBSERVABILITY (console.info): what Hermes discovered via tools/list + which tool it called — the
 *      signal for whether the real ACP `mcpServers` descriptor shape worked.
 *   5. FAIL-CLOSED-WITH-DIAGNOSTIC: if the real Hermes does NOT accept the descriptor / never discovers,
 *      the test FAILS with a clear message (the real descriptor shape is what this run pins) — never a
 *      hang (the transport startup/idle guards + the per-test timeout bound it), never a false pass.
 *
 * CREDENTIAL-BLIND: this file NEVER reads `~/.hermes`, NEVER puts an Agent OS secret on the child's stdin,
 * and reads the OpenShell mTLS materials only from the OpenShell CLI's local store. Redaction is
 * best-effort — the REAL credential boundary is a sandbox provisioned with ZERO real credentials + NO
 * egress, not redaction. The nudge intents run benign echo/ls only.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import type {
  GovernedCall,
  GovernedOutcome,
  GovernedToolCallDeps,
} from "../../../../orchestration/index.js";
import { authorizeToolInvoke } from "../../../../tools/index.js";
import {
  OpenShellSandboxAdapter,
  createOpenShellGrpcTransport,
  makeOpenShellExecCapable,
} from "../../../openshell/index.js";
import type {
  AdapterResult,
  ExecCapableSandboxAdapter,
  ExecCommandSpec,
  ExecResult,
  SandboxSpec,
} from "../../../substrate/index.js";
import { runExecClosedLoop } from "./exec-closed-loop.js";
import {
  AcpStdioTransport,
  type ExecMcpServerDeps,
  makeArgsCredentialScreen,
  seedBindings,
  seedRegistry,
  startExecMcpLoopbackServer,
} from "./index.js";

// ── GATES ──────────────────────────────────────────────────────────────────────────────────────
const LIVE_HERMES = process.env.AGENTOS_LIVE_DESKTOP_HERMES === "1";
const LIVE_OPENSHELL = process.env.AGENTOS_LIVE_OPENSHELL === "1";
/** EXEC4b needs BOTH gates (a REAL Hermes that discovers our tools + a REAL OpenShell sandbox). */
const dAutonomous = LIVE_HERMES && LIVE_OPENSHELL ? describe : describe.skip;

/** The empirically-confirmed openclaw boot image (pinned @sha256 digest; passes assertPinnedImageDigest). */
const SANDBOX_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

const MTLS = join(homedir(), ".config/openshell/gateways/openshell/mtls");

/** Build the REAL OpenShell mTLS gRPC adapter (same wiring as the EXEC3b live capstone). */
function realOpenShellAdapter(): OpenShellSandboxAdapter {
  const transport = createOpenShellGrpcTransport({
    endpoint: "127.0.0.1:17670",
    caCertPath: join(MTLS, "ca.crt"),
    clientCertPath: join(MTLS, "tls.crt"),
    clientKeyPath: join(MTLS, "tls.key"),
    deadlineMs: 30_000,
  });
  return new OpenShellSandboxAdapter(transport);
}

/**
 * Wrap the REAL exec-capable OpenShell adapter so `startSandbox` BLOCKS until the freshly-created sandbox
 * reaches READY (OpenShell's startSandbox is an honest noop shim). Test-local readiness gate ONLY — every
 * other method (create/exec/destroy) is the REAL OpenShell wrapper, unchanged. Bounded + fail-closed.
 */
function readinessGatedExecCapable(
  adapter: OpenShellSandboxAdapter,
  readyDeadlineMs: number,
): ExecCapableSandboxAdapter {
  const real = makeOpenShellExecCapable(adapter);
  return {
    createSandbox: (ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> =>
      real.createSandbox(ctx, spec),
    stopSandbox: (ctx: unknown, sandboxId: string): Promise<AdapterResult> =>
      real.stopSandbox(ctx, sandboxId),
    destroySandbox: (ctx: unknown, sandboxId: string): Promise<AdapterResult> =>
      real.destroySandbox(ctx, sandboxId),
    execSandbox: (ctx: unknown, sandboxId: string, spec: ExecCommandSpec): Promise<ExecResult> =>
      real.execSandbox(ctx, sandboxId, spec),
    startSandbox: async (ctx: unknown, sandboxId: string): Promise<AdapterResult> => {
      const started = await real.startSandbox(ctx, sandboxId);
      if (started.status !== "ok") return started;
      const deadline = Date.now() + readyDeadlineMs;
      for (;;) {
        const verdict = await adapter.awaitReady(ctx, sandboxId, { deadlineMs: 3_000 });
        if (verdict.status === "ok") return started;
        if (Date.now() >= deadline) {
          return {
            status: "denied",
            reason: "sandbox did not reach READY (fail-closed)",
            event: started.event,
          };
        }
        await new Promise((r) => setTimeout(r, 2_000));
      }
    },
  };
}

/**
 * The REAL production governance for the GOVERNED MCP SERVER deps (the path a Hermes tools/call enters):
 *   • screen   = makeArgsCredentialScreen() — deny a secret-shaped arg before anything;
 *   • authorize = authorizeToolInvoke over a ToolRegistry holding ONLY exec.echo/exec.ls + an allow rule
 *                 (deny-by-default for any other tool name Hermes might call);
 *   • cost     = a real in-memory budget hard-cap;
 *   • appender = a real in-memory WORM appender (records every governed event before its effect).
 * The substrate + sandboxId are wired by the caller (the loopback server's pre-provisioned sandbox).
 */
function governanceForCtx(
  ctx: Record<string, string>,
  substrate: ExecCapableSandboxAdapter,
  sandboxId: string,
): { deps: ExecMcpServerDeps; appendCalls: unknown[] } {
  const registry = seedRegistry();
  const allowRules = [
    { id: "allow-exec", action: "tool:invoke", resource: "exec.**", tenantId: ctx.tenantId },
  ];
  const appendCalls: unknown[] = [];
  let receiptId = 0;
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appendCalls.push(event);
      return Promise.resolve({ id: ++receiptId });
    },
  };
  const deps: ExecMcpServerDeps = {
    substrate,
    sandboxId,
    bindings: seedBindings(),
    registry,
    screen: makeArgsCredentialScreen(),
    authorize: (tc) => {
      const c = tc.context as Record<string, string>;
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
    appender,
    context: ctx,
  };
  return { deps, appendCalls };
}

/** The closed-loop baseDeps governing any session/update tool_calls Hermes surfaces (deny-by-default). */
function loopBaseDeps(
  ctx: Record<string, string>,
): Omit<GovernedToolCallDeps<GovernedCall, { id: number }>, "effect"> {
  const registry = seedRegistry();
  const allowRules = [
    { id: "allow-exec", action: "tool:invoke", resource: "exec.**", tenantId: ctx.tenantId },
  ];
  let receiptId = 0;
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  const appender: CommitAppender<unknown, { id: number }> = {
    append: () => Promise.resolve({ id: ++receiptId }),
  };
  return {
    screen: makeArgsCredentialScreen(),
    authorize: (tc) => {
      const c = tc.context as Record<string, string>;
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
    appender,
  };
}

/** Real-LLM latency budget for a live Hermes turn (handshake + a model turn + frames + a tools/call). */
const DRIVE_TIMEOUT_MS = 180_000;
/** A freshly-created OpenShell sandbox readiness budget (boot to READY). */
const READY_DEADLINE_MS = 120_000;

const CTX = {
  actorId: "agent:exec4b-autonomous",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live-exec4b",
  requestId: "req-exec4b-1",
};

/**
 * The nudge intent: a benign instruction that should make a tool-using Hermes AUTONOMOUSLY discover the
 * advertised `exec.echo` (via tools/list) and call it (via tools/call). We name the tool + the desired
 * output so a tool-capable model reaches for it; the governance net holds regardless of what it actually
 * does (deny-by-default for anything else).
 */
const NUDGE_INTENT =
  "You have an MCP tool named exec.echo that echoes a line of text. Use the exec.echo tool to print the word hello. Use only that tool.";

dAutonomous(
  "EXEC4b — a REAL hermes acp brain autonomously discovers + calls our governed exec.echo over the in-process MCP loopback -> REAL OpenShell exec",
  () => {
    let adapter: OpenShellSandboxAdapter;

    beforeAll(() => {
      adapter = realOpenShellAdapter();
    });

    it(
      ">=1 autonomous EXECUTED real tool (exit=0) over the loopback; deny-by-default for Hermes's other tools; ephemeral sandboxes create+destroy",
      async () => {
        const substrate = readinessGatedExecCapable(adapter, READY_DEADLINE_MS);

        // ── Provision the loopback server's OWN ephemeral sandbox (the surface a Hermes tools/call hits). ──
        // We OWN this sandbox lifecycle in the test (the single-call MCP server does not own a loop's
        // sandbox); we destroy it in finally. An OBSERVING substrate records what executed over the loopback.
        let loopbackSandboxId: string | undefined;
        let loopbackDestroyed = false;
        const toolsCallExecArgv: string[][] = [];
        const observingLoopbackSubstrate: ExecCapableSandboxAdapter = {
          createSandbox: (ctx, spec) => substrate.createSandbox(ctx, spec),
          startSandbox: (ctx, id) => substrate.startSandbox(ctx, id),
          stopSandbox: (ctx, id) => substrate.stopSandbox(ctx, id),
          destroySandbox: (ctx, id) => substrate.destroySandbox(ctx, id),
          execSandbox: async (ctx, id, spec) => {
            toolsCallExecArgv.push([...spec.argv]);
            return substrate.execSandbox(ctx, id, spec);
          },
        };

        const created = await observingLoopbackSubstrate.createSandbox(CTX, {
          image: SANDBOX_IMAGE,
        });
        if (created.status !== "ok") {
          throw new Error(`exec4b: loopback sandbox create denied — ${created.reason}`);
        }
        loopbackSandboxId = created.sandboxId;

        let loopbackServer: Awaited<ReturnType<typeof startExecMcpLoopbackServer>> | undefined;
        try {
          const started = await observingLoopbackSubstrate.startSandbox(CTX, loopbackSandboxId);
          if (started.status !== "ok") {
            throw new Error(`exec4b: loopback sandbox start denied — ${started.reason}`);
          }

          // ── Start the in-process governed MCP loopback server over the loopback sandbox. A Hermes
          // tools/call to this URL lands in OUR runGovernedToolCall -> the binding-wrapped REAL exec. ──
          const { deps, appendCalls } = governanceForCtx(
            CTX,
            observingLoopbackSubstrate,
            loopbackSandboxId,
          );
          loopbackServer = await startExecMcpLoopbackServer(deps);

          console.info(
            `[EXEC4b] advertising governed MCP loopback descriptor to the real Hermes: ${JSON.stringify(
              loopbackServer.descriptor,
            )} (tools advertised: exec.echo, exec.ls)`,
          );

          // ── Drive the REAL Hermes with the descriptor advertised in session/new.mcpServers. The closed
          // loop ALSO governs any session/update tool_calls Hermes surfaces (its own tools -> deny). ──
          const transport = new AcpStdioTransport({
            command: ["hermes", "acp"],
            mcpServers: [loopbackServer.descriptor],
            idleTimeoutMs: DRIVE_TIMEOUT_MS,
            startupTimeoutMs: 30_000,
          });

          // Track the closed loop's OWN ephemeral sandbox (for session/update proposals) — create+destroy.
          let loopCreated: string | undefined;
          let loopDestroyed: string | undefined;
          const observingLoopSubstrate: ExecCapableSandboxAdapter = {
            createSandbox: async (ctx, spec) => {
              const r = await substrate.createSandbox(ctx, spec);
              if (r.status === "ok") loopCreated = r.sandboxId;
              return r;
            },
            startSandbox: (ctx, id) => substrate.startSandbox(ctx, id),
            stopSandbox: (ctx, id) => substrate.stopSandbox(ctx, id),
            destroySandbox: async (ctx, id) => {
              const r = await substrate.destroySandbox(ctx, id);
              loopDestroyed = id;
              return r;
            },
            execSandbox: (ctx, id, spec) => substrate.execSandbox(ctx, id, spec),
          };

          const result = await runExecClosedLoop(
            transport,
            observingLoopSubstrate,
            loopBaseDeps(CTX),
            seedBindings(),
            CTX,
            NUDGE_INTENT,
            { maxTurns: 4, sandboxSpec: { image: SANDBOX_IMAGE } },
          );

          // ── OBSERVABILITY: what did the real Hermes discover + call? (Did the descriptor shape work?) ──
          console.info(
            `[EXEC4b] closed loop: stoppedBy=${result.stoppedBy}, turns=${result.turns}, ` +
              `session/update proposals governed=${result.outcomes.length}`,
          );
          console.info(
            `[EXEC4b] tools/call execs that landed in OUR governed pipeline over the loopback: ${
              toolsCallExecArgv.length
            }; argv=${JSON.stringify(toolsCallExecArgv)}`,
          );
          console.info(
            `[EXEC4b] WORM receipts appended for the loopback governed calls: ${appendCalls.length}`,
          );

          // ── ASSERTION 1 + 5 (autonomous success / fail-closed-with-diagnostic): the real Hermes must have
          // AUTONOMOUSLY discovered (tools/list) + called (tools/call) a registered+bound tool that reached
          // OUR governed pipeline + the REAL OpenShell exec. If it did not, this fails with a CLEAR message
          // (the descriptor shape / discovery is exactly what this live run pins) — never a false pass.
          expect(
            toolsCallExecArgv.length,
            "the REAL Hermes must AUTONOMOUSLY discover (tools/list) + call (tools/call) our advertised " +
              "exec.echo/exec.ls so it lands in OUR in-process governed pipeline -> REAL OpenShell exec. " +
              "ZERO tools/call execs means the real Hermes did NOT accept the session/new.mcpServers " +
              "descriptor shape / did NOT discover our tools — the exact thing this live run pins. See the " +
              "[EXEC4b] logs above for the advertised descriptor + what the loop observed.",
          ).toBeGreaterThanOrEqual(1);
          // The argv that executed was built by OUR binding (a pure vector — echo/ls), never a shell string.
          for (const argv of toolsCallExecArgv) {
            expect(["echo", "ls"]).toContain(argv[0]);
          }
          // The WORM recorded each governed loopback call BEFORE its effect (commit-before-effect held).
          expect(appendCalls.length).toBeGreaterThanOrEqual(toolsCallExecArgv.length);

          // ── ASSERTION 2 (deny-by-default / propose-only): any session/update tool_call Hermes surfaced is
          // NOT our registered exec.echo/exec.ls (those go via tools/call, not session/update proposals), so
          // the closed loop denies them @policy. So NO closed-loop outcome should be "executed".
          const loopExecuted = result.outcomes.filter(
            (o): o is Extract<GovernedOutcome<{ id: number }>, { status: "executed" }> =>
              o.status === "executed",
          );
          expect(
            loopExecuted.length,
            "Hermes's own (non-advertised) tools surfaced as session/update proposals must be DENIED by the " +
              "closed-loop governance (deny-by-default) — they never execute. A tools/call to OUR advertised " +
              "tools goes via the loopback server, not these proposals.",
          ).toBe(0);

          // ── ASSERTION 3 (bounded): the loop terminated with a known reason — never hung.
          expect(
            ["terminal", "session-end", "no-proposal", "maxTurns"],
            "the closed loop must terminate with a known terminal reason — never hang",
          ).toContain(result.stoppedBy);

          // ── ASSERTION 3 (ephemeral sandbox — closed loop): the loop created + destroyed its own sandbox.
          expect(loopCreated, "the closed loop created its own ephemeral sandbox").toBeDefined();
          expect(loopDestroyed, "the closed loop destroyed its ephemeral sandbox in finally").toBe(
            loopCreated,
          );
        } finally {
          // Tear down the in-process loopback server FIRST (stop accepting connections), then the sandbox.
          if (loopbackServer !== undefined) await loopbackServer.close();
          if (loopbackSandboxId !== undefined && !loopbackDestroyed) {
            try {
              await substrate.destroySandbox(CTX, loopbackSandboxId);
              loopbackDestroyed = true;
            } catch {
              // best-effort teardown; never mask the test's own outcome
            }
          }
        }

        // ── ASSERTION 3 (ephemeral sandbox — loopback server): the loopback sandbox was destroyed.
        expect(
          loopbackDestroyed,
          "the loopback server's ephemeral sandbox was destroyed in the finally",
        ).toBe(true);
      },
      DRIVE_TIMEOUT_MS + READY_DEADLINE_MS * 2 + 120_000,
    );
  },
);
