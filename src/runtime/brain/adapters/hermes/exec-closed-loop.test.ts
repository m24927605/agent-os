/**
 * SLICE-EXEC3a — wire the REAL exec effect into the DHB3 closed loop SAFELY (Design A). RED-first.
 *
 * DHB3a proved the closed loop with a CANNED Fake effect. EXEC1/EXEC2 proved a credential-blind,
 * fail-closed, capped `makeExecEffect` over a real/Fake substrate. EXEC3a JOINS them: the desktop
 * Hermes (here a FAKE `hermes acp` subprocess, FAKE_ACP_SCENARIO=exec_loop) proposes a REGISTERED exec
 * tool NAME + DECLARED args -> govern -> a COMPOSER-HELD binding builds `argv` as a PURE STRING VECTOR
 * -> the REAL `makeExecEffect` over a Fake substrate runs it -> the redacted real output is fed back ->
 * the loop continues. NO live: substrate = FakeSandboxAdapter (echoes argv), transport = the in-tree
 * fake acp subprocess. NO model call, NO credits, NO ~/.hermes, NO AGENTOS_LIVE_*.
 *
 * THE NEW TRUST SEAM (argv-binding): the brain NEVER supplies argv[0]/raw argv. It proposes only a
 * registered tool name + declared params; the composer fixes `argvPrefix` and a STRICT `argSchema`; the
 * wrapper (a) denies an absent binding, (b) denies unknown/extra arg keys, (c) builds argv as a pure
 * vector — never a shell string, never `sh -c`. The deny-by-default name check (authorize) + this
 * argv-binding are the two layers that keep an untrusted brain from executing arbitrary commands.
 *
 * INVARIANTS (each with a NON-VACUITY mutation noted in-line):
 *   1. deny-by-default — only registered tools (authorize) AND only bound argv (wrapper).
 *   2. commit-before-REAL-effect — a rejecting appender => makeExecEffect/execSandbox 0 calls.
 *   3. credential-blind — secret env => deny (execSandbox 0); secret stdout => redacted on feed-back.
 *   4. fail-closed — absent binding / invalid args / failed exec => EffectResult{ok:false}, no fabricated exit 0.
 *   5. blast-radius — maxTurns bounds the REAL effect count.
 *   6. ephemeral sandbox — create+start BEFORE the loop; destroy in the finally even on throw / maxTurns.
 *   7. argv-binding — pure vector, no shell string.
 *
 * HONEST BOUNDARY: EXEC3a proves the JOIN logic + all invariants against a FAKE substrate + a fake acp.
 * A real command in a real sandbox + real Hermes return-edge = EXEC3b (live, user-initiated). Redaction
 * is best-effort (known secret shapes only) — the REAL credential boundary is a sandbox provisioned with
 * ZERO real credentials + NO egress, not redaction.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { redactSecrets } from "../../../../audit/index.js";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import type { GovernedCall, GovernedToolCallDeps } from "../../../../orchestration/index.js";
import { ToolRegistry, authorizeToolInvoke } from "../../../../tools/index.js";
import type { SecretDetector } from "../../../brain/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../substrate/index.js";
import {
  type ExecToolBinding,
  bindingWrappedExecEffect,
  runExecClosedLoop,
} from "./exec-closed-loop.js";
import { AcpStdioTransport } from "./index.js";

const FAKE = fileURLToPath(new URL("./__fixtures__/fake-hermes-acp.mjs", import.meta.url));

const validCtx = {
  actorId: "agent:hermes",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

const tmpDirs: string[] = [];
function emptyCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), "exec-loop-test-"));
  tmpDirs.push(dir);
  return dir;
}
function logPath(): string {
  return join(emptyCwd(), "fake-acp-log.json");
}
type FakeLog = {
  scenario: string;
  stdinLines: string[];
  methodsReceived: string[];
  promptTexts?: string[];
};
function readLog(path: string): FakeLog {
  return JSON.parse(readFileSync(path, "utf8"));
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The repo's real detector (same construction as every bootstrap): secret-shaped iff redact changes it. */
const detectSecret: SecretDetector = (v) => JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

// --- the two seed exec tools + their composer-held bindings ---------------------------------------

/** A valid `exec.echo` ToolManifest (read-only, no host damage). */
const echoManifest = {
  name: "exec.echo",
  version: "1.0.0",
  description: "echo a line of text",
  action: "tool:invoke",
  resourcePattern: "exec/echo",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
};
/** A valid `exec.ls` ToolManifest. */
const lsManifest = {
  name: "exec.ls",
  version: "1.0.0",
  description: "list a path",
  action: "tool:invoke",
  resourcePattern: "exec/ls",
  sideEffect: "read" as const,
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
};

/** exec.echo binding: argvPrefix ["echo"], strict {text}, toArgv -> [text]. */
const echoBinding: ExecToolBinding = {
  argvPrefix: ["echo"],
  argSchema: z.object({ text: z.string() }).strict(),
  toArgv: (a) => [(a as { text: string }).text],
};
/** exec.ls binding: argvPrefix ["ls"], strict {path}, toArgv -> [path]. */
const lsBinding: ExecToolBinding = {
  argvPrefix: ["ls"],
  argSchema: z.object({ path: z.string() }).strict(),
  toArgv: (a) => [(a as { path: string }).path],
};

function seedRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(echoManifest);
  r.register(lsManifest);
  return r;
}
function seedBindings(): ReadonlyMap<string, ExecToolBinding> {
  return new Map<string, ExecToolBinding>([
    ["exec.echo", echoBinding],
    ["exec.ls", lsBinding],
  ]);
}

// --- base deps (everything EXCEPT effect — the composer injects the binding-wrapped effect) -------

interface BaseDepsKit {
  readonly baseDeps: Omit<GovernedToolCallDeps<GovernedCall, { id: number }>, "effect">;
  readonly appendCalls: unknown[];
}
function makeBaseDeps(
  registry: ToolRegistry,
  opts: { appenderRejects?: boolean; budget?: number } = {},
): BaseDepsKit {
  const appendCalls: unknown[] = [];
  let receiptId = 0;
  const cost: CostGate = new InMemoryCostGate(opts.budget ?? 1_000_000);
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appendCalls.push(event);
      if (opts.appenderRejects === true) {
        return Promise.reject(new Error("fake appender refused (WORM down)"));
      }
      return Promise.resolve({ id: ++receiptId });
    },
  };
  // Allow exec.* via the registry-backed PDP. authorizeToolInvoke denies an UNREGISTERED tool name
  // (deny-by-default) and delegates a registered tool to the PDP (allow rule below).
  const allowRules = [
    { id: "allow-exec", action: "tool:invoke", resource: "exec.**", tenantId: "tenant-a" },
  ];
  const baseDeps: Omit<GovernedToolCallDeps<GovernedCall, { id: number }>, "effect"> = {
    screen: () => ({ ok: true }),
    authorize: (tc) => {
      const c = tc.context as typeof validCtx;
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

// --- a spying Fake substrate: records lifecycle + exec calls + lets a script drive exec output ----

class SpyFakeSandboxAdapter extends FakeSandboxAdapter {
  readonly createCalls: unknown[] = [];
  readonly startCalls: string[] = [];
  readonly destroyCalls: string[] = [];
  readonly execCalls: ExecCommandSpec[] = [];

  override createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> {
    this.createCalls.push(spec);
    return super.createSandbox(ctx, spec);
  }
  override startSandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    this.startCalls.push(sandboxId);
    return super.startSandbox(ctx, sandboxId);
  }
  override destroySandbox(ctx: unknown, sandboxId: string): Promise<AdapterResult> {
    this.destroyCalls.push(sandboxId);
    return super.destroySandbox(ctx, sandboxId);
  }
  override execSandbox(
    ctx: unknown,
    sandboxId: string,
    spec: ExecCommandSpec,
  ): Promise<ExecResult> {
    this.execCalls.push(spec);
    return super.execSandbox(ctx, sandboxId, spec);
  }
}

function execProposalsEnv(proposals: { tool: string; args: Record<string, unknown> }[]): string {
  return JSON.stringify(proposals);
}

// ==================================================================================================
// RED1 — joined happy path: propose exec.echo {text} -> govern -> bound argv -> Fake echo -> feed back
// ==================================================================================================
describe("EXEC3a — RED1 joined happy: brain proposes a registered exec tool -> real effect -> loop continues", () => {
  it("builds argv ['echo','hello'] from the binding; Fake echoes it; loop runs >=2 turns; >=1 real effect", async () => {
    const log = logPath();
    const substrate = new SpyFakeSandboxAdapter(); // default exec echoes argv.join(' ')
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: {
        FAKE_ACP_SCENARIO: "exec_loop",
        FAKE_ACP_LOG: log,
        FAKE_ACP_EXEC_PROPOSALS: execProposalsEnv([
          { tool: "exec.echo", args: { text: "hello" } },
          { tool: "exec.ls", args: { path: "." } },
        ]),
      },
    });
    const { baseDeps } = makeBaseDeps(seedRegistry());

    const result = await runExecClosedLoop(
      transport,
      substrate,
      baseDeps,
      seedBindings(),
      validCtx,
      "do the thing",
      { maxTurns: 4 },
    );

    // The loop closed (>=2 turns) and at least one REAL effect ran.
    expect(result.turns).toBeGreaterThanOrEqual(2);
    expect(substrate.execCalls.length).toBeGreaterThanOrEqual(1);
    // The argv was built FROM THE BINDING (pure vector), NOT from the brain's raw args.
    expect(substrate.execCalls[0]?.argv).toEqual(["echo", "hello"]);
    // The allowed proposals executed.
    expect(result.outcomes.some((o) => o.status === "executed")).toBe(true);

    // The fed-back text carries the REAL Fake output (the echoed argv), proving the real-output feedback.
    const recorded = readLog(log);
    const fedBack = (recorded.promptTexts ?? []).join("\n");
    expect(fedBack).toContain("echo hello");
    expect(fedBack).toContain("result of exec.echo");
  }, 20_000);
});

// ==================================================================================================
// RED2 — malicious proposals denied, NOT executed, loop continues
// ==================================================================================================
describe("EXEC3a — RED2 malicious proposal denied (not executed), loop continues", () => {
  it("(a) an UNREGISTERED tool name -> denied@policy; execSandbox 0 calls; loop continues + feeds DENIED", async () => {
    const log = logPath();
    const substrate = new SpyFakeSandboxAdapter();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: {
        FAKE_ACP_SCENARIO: "exec_loop",
        FAKE_ACP_LOG: log,
        // An UNREGISTERED, dangerous tool name. authorize denies it deny-by-default; it must NEVER exec.
        FAKE_ACP_EXEC_PROPOSALS: execProposalsEnv([
          { tool: "exec.rm", args: { path: "/" } },
          { tool: "exec.echo", args: { text: "after" } },
        ]),
      },
    });
    const { baseDeps } = makeBaseDeps(seedRegistry());

    const result = await runExecClosedLoop(
      transport,
      substrate,
      baseDeps,
      seedBindings(),
      validCtx,
      "go",
      { maxTurns: 4 },
    );

    // The unregistered tool was denied at the POLICY stage and never reached the effect.
    expect(result.outcomes.some((o) => o.status === "denied" && o.stage === "policy")).toBe(true);
    // No execSandbox call carried the malicious "/" — the only exec (if any) was the later allowed echo.
    expect(substrate.execCalls.some((s) => s.argv.includes("/"))).toBe(false);
    // The loop continued (it did not crash on the denial) and fed back DENIED.
    const recorded = readLog(log);
    const fedBack = (recorded.promptTexts ?? []).join("\n");
    expect(fedBack).toContain("DENIED");
  }, 20_000);

  it("(b) a REGISTERED tool with an EXTRA/unknown arg key -> binding strict schema denies; execSandbox 0", async () => {
    const log = logPath();
    const substrate = new SpyFakeSandboxAdapter();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: {
        FAKE_ACP_SCENARIO: "exec_loop",
        FAKE_ACP_LOG: log,
        // exec.echo IS registered + bound, but the brain smuggles an EXTRA key. The STRICT argSchema
        // must reject it; makeExecEffect/execSandbox NEVER run for this proposal.
        FAKE_ACP_EXEC_PROPOSALS: execProposalsEnv([
          { tool: "exec.echo", args: { text: "hi", inject: "; rm -rf /" } },
        ]),
      },
    });
    const { baseDeps } = makeBaseDeps(seedRegistry());

    const result = await runExecClosedLoop(
      transport,
      substrate,
      baseDeps,
      seedBindings(),
      validCtx,
      "go",
      { maxTurns: 4 },
    );

    // The proposal was admitted by authorize (registered) but the binding DENIED the extra key.
    // The REAL effect resolved {ok:false} -> the governed outcome is "executed" with a deny detail
    // OR the wrapper short-circuited before makeExecEffect; either way execSandbox NEVER ran.
    expect(substrate.execCalls.length).toBe(0);
    const recorded = readLog(log);
    const fedBack = (recorded.promptTexts ?? []).join("\n");
    expect(fedBack).toContain("invalid exec args");
    // It must NOT have executed the smuggled command.
    expect(fedBack).not.toContain("rm -rf");
  }, 20_000);
});

// ==================================================================================================
// RED2 NON-VACUITY — a wrapper that builds argv from the RAW brain args (bypassing the binding) would
// let a "bash -c"/"rm" style proposal EXECUTE. This test pins the bound-argv invariant directly on
// the wrapper unit (no subprocess): the wrapper must NEVER pass raw brain args through as argv.
// ==================================================================================================
describe("EXEC3a — RED2 non-vacuity: the wrapper builds argv ONLY from the binding, never from raw brain args", () => {
  it("a brain that supplies its own argv/raw-shell args cannot reach execSandbox with them", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const wrapped = bindingWrappedExecEffect(substrate, "sbx-x", seedBindings(), { detectSecret });
    const created = await substrate.startSandbox(
      validCtx,
      ((await substrate.createSandbox(validCtx, { image: "x" })) as { sandboxId: string })
        .sandboxId,
    );
    void created;

    // The brain tries to smuggle a raw argv (a shell injection). The binding has no such key, so the
    // STRICT argSchema rejects it -> deny, makeExecEffect/execSandbox NEVER called.
    const res = await wrapped({
      tool: "exec.echo",
      context: validCtx,
      args: { argv: ["bash", "-c", "rm -rf /"] },
    });
    expect(res.ok).toBe(false);
    expect(substrate.execCalls.length).toBe(0);
    // If a mutation made the wrapper forward raw args as argv, execCalls would carry ["bash","-c",...]
    // and ok would be true — this assertion is the non-vacuity guard.
    expect(substrate.execCalls.some((s) => s.argv.includes("bash"))).toBe(false);
  });

  it("an ABSENT binding denies deny-by-default and never calls makeExecEffect/execSandbox", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const wrapped = bindingWrappedExecEffect(substrate, "sbx-x", seedBindings(), { detectSecret });
    const res = await wrapped({ tool: "exec.unbound", context: validCtx, args: { text: "x" } });
    expect(res.ok).toBe(false);
    expect(res.detail).toContain("no exec binding");
    expect(substrate.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// RED3 — credential-blind both directions
// ==================================================================================================
describe("EXEC3a — RED3 credential-blind", () => {
  it("(a) a binding env carrying a runtime-built secret canary -> deny; execSandbox 0 calls", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    const canary = secretCanary();
    // A binding whose composer-built env carries a secret. The credential-blind INPUT guard inside
    // makeExecEffect must DENY before execSandbox — the substrate/process never sees the raw secret.
    const envBinding: ExecToolBinding = {
      argvPrefix: ["echo"],
      argSchema: z.object({ text: z.string() }).strict(),
      toArgv: (a) => [(a as { text: string }).text],
      toEnv: () => ({ LEAK: canary }),
    };
    const bindings = new Map<string, ExecToolBinding>([["exec.echo", envBinding]]);
    const wrapped = bindingWrappedExecEffect(substrate, "sbx-x", bindings, { detectSecret });
    const { sandboxId } = (await substrate.createSandbox(validCtx, { image: "x" })) as {
      sandboxId: string;
    };
    await substrate.startSandbox(validCtx, sandboxId);
    const wrapped2 = bindingWrappedExecEffect(substrate, sandboxId, bindings, { detectSecret });
    void wrapped;

    const res = await wrapped2({ tool: "exec.echo", context: validCtx, args: { text: "hi" } });
    expect(res.ok).toBe(false);
    expect(substrate.execCalls.length).toBe(0);
  });

  it("(b) Fake exec stdout echoes a secret canary -> the fed-back text is redacted (canary absent)", async () => {
    const log = logPath();
    const canary = secretCanary();
    const substrate = new SpyFakeSandboxAdapter({
      // The command's REAL stdout leaks a secret. The double redaction (effect + loop) must strip it
      // BEFORE it egresses back to Hermes.
      exec: (spec) => ({
        ok: true,
        exitCode: 0,
        stdout: `${spec.argv.join(" ")} leaked ${canary} done`,
        stderr: "",
        truncated: false,
      }),
    });
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: {
        FAKE_ACP_SCENARIO: "exec_loop",
        FAKE_ACP_LOG: log,
        FAKE_ACP_EXEC_PROPOSALS: execProposalsEnv([{ tool: "exec.echo", args: { text: "hi" } }]),
      },
    });
    const { baseDeps } = makeBaseDeps(seedRegistry());

    await runExecClosedLoop(transport, substrate, baseDeps, seedBindings(), validCtx, "go", {
      maxTurns: 4,
    });

    // The canary the command really produced must NOT egress to Hermes.
    const recorded = readLog(log);
    const fedBack = (recorded.promptTexts ?? []).join("\n");
    const stdin = recorded.stdinLines.join("\n");
    expect(fedBack).not.toContain(canary);
    expect(stdin).not.toContain(canary);
    // Non-vacuity: the effect really ran (the command was executed), so the canary really was produced.
    expect(substrate.execCalls.length).toBeGreaterThanOrEqual(1);
  }, 20_000);
});

// ==================================================================================================
// RED4 — blast-radius cap: a never-ending exec loop is bounded by maxTurns (REAL effect count bounded)
// ==================================================================================================
describe("EXEC3a — RED4 blast-radius cap bounds the REAL effect count", () => {
  it("exec_loop_forever + maxTurns=3 -> turns=3, stoppedBy=maxTurns, real execSandbox calls=3", async () => {
    const log = logPath();
    const substrate = new SpyFakeSandboxAdapter();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: {
        FAKE_ACP_SCENARIO: "exec_loop_forever",
        FAKE_ACP_LOG: log,
        FAKE_ACP_EXEC_PROPOSALS: execProposalsEnv([{ tool: "exec.echo", args: { text: "spin" } }]),
      },
    });
    const { baseDeps } = makeBaseDeps(seedRegistry());

    const result = await runExecClosedLoop(
      transport,
      substrate,
      baseDeps,
      seedBindings(),
      validCtx,
      "spin",
      { maxTurns: 3 },
    );

    expect(result.turns).toBe(3);
    expect(result.stoppedBy).toBe("maxTurns");
    // The REAL effect ran exactly once per turn up to the cap — blast radius is bounded.
    expect(substrate.execCalls.length).toBe(3);
    // The ephemeral sandbox was still destroyed (fail-closed finally) even though we stopped at the cap.
    expect(substrate.destroyCalls.length).toBe(1);
  }, 25_000);
});

// ==================================================================================================
// RED5 — commit-before-REAL-effect: a rejecting appender => makeExecEffect/execSandbox 0 calls
// ==================================================================================================
describe("EXEC3a — RED5 commit-before-REAL-effect (no real command on an aborted commit)", () => {
  it("a rejecting appender aborts BEFORE the real effect; execSandbox 0; outcome denied@commit; feeds DENIED not 'result of'", async () => {
    const log = logPath();
    const substrate = new SpyFakeSandboxAdapter();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: {
        FAKE_ACP_SCENARIO: "exec_loop",
        FAKE_ACP_LOG: log,
        FAKE_ACP_EXEC_PROPOSALS: execProposalsEnv([{ tool: "exec.echo", args: { text: "hi" } }]),
      },
    });
    const { baseDeps } = makeBaseDeps(seedRegistry(), { appenderRejects: true });

    const result = await runExecClosedLoop(
      transport,
      substrate,
      baseDeps,
      seedBindings(),
      validCtx,
      "go",
      { maxTurns: 4 },
    );

    // The REAL effect NEVER ran (commit aborted before effect).
    expect(substrate.execCalls.length).toBe(0);
    expect(result.outcomes.some((o) => o.status === "denied" && o.stage === "commit")).toBe(true);
    const recorded = readLog(log);
    const fedBack = (recorded.promptTexts ?? []).join("\n");
    expect(fedBack).toContain("DENIED");
    expect(fedBack).not.toContain("result of");
  }, 20_000);
});

// ==================================================================================================
// RED6 — ephemeral sandbox lifecycle: create+start BEFORE the first proposal; destroy in finally
//         even on a thrown transport AND on maxTurns.
// ==================================================================================================
describe("EXEC3a — RED6 ephemeral sandbox: create+start before the loop, destroy in finally", () => {
  it("happy run: createSandbox + startSandbox ran, then destroySandbox ran exactly once", async () => {
    const log = logPath();
    const substrate = new SpyFakeSandboxAdapter();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: {
        FAKE_ACP_SCENARIO: "exec_loop",
        FAKE_ACP_LOG: log,
        FAKE_ACP_EXEC_PROPOSALS: execProposalsEnv([{ tool: "exec.echo", args: { text: "hi" } }]),
      },
    });
    const { baseDeps } = makeBaseDeps(seedRegistry());

    await runExecClosedLoop(transport, substrate, baseDeps, seedBindings(), validCtx, "go", {
      maxTurns: 4,
    });

    expect(substrate.createCalls.length).toBe(1);
    expect(substrate.startCalls.length).toBe(1);
    expect(substrate.destroyCalls.length).toBe(1);
    // The destroyed id is the one that was created+started+exec'd against (one ephemeral sandbox).
    expect(substrate.startCalls[0]).toBe(substrate.destroyCalls[0]);
  }, 20_000);

  it("a THROWING transport (spawn failure) STILL destroys the sandbox in the finally", async () => {
    const substrate = new SpyFakeSandboxAdapter();
    // A nonexistent module -> node exits non-zero before the handshake -> openSession() rejects.
    const transport = new AcpStdioTransport({
      command: ["node", "/does/not/exist-exec-acp-xyz.mjs"],
      cwd: emptyCwd(),
    });
    const { baseDeps } = makeBaseDeps(seedRegistry());

    await expect(
      runExecClosedLoop(transport, substrate, baseDeps, seedBindings(), validCtx, "go", {
        maxTurns: 4,
      }),
    ).rejects.toThrow();

    // The sandbox was created BEFORE the loop and destroyed in the FINALLY even though the loop threw.
    // NON-VACUITY: removing the finally-destroy makes destroyCalls 0 -> RED.
    expect(substrate.createCalls.length).toBe(1);
    expect(substrate.destroyCalls.length).toBe(1);
  }, 20_000);
});
