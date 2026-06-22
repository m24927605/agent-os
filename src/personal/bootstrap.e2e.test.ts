/**
 * END-TO-END composition proof for the Personal vertical (SLICE-P2R-PV-S1).
 *
 * This drives the in-memory composition root `createPersonalShell` through the WHOLE Personal-surface
 * spine — `文字 → 澄清 → 白話計畫 → 核可 → 治理管線(screen→PDP→cost→commit-before-effect→effect) → 時間軸` —
 * with the REAL in-tree fakes (FakeSandboxAdapter, InMemoryCostGate, screenBrainEvent, evaluatePolicy,
 * a shared InMemoryAppendOnlyLog). It proves:
 *   (1) happy path lands a real effect AND a readable, completed timeline event;
 *   (2)-(4) the three governance gates (screen / policy / cost) short-circuit and the effect never runs;
 *   (5) approve is one-time (terminal, replay-safe);
 *   (6) the clarify loop is hard-capped at CLARIFY_MAX_QUESTIONS;
 * and that the runtime-assembled secret canary is ABSENT from the timeline (exit redaction).
 *
 * RED-first: `./bootstrap.js` does not exist yet, so the import below fails and the suite cannot run.
 */
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../iam/ids.js";
import { createPersonalShell } from "./bootstrap.js";
import { CLARIFY_MAX_QUESTIONS } from "./intent/index.js";
import { StructuredIntent } from "./intent/index.js";

// A runtime-assembled secret canary — never a literal in source, so scan_secrets.sh stays clean.
const CANARY = `sk-${"d".repeat(24)}`;

const ctx: AgentContext = StructuredIntent.shape.context.parse({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
});

/** A clean, parseable intent text the deterministic gateway resolves to action+targets. */
const LEGAL_TEXT = "backup notes archive";

describe("createPersonalShell — end-to-end Personal vertical over the real in-memory fakes", () => {
  it("HAPPY PATH: legal text -> preview -> submit{pending,id} -> approve -> executed + real effect + completed timeline", async () => {
    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: true });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const preview = shell.preview(received.intent);
    expect(preview.steps.length).toBeGreaterThan(0);

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    expect(decided.status).toBe("executed");
    if (decided.status !== "executed") return;
    expect(decided.outcome.status).toBe("executed");

    // The FakeSandbox really created a sandbox during the effect: the created id is startable.
    const fakeRan = await shell.probeLastSandbox();
    expect(fakeRan.status).toBe("ok");

    // The timeline reads the SAME shared WORM the appender wrote into -> >=1 completed event.
    const events = shell.timeline(ctx.taskId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.headline.startsWith("已完成"))).toBe(true);

    // Exit redaction holds even on a clean run: no secret canary anywhere in the timeline text.
    const text = JSON.stringify(events);
    expect(text).not.toContain(CANARY);
  });

  it("SCREEN short-circuit: a secret canary in a target -> denied@screen, NO effect, canary absent from timeline", async () => {
    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: true });

    // Build an intent whose TARGET carries the canary. StructuredIntent only secret-checks rawText,
    // so a canary can slip into a target — exactly the defense-in-depth case the screen guard exists
    // for. rawText is kept clean (no secret shape) so the intent parses.
    const intent = StructuredIntent.parse({
      action: "backup",
      targets: [CANARY, "archive"],
      context: ctx,
      rawText: "backup archive",
    });

    const submitted = shell.previewAndSubmit(intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "screen" });

    // Effect never ran -> no sandbox was created.
    const fakeRan = await shell.probeLastSandbox();
    expect(fakeRan.status).toBe("denied");

    // Nothing was committed and the canary never reaches a human-readable surface.
    const events = shell.timeline(ctx.taskId);
    expect(events.length).toBe(0);
    expect(JSON.stringify(events)).not.toContain(CANARY);
  });

  it("POLICY short-circuit: no allow rule -> denied@policy, NO effect", async () => {
    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: false });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "policy" });
    expect((await shell.probeLastSandbox()).status).toBe("denied");
    expect(shell.timeline(ctx.taskId).length).toBe(0);
  });

  it("COST short-circuit: tiny budget / large estimate -> denied@cost, NO effect", async () => {
    const shell = createPersonalShell({ budget: 5, allowToolInvoke: true, estimateTokens: 50 });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    expect(decided).toMatchObject({ status: "denied" });
    expect(decided.outcome).toMatchObject({ status: "denied", stage: "cost" });
    expect((await shell.probeLastSandbox()).status).toBe("denied");
    expect(shell.timeline(ctx.taskId).length).toBe(0);
  });

  it("APPROVE-ONCE: a second approve(id) is denied (terminal, replay-safe)", async () => {
    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: true });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const first = await shell.approve(submitted.id);
    expect(first.status).toBe("executed");

    const second = await shell.approve(submitted.id);
    expect(second.status).toBe("denied");
    // A second approve never re-ran the effect -> exactly one committed event for the task.
    expect(shell.timeline(ctx.taskId).length).toBe(1);
  });

  it("CLARIFY-CAP: ambiguous text answered past CLARIFY_MAX_QUESTIONS -> clarify denied", async () => {
    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: true });

    // "backup" with no target is needs-clarification; answering only with stopwords keeps it ambiguous
    // so the loop must exhaust its hard cap and deny rather than guess.
    let step = shell.clarify("backup", ctx);
    expect(step.status).toBe("asking");

    let asks = 0;
    while (step.status === "asking") {
      asks++;
      step = shell.answer(step, "the"); // a stopword -> still no usable target
    }
    expect(step.status).toBe("denied");
    expect(asks).toBe(CLARIFY_MAX_QUESTIONS);
  });
});
