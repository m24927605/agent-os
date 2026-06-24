/**
 * SLICE-EXEC3b — `makeArgsCredentialScreen` UNIT tests (in `pnpm run verify`, hermetic, NO live).
 *
 * This is the finding-② fix: the EXEC closed loop's real `deps.screen`. The pipeline order is
 * `screen -> authorize -> cost -> commit -> effect`, so a brain proposal carrying a literal secret in a
 * DECLARED arg must be DENIED at the screen stage BEFORE authorize/cost/commit/effect ever run. These
 * tests pin both directions:
 *
 *   • a secret-shaped arg VALUE  -> { ok:false }, and wired as `deps.screen` the EFFECT is NEVER reached
 *     (denied@screen, no execSandbox-equivalent call) — the NON-VACUITY guard: a mutation that returns
 *     `{ ok:true }` always (or skips the detector) flips this RED.
 *   • a bundleRef/placeholder arg -> { ok:true } (credential-blind does NOT over-block a benign reference).
 *   • a detector that THROWS      -> { ok:false } (fail-closed deny-by-default).
 *   • the DEFAULT detector (no arg) is the production `redactSecrets`-changed test.
 *
 * No subprocess, no model, no AGENTOS_LIVE_* — pure unit. The secret CANARY is built at runtime (never a
 * source literal) so secret-scan stays clean.
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../../../audit/index.js";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import { type GovernedToolCallDeps, runGovernedToolCall } from "../../../../orchestration/index.js";
import type { SecretDetector } from "../../index.js";
import { makeArgsCredentialScreen } from "./index.js";

const CTX = {
  actorId: "agent:exec3b-args-screen",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
};

/** The repo's real detector (same construction as every bootstrap): secret-shaped iff redact changes it. */
const detectSecret: SecretDetector = (v) => JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/** Runtime-built secret canary matching audit/redact's `sk-...` shape (NOT a source literal). */
function secretCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`; // 24 alnum chars => matches /sk-[A-Za-z0-9]{16,}/
}

// A proposal shape the screen + pipeline both accept (tool + context + declared args).
interface Call {
  readonly tool: string;
  readonly context: typeof CTX;
  readonly args?: Record<string, unknown>;
}

/**
 * Wire the screen as the pipeline's `deps.screen` with a SPYING effect, so we can assert the effect is
 * NEVER reached for a denied screen (the whole point — the secret never reaches policy/cost/commit/effect).
 */
function pipelineWith(screen: GovernedToolCallDeps<Call, { id: number }>["screen"]): {
  deps: GovernedToolCallDeps<Call, { id: number }>;
  effectCalls: Call[];
} {
  const effectCalls: Call[] = [];
  let receiptId = 0;
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  const appender: CommitAppender<unknown, { id: number }> = {
    append: () => Promise.resolve({ id: ++receiptId }),
  };
  const deps: GovernedToolCallDeps<Call, { id: number }> = {
    screen,
    authorize: () => ({ effect: "allow", reason: "test allow" }),
    cost,
    estimateTokens: () => 10,
    appender,
    effect: (tc) => {
      effectCalls.push(tc);
      return Promise.resolve({ ok: true, detail: "ran" });
    },
  };
  return { deps, effectCalls };
}

describe("EXEC3b — makeArgsCredentialScreen denies a secret-shaped declared arg (finding ② fix)", () => {
  it("a secret-shaped arg VALUE -> { ok:false } with the credential-blind reason", () => {
    const screen = makeArgsCredentialScreen(detectSecret);
    const outcome = screen({ context: CTX, args: { text: secretCanary() } });
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) {
      expect(outcome.reason).toContain("credential-blind");
    }
  });

  it("wired as deps.screen, a secret-shaped arg is denied@screen and the EFFECT is NEVER reached (non-vacuity)", async () => {
    const { deps, effectCalls } = pipelineWith(makeArgsCredentialScreen(detectSecret));
    const outcome = await runGovernedToolCall(deps, {
      tool: "exec.echo",
      context: CTX,
      args: { text: secretCanary() },
    });
    // Denied at the FIRST gate — before authorize/cost/commit/effect.
    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") expect(outcome.stage).toBe("screen");
    // The whole point: the secret never reached the effect. A mutation that returns { ok:true } always
    // (or skips the detector) would let the effect run -> this assertion flips RED.
    expect(effectCalls.length).toBe(0);
  });

  it("a bundleRef/placeholder arg -> { ok:true } (does NOT over-block a benign reference)", () => {
    const screen = makeArgsCredentialScreen(detectSecret);
    expect(screen({ context: CTX, args: { text: "hello world" } }).ok).toBe(true);
    expect(screen({ context: CTX, args: { ref: "bundleRef:github:PAT:prod" } }).ok).toBe(true);
    expect(screen({ context: CTX, args: { path: "." } }).ok).toBe(true);
    // No args at all -> OK.
    expect(screen({ context: CTX }).ok).toBe(true);
  });

  it("a benign arg, wired as deps.screen, REACHES the effect (proves the OK path is not vacuously blocking)", async () => {
    const { deps, effectCalls } = pipelineWith(makeArgsCredentialScreen(detectSecret));
    const outcome = await runGovernedToolCall(deps, {
      tool: "exec.echo",
      context: CTX,
      args: { text: "hello" },
    });
    expect(outcome.status).toBe("executed");
    expect(effectCalls.length).toBe(1);
  });

  it("a detector that THROWS -> { ok:false } (fail-closed deny-by-default)", () => {
    const throwing: SecretDetector = () => {
      throw new Error("detector boom");
    };
    const screen = makeArgsCredentialScreen(throwing);
    const outcome = screen({ context: CTX, args: { text: "anything" } });
    expect(outcome.ok).toBe(false);
  });

  it("the DEFAULT detector (no arg) catches a secret-shaped value (production redactSecrets-changed)", () => {
    const screen = makeArgsCredentialScreen(); // no detector -> production default
    expect(screen({ context: CTX, args: { text: secretCanary() } }).ok).toBe(false);
    expect(screen({ context: CTX, args: { text: "benign" } }).ok).toBe(true);
  });
});
