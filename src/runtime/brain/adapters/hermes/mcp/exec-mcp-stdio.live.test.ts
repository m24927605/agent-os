/**
 * SLICE-EXEC4c-b — the GATED LIVE AUTONOMOUS-CAPSTONE HARNESS (the STDIO analog of `exec-mcp.live.test.ts`):
 * a REAL desktop `hermes acp` brain is handed our STDIO MCP descriptor in `session/new.mcpServers`, SPAWNS
 * our compiled governed exec MCP bin (`node dist/.../exec-mcp-server-bin.js`), AUTONOMOUSLY discovers our
 * bounded exec tools via `tools/list`, calls one via `tools/call` -> the SPAWNED bin's governed pipeline
 * (`runGovernedToolCall`) -> REAL OpenShell exec -> real result -> Hermes continues. The bin's WORM ships
 * every receipt to the SHARED kernel chain (unified evidence). This is the (A)+(B)+(EXEC4b http) ALL-cannot-
 * show thing: a REAL Hermes AUTONOMOUSLY spawning + calling OUR governed tools over stdio (the live-pinned
 * constraint: `hermes acp` only supports STDIO mcpServers).
 *
 * WHO EXECUTES (the EXEC4 thesis, live, under Hermes-spawn): the bin is Agent OS COMPILED code; even though
 * Hermes spawns it + controls its stdin/stdout/lifecycle, EVERY tools/call still routes through the single
 * governed edge in the bin (WE-stay-executor under Hermes-spawn). Hermes NEVER self-executes; an adversarial
 * JSON-RPC line is still governed; killing the bin just stops it (fail-closed).
 *
 * ⚠️ DO NOT RUN UNDER `pnpm run verify`. Dual-gated (both must be "1"):
 *   AGENTOS_LIVE_DESKTOP_HERMES (real Hermes, real model credits) AND AGENTOS_LIVE_OPENSHELL (real sandbox
 *   side effects). Unset -> `describe.skip` (NO-OP, hermetic, zero credits). An OPTIONAL kernel gate
 *   (AGENTOS_LIVE_KERNEL_ENDPOINT) turns on the SHARED-WORM assertion (the bin's receipt appears in the real
 *   kernel chain). Run via `pnpm run e2e:live-exec-mcp-stdio` (preflight BLOCKS clean if the gates are unset).
 *
 * ASSERTIONS (the things ONLY the live run can pin — the real STDIO descriptor shape + autonomous spawn):
 *   1. >=1 AUTONOMOUS EXECUTED for a registered+bound tool (exec.echo/exec.ls): the real Hermes SPAWNED our
 *      bin, discovered (tools/list) + called (tools/call) it, the bin's governed pipeline ran a REAL
 *      OpenShell exec (exit=0), and the result surfaced back. Observed from the session/update frames Hermes
 *      streamed (the bin runs in Hermes's process tree, so our process sees the tool result via the frames)
 *      and — when the kernel gate is on — corroborated by the bin's receipt in the SHARED kernel chain.
 *   2. DENY-BY-DEFAULT / PROPOSE-ONLY for Hermes's OTHER tools: any session/update tool_call Hermes surfaces
 *      (its own/built-in tools, NOT via the spawned bin's tools/call) re-enters the closed-loop governance
 *      and is DENIED (deny-by-default) / never self-executed.
 *   3. BOUNDED (low maxTurns): the loop terminates with a known reason — never hangs.
 *   4. SHARED-WORM (optional, kernel gate): the bin's receipts appear in the SHARED kernel partition chain
 *      (unified, independently-verifiable evidence — not a split in-memory log).
 *   5. OBSERVABILITY (console.info): the advertised STDIO descriptor + what Hermes discovered + which tool
 *      ran.
 *   6. FAIL-CLOSED-WITH-DIAGNOSTIC: if the real Hermes does NOT spawn/accept our bin / never discovers, the
 *      test FAILS with a CLEAR message (the real spawn + descriptor shape is what this run pins) — never a
 *      hang (the transport startup/idle guards + the per-test timeout bound it), never a false pass.
 *
 * TEARDOWN: the closed loop destroys its OWN ephemeral sandbox in its finally (asserted). The bin is
 * Hermes-spawned, so HERMES reaps it when the ACP child exits; our transport SIGKILLs the `hermes acp` child
 * on close (so no leak from our side). The bin also destroys its own ephemeral sandbox on SIGTERM/EOF.
 *
 * CREDENTIAL-BLIND: this file NEVER reads `~/.hermes`, NEVER puts an Agent OS secret on the child's stdin,
 * and advertises ONLY NON-secret endpoints (OpenShell + kernel ingest host:port) in the descriptor's env.
 * Redaction is best-effort — the REAL credential boundary is a sandbox provisioned with ZERO credentials +
 * NO egress, not redaction. The nudge intents run benign echo/ls only.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { CommitAppender } from "../../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../../cost/index.js";
import type {
  GovernedCall,
  GovernedOutcome,
  GovernedToolCallDeps,
} from "../../../../../orchestration/index.js";
import { authorizeToolInvoke } from "../../../../../tools/index.js";
import { createSignedChainReader } from "../../../../ingest/index.js";
import {
  OpenShellSandboxAdapter,
  createOpenShellGrpcTransport,
  makeOpenShellExecCapable,
} from "../../../../openshell/index.js";
import type {
  AdapterResult,
  ExecCapableSandboxAdapter,
  ExecCommandSpec,
  ExecResult,
  SandboxSpec,
} from "../../../../substrate/index.js";
import type {
  AcpUpdateFrame,
  DuplexDesktopHermesTransport,
  HermesLoopSession,
  HermesLoopTurn,
} from "../desktop.js";
import { runExecClosedLoop } from "../exec-closed-loop.js";
import {
  AcpStdioTransport,
  execMcpStdioDescriptor,
  makeArgsCredentialScreen,
  seedBindings,
  seedRegistry,
} from "../index.js";

// ── GATES ──────────────────────────────────────────────────────────────────────────────────────
const LIVE_HERMES = process.env.AGENTOS_LIVE_DESKTOP_HERMES === "1";
const LIVE_OPENSHELL = process.env.AGENTOS_LIVE_OPENSHELL === "1";
/** EXEC4c-b needs BOTH gates (a REAL Hermes that SPAWNS our bin + a REAL OpenShell sandbox). */
const dAutonomous = LIVE_HERMES && LIVE_OPENSHELL ? describe : describe.skip;
/** OPTIONAL kernel gate: turns on the SHARED-WORM assertion (the bin's receipt in the real kernel chain). */
const KERNEL_ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;
/** The bin's tenant partition (must match BIN_TENANT_BINDING.partitionId in exec-mcp-server-bin.ts). */
const BIN_PARTITION = "tenant-bin";

/** The empirically-confirmed openclaw boot image (pinned @sha256 digest; passes assertPinnedImageDigest). */
const SANDBOX_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";

const OPENSHELL_ENDPOINT = "127.0.0.1:17670";
const MTLS = join(homedir(), ".config/openshell/gateways/openshell/mtls");

// The compiled bin a real Hermes SPAWNS. src/.../mcp -> repo root is 6 levels up; the bin mirrors it in dist/.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..", "..");
const BUILT_BIN = join(
  REPO_ROOT,
  "dist",
  "runtime",
  "brain",
  "adapters",
  "hermes",
  "mcp",
  "exec-mcp-server-bin.js",
);

/** Build the REAL OpenShell mTLS gRPC adapter (same wiring as the EXEC4b live test) — for the CLOSED LOOP's
 * own ephemeral sandbox (the bin builds its OWN real OpenShell adapter inside its REAL mode). */
function realOpenShellAdapter(): OpenShellSandboxAdapter {
  const transport = createOpenShellGrpcTransport({
    endpoint: OPENSHELL_ENDPOINT,
    caCertPath: join(MTLS, "ca.crt"),
    clientCertPath: join(MTLS, "tls.crt"),
    clientKeyPath: join(MTLS, "tls.key"),
    deadlineMs: 30_000,
  });
  return new OpenShellSandboxAdapter(transport);
}

/** Readiness-gate a freshly-created sandbox to READY before the loop's first exec (bounded, fail-closed). */
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

/**
 * Wrap a duplex transport so we RECORD every session/update frame across all turns. The autonomous tools/call
 * to the SPAWNED bin happens inside Hermes's process tree, so we cannot intercept the bin's substrate
 * directly — but Hermes streams the MCP tool result back as session/update frames, so the recorded frames
 * are our window into "did the spawned bin's exec.echo/exec.ls actually run + return its output?".
 */
function recordingTransport(
  inner: DuplexDesktopHermesTransport,
  recordedFrames: AcpUpdateFrame[],
): DuplexDesktopHermesTransport {
  return {
    submit: (intent: string) => inner.submit(intent),
    openSession: async (intent: string): Promise<HermesLoopSession> => {
      const session = await inner.openSession(intent);
      return {
        nextTurn: async (): Promise<HermesLoopTurn | null> => {
          const turn = await session.nextTurn();
          if (turn !== null) for (const f of turn.frames) recordedFrames.push(f);
          return turn;
        },
        feed: (text: string) => session.feed(text),
        close: () => session.close(),
      };
    },
  };
}

/** Real-LLM latency budget for a live Hermes turn (handshake + a model turn + a spawned-bin tools/call). */
const DRIVE_TIMEOUT_MS = 180_000;
/** A freshly-created OpenShell sandbox readiness budget (boot to READY). */
const READY_DEADLINE_MS = 120_000;

const CTX = {
  actorId: "agent:exec4c-autonomous",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live-exec4c",
  requestId: "req-exec4c-1",
};

/**
 * The nudge intent: a benign instruction that should make a tool-using Hermes AUTONOMOUSLY discover the
 * SPAWNED bin's advertised `exec.echo` (via tools/list) and call it (via tools/call). We name the tool + the
 * desired output so a tool-capable model reaches for it; the governance net (in the bin + the closed loop)
 * holds regardless of what it actually does (deny-by-default for anything else).
 */
// Overridable via AGENTOS_LIVE_NUDGE so a live run can target a SPECIFIC advertised tool (e.g. exec.run) to
// verify the NEW HDI2a/HDI2b tools autonomously; defaults to the exec.echo nudge.
const NUDGE_INTENT =
  process.env.AGENTOS_LIVE_NUDGE ??
  "You have an MCP tool named exec.echo that echoes a line of text. Use the exec.echo tool to print the word hello. Use only that tool.";

/** Scan the recorded frames' JSON for evidence the SPAWNED bin's exec tool ran + returned its output. */
function autonomousExecEvidence(frames: readonly AcpUpdateFrame[]): {
  sawExecTool: boolean;
  sawEchoedOutput: boolean;
  toolsSeen: readonly string[];
} {
  const blob = JSON.stringify(frames);
  // Any of the 8 governed seed tools (HDI2a read-only + HDI2b exec.run) or the server name.
  const sawExecTool = /exec\.(echo|ls|cat|head|pwd|wc|grep|run)|agentos-exec/.test(blob);
  // The bin's redacted exec detail carries the real output ("hello") + "exit=0".
  const sawEchoedOutput = /exit=0/.test(blob) && /hello/.test(blob);
  // Which specific tool name(s) the frames mention — lets a live run confirm WHICH tool the brain called.
  const toolsSeen = [...new Set(blob.match(/exec\.[a-z]+/g) ?? [])];
  return { sawExecTool, sawEchoedOutput, toolsSeen };
}

dAutonomous(
  "EXEC4c-b — a REAL hermes acp brain SPAWNS our governed exec MCP bin over stdio, autonomously discovers + calls it -> REAL OpenShell exec -> shared-kernel WORM",
  () => {
    let adapter: OpenShellSandboxAdapter;

    beforeAll(() => {
      // Fail-closed-with-diagnostic: the bin a real Hermes SPAWNS must be BUILT (the harness runs `build`).
      if (!existsSync(BUILT_BIN)) {
        throw new Error(
          `EXEC4c-b: the compiled bin is missing at ${BUILT_BIN} — a real Hermes cannot SPAWN it. Run \`pnpm run build\` (the e2e:live-exec-mcp-stdio harness does this) before the live drive.`,
        );
      }
      adapter = realOpenShellAdapter();
    });

    it(
      ">=1 autonomous EXECUTED over the SPAWNED bin (exit=0); deny-by-default for Hermes's other tools; bounded; shared-WORM if the kernel gate is on",
      async () => {
        const substrate = readinessGatedExecCapable(adapter, READY_DEADLINE_MS);

        // ── Advertise the STDIO descriptor: a real Hermes reads this to SPAWN `node <bin>` + speak MCP to it.
        // The env carries ONLY NON-secret endpoints (OpenShell + kernel ingest host:port) — never a credential.
        const stdioDescriptor = execMcpStdioDescriptor(BUILT_BIN, {
          AGENTOS_OPENSHELL_ENDPOINT: OPENSHELL_ENDPOINT,
          AGENTOS_OPENSHELL_MTLS: MTLS,
          AGENTOS_OPENSHELL_IMAGE: SANDBOX_IMAGE,
          ...(KERNEL_ENDPOINT !== undefined
            ? { AGENTOS_KERNEL_INGEST_ENDPOINT: KERNEL_ENDPOINT }
            : {}),
        });
        console.info(
          `[EXEC4c-b] advertising STDIO MCP descriptor to the real Hermes (it SPAWNS our bin): ${JSON.stringify(
            stdioDescriptor,
          )} (tools the spawned bin advertises: exec.echo, exec.ls)`,
        );

        const baseTransport = new AcpStdioTransport({
          command: ["hermes", "acp"],
          mcpServers: [stdioDescriptor],
          idleTimeoutMs: DRIVE_TIMEOUT_MS,
          startupTimeoutMs: 30_000,
        });
        const recordedFrames: AcpUpdateFrame[] = [];
        const transport = recordingTransport(baseTransport, recordedFrames);

        // Track the CLOSED LOOP's OWN ephemeral sandbox (for any session/update proposals) — create+destroy.
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

        // ── OBSERVABILITY: what did the real Hermes discover + call over the SPAWNED bin? ─────────────────
        const evidence = autonomousExecEvidence(recordedFrames);
        console.info(
          `[EXEC4c-b] closed loop: stoppedBy=${result.stoppedBy}, turns=${result.turns}, ` +
            `session/update proposals governed=${result.outcomes.length}, frames=${recordedFrames.length}`,
        );
        console.info(
          `[EXEC4c-b] autonomous-exec evidence from the streamed frames: sawExecTool=${evidence.sawExecTool}, ` +
            `sawEchoedOutput(exit=0 + hello)=${evidence.sawEchoedOutput}, toolsSeen=[${evidence.toolsSeen.join(", ")}]`,
        );

        let sharedWormEntries = -1;
        if (KERNEL_ENDPOINT !== undefined) {
          // ── SHARED-WORM (kernel gate on): the bin shipped its receipt to the SHARED kernel partition chain.
          const readback = await createSignedChainReader({
            endpoint: KERNEL_ENDPOINT,
            partitionId: BIN_PARTITION,
          });
          sharedWormEntries = readback.chain.entries.length;
          console.info(
            `[EXEC4c-b] SHARED kernel chain for partition '${BIN_PARTITION}': entries=${sharedWormEntries} (the spawned bin's tools/call receipts — unified, independently-verifiable evidence). WHICH tool the brain autonomously called is surfaced by toolsSeen above (from the streamed frames).`,
          );
        }

        // ── ASSERTION 1 + 6 (autonomous success / fail-closed-with-diagnostic): the real Hermes must have
        // SPAWNED our bin, discovered (tools/list) + called (tools/call) a registered+bound tool that ran a
        // REAL OpenShell exec (exit=0). We confirm via the streamed frames; when the kernel gate is on the
        // bin's receipt in the SHARED chain corroborates. ZERO evidence => a CLEAR failure (the real spawn +
        // descriptor shape is exactly what this live run pins) — never a false pass.
        const autonomousConfirmed =
          evidence.sawEchoedOutput || (KERNEL_ENDPOINT !== undefined && sharedWormEntries >= 1);
        expect(
          autonomousConfirmed,
          "the REAL Hermes must SPAWN our advertised STDIO bin, AUTONOMOUSLY discover (tools/list) + call " +
            "(tools/call) exec.echo/exec.ls so the bin's governed pipeline runs a REAL OpenShell exec (exit=0). " +
            "NO autonomous-exec evidence (no 'exit=0'+'hello' in the streamed frames; and — if the kernel gate " +
            "is on — no receipt in the shared chain) means the real Hermes did NOT accept the session/new " +
            "STDIO descriptor / did NOT spawn+discover our bin — the exact thing this live run pins. See the " +
            "[EXEC4c-b] logs above for the advertised descriptor + what the loop observed.",
        ).toBe(true);

        // ── ASSERTION 2 (deny-by-default / propose-only): any session/update tool_call Hermes surfaced is its
        // OWN/built-in tool (the spawned bin's tools go via MCP tools/call, NOT session/update proposals), so
        // the closed loop denies them @policy. So NO closed-loop outcome should be "executed".
        const loopExecuted = result.outcomes.filter(
          (o): o is Extract<GovernedOutcome<{ id: number }>, { status: "executed" }> =>
            o.status === "executed",
        );
        expect(
          loopExecuted.length,
          "Hermes's own (non-advertised) tools surfaced as session/update proposals must be DENIED by the " +
            "closed-loop governance (deny-by-default) — they never execute. A tools/call to the SPAWNED bin's " +
            "advertised tools goes via the bin's stdio MCP wire, not these proposals.",
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

        // ── ASSERTION 4 (SHARED-WORM, only when the kernel gate is on): the bin's receipts are in the SHARED
        // kernel partition chain (unified evidence — not a split in-memory log).
        if (KERNEL_ENDPOINT !== undefined) {
          expect(
            sharedWormEntries,
            "the SPAWNED bin's tools/call receipts must appear in the SHARED kernel partition chain " +
              "(createPartitionedIngestSink over the real grpc-js transport) — unified, independently-" +
              "verifiable evidence, NOT a split in-memory log.",
          ).toBeGreaterThanOrEqual(1);
        }
      },
      DRIVE_TIMEOUT_MS + READY_DEADLINE_MS * 2 + 120_000,
    );
  },
);
