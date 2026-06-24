/**
 * SLICE-DHB3a — CLOSED agentic loop (Design B: conversational result feedback). RED-first.
 *
 * DHB2 proved desktop Hermes drives Agent OS ONE-SHOT (propose-only, single prompt). DHB3a closes the
 * loop: for each turn's proposals the multi-turn DRIVER runs the SAME `runGovernedToolCall`
 * (screen->authorize->cost->commit-before-effect->effect) over Agent OS's own injected deps, redacts +
 * serializes the `GovernedOutcome`, and feeds it back to Hermes over a HELD duplex ACP session as the
 * NEXT `session/prompt` — looping until a terminal stopReason / no new proposal / a hard `maxTurns` cap.
 *
 * These tests prove the WHOLE loop against (1) the in-tree FAKE `hermes acp` subprocess driven by
 * FAKE_ACP_SCENARIO=loop|loop_forever (no model call, no credits) + (2) a deterministic FAKE
 * `GovernedToolCallDeps` (an injectable authorize + a counting Fake effect). NO live, NO ~/.hermes.
 *
 * NON-VACUITY (mutation that flips each invariant): skip-redactSecrets -> RED3; auto-approve permission
 * -> RED4; remove maxTurns cap -> RED5 hangs/spins; run-effect-before-commit -> RED6; deny-still-
 * executes -> RED2; no follow-up prompt -> RED1.
 *
 * HONEST BOUNDARY: DHB3a proves the closed loop + governance integration + redaction + cap + the 6
 * invariants against a FAKE. The real Hermes return-edge ACP dialect = DHB3b (live, user-initiated).
 * The substrate has no exec primitive yet, so the effect result is the Fake's canned detail.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import type {
  AuthorizeDecision,
  GovernedCall as GovernedToolCall,
  GovernedToolCallDeps,
} from "../../../../orchestration/index.js";
import { AcpStdioTransport, runClosedLoop } from "./index.js";

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
  const dir = mkdtempSync(join(tmpdir(), "acp-loop-test-"));
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
  permissionApproved: boolean;
  toolExecuted: boolean;
  promptTexts?: string[];
  permissionResponsesPerTurn?: unknown[];
};
function readLog(path: string): FakeLog {
  return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A deterministic FAKE GovernedToolCallDeps. `authorize` is injectable (default allow); `effect` is a
 * counting Fake that returns a canned detail (optionally a runtime-built secret canary). NO real
 * substrate (substrate has no exec primitive yet — see honest boundary). Mirrors the developer
 * surface's deps shape (registry-backed authorize, InMemoryCostGate, seam appender) minus the WORM.
 */
interface FakeDepsOptions {
  readonly authorize?: (tc: GovernedToolCall) => AuthorizeDecision;
  readonly detail?: (tc: GovernedToolCall) => string;
  readonly appenderRejects?: boolean;
  readonly budget?: number;
}
interface FakeDepsKit {
  readonly deps: GovernedToolCallDeps<GovernedToolCall, { id: number }>;
  readonly effectCalls: GovernedToolCall[];
  readonly appendCalls: unknown[];
  /** call order: "append" then "effect" — proves commit-before-effect ordering. */
  readonly order: string[];
}
function makeFakeDeps(opts: FakeDepsOptions = {}): FakeDepsKit {
  const effectCalls: GovernedToolCall[] = [];
  const appendCalls: unknown[] = [];
  const order: string[] = [];
  let receiptId = 0;
  const cost: CostGate = new InMemoryCostGate(opts.budget ?? 1_000_000);
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appendCalls.push(event);
      order.push("append");
      if (opts.appenderRejects === true) {
        return Promise.reject(new Error("fake appender refused (WORM down)"));
      }
      return Promise.resolve({ id: ++receiptId });
    },
  };
  const deps: GovernedToolCallDeps<GovernedToolCall, { id: number }> = {
    screen: () => ({ ok: true }),
    authorize: opts.authorize ?? (() => ({ effect: "allow", reason: "fake allow" })),
    cost,
    estimateTokens: () => 10,
    appender,
    effect: (tc) => {
      effectCalls.push(tc);
      order.push("effect");
      return Promise.resolve({
        ok: true,
        detail: opts.detail?.(tc) ?? `did ${tc.tool}`,
        tokensUsed: 5,
      });
    },
  };
  return { deps, effectCalls, appendCalls, order };
}

describe("DHB3a closed loop — RED1 happy: propose -> govern -> feed back -> continue", () => {
  it("runs >=2 turns; each tool-call proposal is governed (Fake effect ran for allowed ones)", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop", FAKE_ACP_LOG: log },
    });
    const kit = makeFakeDeps();
    const result = await runClosedLoop(transport, kit.deps, validCtx, "ship it", { maxTurns: 12 });

    // The loop ran more than one turn (proposal#1 -> follow-up -> proposal#2 -> ... -> end_turn).
    expect(result.turns).toBeGreaterThanOrEqual(2);
    // Every tool-call proposal that authorize allowed actually ran the Fake effect.
    expect(kit.effectCalls.length).toBeGreaterThanOrEqual(2);
    // All outcomes for allowed calls are "executed".
    expect(result.outcomes.every((o) => o.status === "executed")).toBe(true);

    const recorded = readLog(log);
    // The fake received a SECOND session/prompt (the fed-back result) — that is the loop closing.
    const promptCount = recorded.methodsReceived.filter((m) => m === "session/prompt").length;
    expect(promptCount).toBeGreaterThanOrEqual(2);
  });
});

describe("DHB3a closed loop — RED2 denied does NOT execute + IS reported", () => {
  it("a denied proposal runs the Fake effect 0 times and the fed-back prompt contains DENIED", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop", FAKE_ACP_LOG: log },
    });
    // Authorize DENIES every proposal.
    const kit = makeFakeDeps({ authorize: () => ({ effect: "deny", reason: "not allowed here" }) });
    const result = await runClosedLoop(transport, kit.deps, validCtx, "ship it", { maxTurns: 12 });

    // The effect NEVER ran for a denied proposal.
    expect(kit.effectCalls.length).toBe(0);
    // The outcome was a policy denial...
    expect(result.outcomes.some((o) => o.status === "denied")).toBe(true);
    // ...and the text fed back to the fake reports the denial.
    const recorded = readLog(log);
    const fedBack = (recorded.promptTexts ?? []).join("\n");
    expect(fedBack).toContain("DENIED");
  });
});

describe("DHB3a closed loop — RED3 credential-blind outbound", () => {
  it("a secret canary in EffectResult.detail is redacted BEFORE it reaches the fake's stdin", async () => {
    const log = logPath();
    // Runtime-built secret canary (NOT a source literal -> secret-scan stays clean).
    const canary = `sk-${"d".repeat(28)}`;
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop", FAKE_ACP_LOG: log },
    });
    const kit = makeFakeDeps({ detail: () => `leaked ${canary} done` });
    await runClosedLoop(transport, kit.deps, validCtx, "ship it", { maxTurns: 12 });

    const recorded = readLog(log);
    const stdin = recorded.stdinLines.join("\n");
    // The canary the effect produced must NOT egress to Hermes — redactSecrets fired before the
    // follow-up prompt was sent. (If the DRIVER skipped redactSecrets, this assertion goes RED.)
    expect(stdin).not.toContain(canary);
    // The effect did run (so the canary really was produced; this is not vacuously true).
    expect(kit.effectCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("DHB3a closed loop — RED4 propose-only preserved across the loop", () => {
  it("session/request_permission is answered cancelled on EVERY turn; the fake never self-executes", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop", FAKE_ACP_LOG: log },
    });
    const kit = makeFakeDeps();
    await runClosedLoop(transport, kit.deps, validCtx, "ship it", { maxTurns: 12 });

    const recorded = readLog(log);
    // The fake asked for permission and was DENIED every time — it never self-executed.
    expect(recorded.permissionApproved).toBe(false);
    expect(recorded.toolExecuted).toBe(false);
    // Each recorded permission response (one per turn that asked) was a cancellation.
    for (const r of recorded.permissionResponsesPerTurn ?? []) {
      const outcome = (r as { outcome?: { outcome?: string } })?.outcome?.outcome;
      expect(outcome).toBe("cancelled");
    }
  });
});

describe("DHB3a closed loop — RED5 termination cap", () => {
  it("loop_forever never resolves end_turn -> the DRIVER stops at maxTurns (no orphan, no spin)", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop_forever", FAKE_ACP_LOG: log },
    });
    const kit = makeFakeDeps();
    // A SMALL injected cap so the test is fast + bounded.
    const result = await runClosedLoop(transport, kit.deps, validCtx, "ship it", { maxTurns: 3 });

    // The DRIVER stopped at exactly the cap (it did not spin unbounded).
    expect(result.turns).toBe(3);
    expect(result.stoppedBy).toBe("maxTurns");
    // It governed one proposal per turn up to the cap.
    expect(kit.effectCalls.length).toBe(3);
  }, 20_000);

  it("default maxTurns is 12 (a conservative hard cap)", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop_forever", FAKE_ACP_LOG: log },
    });
    const kit = makeFakeDeps();
    // No maxTurns option -> default applies.
    const result = await runClosedLoop(transport, kit.deps, validCtx, "ship it");
    expect(result.turns).toBe(12);
    expect(result.stoppedBy).toBe("maxTurns");
  }, 30_000);
});

describe("DHB3a closed loop — RED6 commit-before-effect + no-result-on-abort", () => {
  it("an appender that REJECTS aborts the effect AND sends no fabricated follow-up result", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop", FAKE_ACP_LOG: log },
    });
    const kit = makeFakeDeps({ appenderRejects: true });
    const result = await runClosedLoop(transport, kit.deps, validCtx, "ship it", { maxTurns: 12 });

    // The effect NEVER ran (commit aborted before effect).
    expect(kit.effectCalls.length).toBe(0);
    // The outcome is a commit-stage denial (not a fabricated success).
    expect(result.outcomes.some((o) => o.status === "denied" && o.stage === "commit")).toBe(true);

    const recorded = readLog(log);
    const fedBack = (recorded.promptTexts ?? []).join("\n");
    // An aborted commit => deny, NOT a fabricated "result of <tool>". It must be reported as a denial.
    expect(fedBack).toContain("DENIED");
    expect(fedBack).not.toContain("result of");
  });
});

/**
 * DHB3a DUPLEX FAIL-CLOSED — drives the NEW duplex surface directly (openSession / nextTurn / feed /
 * close), not via the happy loop. Fail-closed on the held session is a security property: a
 * spawn/nonzero/malformed/EOF/JSON-RPC error must REJECT (deny-by-default), never fabricate a turn; an
 * early consumer close() must leave no hang + no orphan, and feed() after close() must reject.
 *
 * Reuses the existing fail-closed fake scenarios (nonzero / malformed / eof) — the same ones the
 * one-shot acp-stdio.test.ts uses — exercised through the duplex entry point this time.
 *
 * NON-VACUITY (mutation that flips each — confirmed + reverted):
 *   (a)(b)(c) malformed/nonzero/EOF: making DuplexAcpSession.failAll RESOLVE the in-flight turn with a
 *     fabricated `{frames:[],stopReason:"end_turn"}` (swallow-the-error-and-continue) instead of
 *     rejecting `currentTurn` -> all three go RED. (The operative fail-closed edge for these is the
 *     in-flight `currentTurn.reject` inside failAll — not the `this.fatal` top-guard in nextTurn.)
 *   (d) spawn: an openSession() / start() that does not rethrow the handshake/spawn error -> RED.
 *   (e) early-stop: a feed() that does not guard `this.closed` -> the close()-then-feed reject goes RED.
 */
describe("DHB3a duplex transport — fail-closed (deny-by-default) on the held session", () => {
  it("(a) malformed JSON line mid-session -> nextTurn() REJECTS (no fabricated turn)", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "malformed" },
    });
    const session = await transport.openSession("x");
    // The fake emits a non-JSON line mid-prompt; the duplex parser must fail-closed -> the in-flight
    // turn rejects rather than resolving a fabricated frame.
    await expect(session.nextTurn()).rejects.toThrow();
    await session.close();
  }, 15_000);

  it("(b) non-zero exit before a prompt resolves -> nextTurn() REJECTS", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "nonzero" },
    });
    const session = await transport.openSession("x");
    await expect(session.nextTurn()).rejects.toThrow();
    await session.close();
  }, 15_000);

  it("(c) stdout EOF mid-prompt (no stopReason) -> nextTurn() REJECTS", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "eof" },
    });
    const session = await transport.openSession("x");
    await expect(session.nextTurn()).rejects.toThrow();
    await session.close();
  }, 15_000);

  it("(d) spawn of a nonexistent binary -> openSession() REJECTS fail-closed", async () => {
    const transport = new AcpStdioTransport({
      command: ["node", "/does/not/exist-acp-xyz.mjs"],
      cwd: emptyCwd(),
    });
    // node exits non-zero (cannot find the module) before the handshake completes -> the handshake
    // request rejects -> openSession() rejects. (A truly nonexistent BIN would throw spawn ENOENT,
    // also fail-closed; using node + a bad path keeps the test deterministic across platforms.)
    await expect(transport.openSession("x")).rejects.toThrow();
  }, 15_000);

  it("(e) early-stop teardown: read one turn then close() -> no hang/orphan; feed() after close() REJECTS", async () => {
    const log = logPath();
    const transport = new AcpStdioTransport({
      command: ["node", FAKE],
      cwd: emptyCwd(),
      env: { FAKE_ACP_SCENARIO: "loop", FAKE_ACP_LOG: log },
    });
    const session = await transport.openSession("x");
    // Read exactly ONE turn (the first proposal), then stop early.
    const first = await session.nextTurn();
    expect(first).not.toBeNull();
    expect(first?.frames.some((f) => f.sessionUpdate === "tool_call")).toBe(true);

    // Consumer closes early — the child must be torn down (SIGKILL in finally), no hang, no orphan.
    await session.close();

    // feed() after close() must fail-closed (a closed session never sends another prompt).
    await expect(session.feed("late result")).rejects.toThrow();
    // close() is idempotent — a second close must not hang or throw.
    await expect(session.close()).resolves.toBeUndefined();
  }, 15_000);
});
