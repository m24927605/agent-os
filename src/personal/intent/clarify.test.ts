import { describe, expect, it } from "vitest";
import { type AgentContext, parseAgentContext } from "../../iam/ids.js";
import { CLARIFY_MAX_QUESTIONS, type ClarifyStep, answerClarify, startClarify } from "./index.js";

// A valid zero-skill caller identity (same shape as the S1 gateway tests).
const ctx: AgentContext = parseAgentContext({
  actorId: "user-1",
  tenantId: "personal",
  projectId: "home",
  taskId: "task-1",
  requestId: "req-1",
});

// Secret-shaped canary assembled at runtime — NEVER a source literal, so scan_secrets.sh
// does not flag this file (design §1 invariant 4: canary is an in-memory sentinel).
const SK = `sk-${"a".repeat(32)}`;

// Narrow a ClarifyStep to the `asking` variant, failing the test loudly otherwise.
function asAsking(step: ClarifyStep): ClarifyStep & { status: "asking" } {
  if (step.status !== "asking") {
    throw new Error(`expected asking, got ${step.status}`);
  }
  return step;
}

describe("ClarifyLoop — ≤3 questions then fail-closed deny", () => {
  it("exposes a hard cap of 3 questions", () => {
    expect(CLARIFY_MAX_QUESTIONS).toBe(3);
  });

  it("already-complete text resolves immediately (no question asked)", () => {
    const step = startClarify("backup my photos folder", ctx);
    expect(step.status).toBe("resolved");
    if (step.status !== "resolved") throw new Error("expected resolved");
    expect(step.intent.action).toBe("backup");
    expect(step.intent.targets).toContain("photos");
  });

  it("denied text from the gateway stays denied (never asks)", () => {
    const step = startClarify("frobnicate everything", ctx);
    expect(step.status).toBe("denied");
  });

  it("one missing field → asking (asked=1) → answered → resolved", () => {
    const first = asAsking(startClarify("backup", ctx));
    expect(first.missing).toBe("targets");
    expect(first.asked).toBe(1);
    expect(first.question.length).toBeGreaterThan(0);

    const resolved = answerClarify(first, "photos");
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") throw new Error("expected resolved");
    expect(resolved.intent.action).toBe("backup");
    expect(resolved.intent.targets).toContain("photos");
  });

  it("answers that stay ambiguous keep asking with an incrementing counter", () => {
    const q1 = asAsking(startClarify("backup", ctx));
    expect(q1.asked).toBe(1);
    // An answer made only of stopwords/punctuation adds no usable target → still ambiguous.
    const q2 = asAsking(answerClarify(q1, "the"));
    expect(q2.asked).toBe(2);
    const q3 = asAsking(answerClarify(q2, "a"));
    expect(q3.asked).toBe(3);
  });

  it("fail-closed (adversarial): 3 questions exhausted while still ambiguous → denied, no intent", () => {
    let step: ClarifyStep = startClarify("backup", ctx);
    // Feed three useless answers; the loop must deny on budget exhaustion, never guess.
    for (const bad of ["the", "a", "an"]) {
      step = answerClarify(asAsking(step), bad);
    }
    expect(step.status).toBe("denied");
    if (step.status !== "denied") throw new Error("expected denied");
    expect(step.reason.toLowerCase()).toContain("budget");
    // The denied step must NOT carry an intent under any key.
    expect(JSON.stringify(step)).not.toContain('"intent"');
  });

  it("hard cap cannot be bypassed: answering a denied state is an inert deny (no new question)", () => {
    let step: ClarifyStep = startClarify("backup", ctx);
    for (const bad of ["the", "a", "an"]) {
      step = answerClarify(asAsking(step), bad);
    }
    expect(step.status).toBe("denied");
    // A 4th call on the (already denied) state must not re-open the loop.
    const fourth = answerClarify(step as ClarifyStep & { status: "asking" }, "photos");
    expect(fourth.status).toBe("denied");
  });

  it("hard cap cannot be bypassed: answering a resolved state stays resolved", () => {
    const first = asAsking(startClarify("backup", ctx));
    const resolved = answerClarify(first, "photos");
    expect(resolved.status).toBe("resolved");
    const again = answerClarify(resolved as ClarifyStep & { status: "asking" }, "videos");
    expect(again.status).toBe("resolved");
  });

  it("credential non-leak: a secret-like answer is redacted before merge; canary never survives", () => {
    // Smuggle the canary as the answer to the first question. It must be scrubbed before being
    // merged into the accumulated text, so it can never reach a resolved intent or a denied reason.
    const step = answerClarify(asAsking(startClarify("backup", ctx)), SK);
    const serialized = JSON.stringify(step);
    expect(serialized).not.toContain(SK);
    expect(serialized).not.toContain("sk-aaaa");
    if (step.status === "resolved") {
      expect(step.intent.rawText).not.toContain(SK);
      expect(step.intent.rawText).toContain("[REDACTED]");
    }
  });

  it("credential non-leak on the deny path: an exhausted budget reason carries no canary", () => {
    // Even when every answer is useless AND one is secret-shaped, the deny reason must be clean.
    let step: ClarifyStep = startClarify("backup", ctx);
    for (const ans of ["the", "a", SK]) {
      step = answerClarify(asAsking(step), ans);
    }
    const serialized = JSON.stringify(step);
    expect(serialized).not.toContain(SK);
    expect(serialized).not.toContain("sk-aaaa");
  });
});
