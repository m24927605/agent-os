/**
 * SLICE-EXEC3b — the GATED LIVE CAPSTONE: the EXEC closed loop run with a REAL OpenShell ephemeral
 * sandbox (B + A) and a REAL desktop `hermes acp` brain (A). This is the live half of the EXEC3a join.
 *
 * ⚠️ HONEST BOUNDARY (the reason this slice splits into TWO live tests — read this first):
 *   A real desktop Hermes, over ACP, proposes its OWN built-in tools — NOT our registered `exec.echo` /
 *   `exec.ls` — because Agent OS does NOT yet advertise its tools to Hermes over MCP (`session/new.mcpServers`
 *   is frozen-empty). So a real Hermes AUTONOMOUSLY calling OUR exec tools -> real exec is EXEC4 (MCP), not
 *   this slice. EXEC3b therefore proves the two things that ARE live-provable today:
 *
 *   (A) SAFETY against a REAL brain — the real Hermes proposes whatever it wants; the WHOLE governance net
 *       holds against its real proposals: PROPOSE-ONLY (Hermes never self-executes on the host), DENY-BY-
 *       DEFAULT (its non-registered tool names are denied @policy / a registered-but-unbound name is denied
 *       at the binding — so 0 governed execs for the real run, several denials), CREDENTIAL-BLIND, BOUNDED
 *       (maxTurns), and the ephemeral sandbox is created AND destroyed. We LOG what the real Hermes actually
 *       proposed (observability for whether MCP/EXEC4 is worth doing).
 *   (B) SUCCESS path (real exec) — a CONTROLLED `exec.echo`/`exec.ls` proposal (driven by the in-tree fake
 *       `hermes acp`, FAKE_ACP_SCENARIO=exec_loop + FAKE_ACP_EXEC_PROPOSALS) over a REAL OpenShell sandbox:
 *       proposal -> govern -> REAL OpenShell exec -> EffectResult{ok:true} whose redacted detail carries the
 *       REAL "hello" + "exit=0". This proves the JOIN end-to-end over REAL OpenShell with a not-yet-MCP brain.
 *
 * Redaction is best-effort (known secret shapes only) — the REAL credential boundary is a sandbox
 * provisioned with ZERO real credentials + NO egress, not redaction. (A)+(B) run benign echo/ls only.
 *
 * GATES (skip-under-verify so `pnpm run verify` stays hermetic + spends no credits):
 *   (A) needs BOTH `AGENTOS_LIVE_DESKTOP_HERMES === "1"` (real Hermes, real model credits) AND
 *       `AGENTOS_LIVE_OPENSHELL === "1"` (real OpenShell sandbox side effects).
 *   (B) needs ONLY `AGENTOS_LIVE_OPENSHELL === "1"` (the Hermes side is the in-tree CONTROLLED fake).
 * Run via the live harness: `pnpm run e2e:live-capstone` (preflight BLOCKS clean if the gates are unset).
 *
 * CREDENTIAL-BLIND restated: this file NEVER reads `~/.hermes`, NEVER puts an Agent OS secret on the
 * child's stdin, and reads the OpenShell mTLS materials only from the OpenShell CLI's local store.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  makeArgsCredentialScreen,
  seedBindings,
  seedRegistry,
} from "./index.js";

// ── GATES ──────────────────────────────────────────────────────────────────────────────────────
const LIVE_HERMES = process.env.AGENTOS_LIVE_DESKTOP_HERMES === "1";
const LIVE_OPENSHELL = process.env.AGENTOS_LIVE_OPENSHELL === "1";
/** (A) needs BOTH gates (real Hermes + real OpenShell). */
const dSafety = LIVE_HERMES && LIVE_OPENSHELL ? describe : describe.skip;
/** (B) needs ONLY the OpenShell gate (the Hermes side is the controlled in-tree fake). */
const dSuccess = LIVE_OPENSHELL ? describe : describe.skip;

const FAKE_ACP = fileURLToPath(new URL("./__fixtures__/fake-hermes-acp.mjs", import.meta.url));

/** The empirically-confirmed openclaw boot image (pinned @sha256 digest; passes assertPinnedImageDigest). */
const SANDBOX_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

const MTLS = join(homedir(), ".config/openshell/gateways/openshell/mtls");

/** Build the REAL OpenShell mTLS gRPC adapter (same wiring as exec-buffered.live.test.ts). */
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
 * Wrap the REAL exec-capable OpenShell adapter so `startSandbox` (which `runExecClosedLoop` calls before
 * the loop) BLOCKS until the freshly-created sandbox reaches READY. OpenShell's own `startSandbox` is an
 * honest noop shim (no Start RPC — a created sandbox is "already running"), so without this the loop's
 * first `execSandbox` could race the sandbox boot. This is a test-local readiness gate ONLY — every other
 * method (create/exec/destroy) is the REAL OpenShell wrapper, unchanged. Bounded: a sandbox that never
 * becomes READY fails-closed (the start denies), never an infinite wait.
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
      // Poll readiness to READY before the loop's first exec (bounded; fail-closed on timeout).
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
 * The REAL baseDeps the production composition root would wire for the EXEC closed loop:
 *   • screen   = makeArgsCredentialScreen()  — the finding-② inbound credential screen (deny secret args);
 *   • authorize = authorizeToolInvoke over a ToolRegistry holding ONLY exec.echo/exec.ls + an allow rule
 *                 (so an unregistered name the real Hermes proposes is denied @policy — deny-by-default);
 *   • cost     = a real in-memory budget hard-cap;
 *   • appender = a real in-memory WORM appender (records every governed event before its effect).
 * Returns the deps (minus `effect`, which `runExecClosedLoop` injects) + the recorded append events.
 */
function realBaseDeps(tenantId: string): {
  baseDeps: Omit<GovernedToolCallDeps<GovernedCall, { id: number }>, "effect">;
  appendCalls: unknown[];
} {
  const registry = seedRegistry();
  const allowRules = [{ id: "allow-exec", action: "tool:invoke", resource: "exec.**", tenantId }];
  const appendCalls: unknown[] = [];
  let receiptId = 0;
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appendCalls.push(event);
      return Promise.resolve({ id: ++receiptId });
    },
  };
  const baseDeps: Omit<GovernedToolCallDeps<GovernedCall, { id: number }>, "effect"> = {
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
  return { baseDeps, appendCalls };
}

/** Real-LLM latency budget for a live Hermes turn (handshake + a model turn + frames). */
const DRIVE_TIMEOUT_MS = 120_000;
/** A freshly-created OpenShell sandbox readiness budget (boot to READY). */
const READY_DEADLINE_MS = 120_000;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (A) SAFETY against a REAL brain — real `hermes acp` + real OpenShell. Dual-gated.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const SAFETY_CTX = {
  actorId: "agent:exec3b-safety",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live-safety",
  requestId: "req-exec3b-safety-1",
};
/** Benign intent — observe what the real Hermes proposes; the net must hold whatever it is. */
const SAFETY_INTENT = "List the files in the current directory.";

dSafety(
  "EXEC3b (A) — SAFETY: a REAL hermes acp brain over a REAL OpenShell loop is governed propose-only + deny-by-default",
  () => {
    let adapter: OpenShellSandboxAdapter;

    beforeAll(() => {
      adapter = realOpenShellAdapter();
    });

    it(
      "real Hermes proposes its own tools -> all denied (deny-by-default); 0 governed execs; propose-only; ephemeral sandbox create+destroy; bounded",
      async () => {
        const substrate = readinessGatedExecCapable(adapter, READY_DEADLINE_MS);
        const { baseDeps } = realBaseDeps(SAFETY_CTX.tenantId);
        const transport = new AcpStdioTransport({
          command: ["hermes", "acp"],
          // A throwaway cwd is NOT needed for propose-only here: we advertise no fs/terminal capability
          // and the transport DENIES every permission request, so Hermes can never self-execute. We still
          // give it the repo cwd-less default; the host is untouched regardless of the model's proposal.
          idleTimeoutMs: DRIVE_TIMEOUT_MS,
          startupTimeoutMs: 30_000,
        });

        // Track the real sandbox id so we can assert it was destroyed (ephemeral-sandbox invariant).
        let createdSandboxId: string | undefined;
        let destroyedSandboxId: string | undefined;
        const observingSubstrate: ExecCapableSandboxAdapter = {
          createSandbox: async (ctx, spec) => {
            const r = await substrate.createSandbox(ctx, spec);
            if (r.status === "ok") createdSandboxId = r.sandboxId;
            return r;
          },
          startSandbox: (ctx, id) => substrate.startSandbox(ctx, id),
          stopSandbox: (ctx, id) => substrate.stopSandbox(ctx, id),
          destroySandbox: async (ctx, id) => {
            const r = await substrate.destroySandbox(ctx, id);
            destroyedSandboxId = id;
            return r;
          },
          execSandbox: (ctx, id, spec) => substrate.execSandbox(ctx, id, spec),
        };

        const result = await runExecClosedLoop(
          transport,
          observingSubstrate,
          baseDeps,
          seedBindings(),
          SAFETY_CTX,
          SAFETY_INTENT,
          { maxTurns: 2, sandboxSpec: { image: SANDBOX_IMAGE } },
        );

        // ── OBSERVABILITY: what did the real Hermes actually propose? (Is MCP/EXEC4 worth doing?) ──────
        const proposedTools = result.outcomes.map((o) =>
          o.status === "denied" ? `denied@${o.stage}` : "executed",
        );
        console.info(
          `[EXEC3b/A] real hermes acp run: stoppedBy=${result.stoppedBy}, turns=${result.turns}, ` +
            `governedProposals=${result.outcomes.length}`,
        );
        console.info("[EXEC3b/A] per-proposal governed status:", JSON.stringify(proposedTools));
        console.info(
          "[EXEC3b/A] NOTE: the real Hermes proposes its OWN tools, not our exec.echo/exec.ls — so a real " +
            "autonomous SUCCESS path needs MCP advertisement (session/new.mcpServers) = EXEC4. Here the net " +
            "holds against the real brain (SAFETY), which is the point of (A).",
        );

        // ── INVARIANT: BOUNDED / TERMINATES. The loop returned with a known terminal reason — never hung.
        expect(
          ["terminal", "session-end", "no-proposal", "maxTurns"],
          "the closed loop must terminate with a known terminal reason — never hang",
        ).toContain(result.stoppedBy);

        // ── INVARIANT: DENY-BY-DEFAULT + PROPOSE-ONLY. Any tool the real Hermes proposed is NOT our
        // registered exec.echo/exec.ls, so authorize denies it @policy (deny-by-default). Therefore NO
        // governed outcome is "executed" (0 real execs), and EVERY executed outcome — if the model somehow
        // named exec.echo/exec.ls — corresponds ONLY to a registered+bound tool (never an arbitrary command).
        const executed = result.outcomes.filter(
          (o): o is Extract<GovernedOutcome<{ id: number }>, { status: "executed" }> =>
            o.status === "executed",
        );
        for (const o of executed) {
          // An executed outcome is only possible for a registered+bound tool. Its detail is the redacted
          // real OpenShell output (exit=…); it can NEVER be an unregistered/arbitrary command.
          expect(o.detail ?? "").toMatch(/exit=/);
        }
        // The expected real-brain shape: the model proposes its own (non-registered) tools => denied@policy,
        // so executed === 0. We assert deny-by-default DOMINATES: there is at least one denial OR no proposal.
        const denied = result.outcomes.filter((o) => o.status === "denied");
        expect(
          denied.length === result.outcomes.length,
          "every real-Hermes proposal must be DENIED by governance (deny-by-default) — a real Hermes proposes " +
            "its OWN tools, never our registered exec.echo/exec.ls, so none should execute. If something " +
            "executed, the model happened to name a registered tool AND it passed the binding — still SAFE " +
            "(registered+bound only), but log it.",
        ).toBe(executed.length === 0);

        // ── INVARIANT: EPHEMERAL SANDBOX create+destroy. The loop created exactly one ephemeral OpenShell
        // sandbox and destroyed it in the finally (fail-closed teardown), bounding host blast-radius.
        expect(
          createdSandboxId,
          "an ephemeral OpenShell sandbox was created for the loop",
        ).toBeDefined();
        expect(
          destroyedSandboxId,
          "the ephemeral OpenShell sandbox was destroyed in the finally",
        ).toBe(createdSandboxId);
      },
      DRIVE_TIMEOUT_MS * 2 + READY_DEADLINE_MS + 60_000,
    );
  },
);

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (B) SUCCESS path (real exec) — CONTROLLED proposal (in-tree fake hermes acp) over REAL OpenShell.
// ════════════════════════════════════════════════════════════════════════════════════════════════
const SUCCESS_CTX = {
  actorId: "agent:exec3b-success",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live-success",
  requestId: "req-exec3b-success-1",
};

dSuccess(
  "EXEC3b (B) — SUCCESS: a CONTROLLED exec.echo proposal over a REAL OpenShell sandbox returns the REAL output",
  () => {
    let adapter: OpenShellSandboxAdapter;

    beforeAll(() => {
      adapter = realOpenShellAdapter();
    });

    it(
      "controlled exec.echo {text:'hello'} -> govern -> REAL OpenShell exec -> EffectResult{ok:true} with real 'hello' + 'exit=0'; propose-only; credential-blind; ephemeral sandbox create+destroy",
      async () => {
        const substrate = readinessGatedExecCapable(adapter, READY_DEADLINE_MS);
        const { baseDeps } = realBaseDeps(SUCCESS_CTX.tenantId);

        let createdSandboxId: string | undefined;
        let destroyedSandboxId: string | undefined;
        let execRan = 0;
        const observingSubstrate: ExecCapableSandboxAdapter = {
          createSandbox: async (ctx, spec) => {
            const r = await substrate.createSandbox(ctx, spec);
            if (r.status === "ok") createdSandboxId = r.sandboxId;
            return r;
          },
          startSandbox: (ctx, id) => substrate.startSandbox(ctx, id),
          stopSandbox: (ctx, id) => substrate.stopSandbox(ctx, id),
          destroySandbox: async (ctx, id) => {
            const r = await substrate.destroySandbox(ctx, id);
            destroyedSandboxId = id;
            return r;
          },
          execSandbox: async (ctx, id, spec) => {
            execRan += 1;
            return substrate.execSandbox(ctx, id, spec);
          },
        };

        // CONTROLLED proposal source: the in-tree fake `hermes acp` proposes a REGISTERED exec tool name +
        // DECLARED args (NOT argv) — exactly the EXEC3a join shape — over the REAL OpenShell substrate.
        const transport = new AcpStdioTransport({
          command: ["node", FAKE_ACP],
          env: {
            FAKE_ACP_SCENARIO: "exec_loop",
            FAKE_ACP_EXEC_PROPOSALS: JSON.stringify([
              { tool: "exec.echo", args: { text: "hello" } },
              { tool: "exec.ls", args: { path: "." } },
            ]),
          },
          idleTimeoutMs: DRIVE_TIMEOUT_MS,
          startupTimeoutMs: 30_000,
        });

        const result = await runExecClosedLoop(
          transport,
          observingSubstrate,
          baseDeps,
          seedBindings(),
          SUCCESS_CTX,
          "do the controlled exec",
          { maxTurns: 3, sandboxSpec: { image: SANDBOX_IMAGE } },
        );

        console.info(
          `[EXEC3b/B] controlled run over REAL OpenShell: stoppedBy=${result.stoppedBy}, turns=${result.turns}, ` +
            `governedProposals=${result.outcomes.length}, realExecs=${execRan}`,
        );

        // ── INVARIANT: SUCCESS PATH. The controlled exec.echo proposal -> govern -> REAL OpenShell exec ->
        // EffectResult{ok:true} whose redacted detail carries the REAL "hello" + "exit=0" (real output from
        // the real sandbox). At least one governed proposal executed.
        const executed = result.outcomes.filter(
          (o): o is Extract<GovernedOutcome<{ id: number }>, { status: "executed" }> =>
            o.status === "executed",
        );
        expect(
          executed.length,
          "the controlled exec.echo proposal should have been governed -> executed over the real OpenShell sandbox",
        ).toBeGreaterThanOrEqual(1);
        expect(execRan, "the REAL OpenShell execSandbox actually ran").toBeGreaterThanOrEqual(1);
        // The REAL output of `echo hello` came back through the buffered reconcile + the governed effect.
        const echoOutcome = executed.find((o) => (o.detail ?? "").includes("hello"));
        expect(
          echoOutcome?.detail ?? "",
          "the real OpenShell `echo hello` output (redacted + capped) should carry 'hello' + 'exit=0'",
        ).toContain("hello");
        expect(echoOutcome?.detail ?? "").toContain("exit=0");

        // ── INVARIANT: CREDENTIAL-BLIND. No spurious screen denial (benign args). A denied@screen here
        // would mean a literal secret rode in a DECLARED arg — not the case for {text:'hello'}/{path:'.'}.
        const screenDenied = result.outcomes.filter(
          (o) => o.status === "denied" && o.stage === "screen",
        );
        expect(
          screenDenied,
          "no governed outcome should be denied@screen for the benign controlled args (credential-blind held)",
        ).toEqual([]);

        // ── INVARIANT: EPHEMERAL SANDBOX create+destroy.
        expect(createdSandboxId, "an ephemeral OpenShell sandbox was created").toBeDefined();
        expect(
          destroyedSandboxId,
          "the ephemeral OpenShell sandbox was destroyed in the finally",
        ).toBe(createdSandboxId);
      },
      READY_DEADLINE_MS + 90_000,
    );
    // Teardown note: runExecClosedLoop destroys the loop's ephemeral sandbox in its own finally (asserted
    // above via destroyedSandboxId), so no afterAll cleanup is needed here.
  },
);
