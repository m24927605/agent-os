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
import type { AppendReceipt, AuditEvent, LogEntry } from "../audit/index.js";
import { createAuditEvent } from "../audit/index.js";
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
    const events = await shell.timeline(ctx.taskId);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.headline.startsWith("已完成"))).toBe(true);

    // Exit redaction holds even on a clean run: no secret canary anywhere in the timeline text.
    const text = JSON.stringify(events);
    expect(text).not.toContain(CANARY);
  });

  it("INJECTED wormSink (S2 seam): approve routes the SYNTHESIZED AuditEvent to the sink, not the in-memory log", async () => {
    // A RECORDING sink standing in for the live ingest appender (no kernel here). It captures every
    // AuditEvent the composition root synthesizes and returns a plausible AppendReceipt so the
    // commit-before-effect gate sees a durable commit and the effect proceeds.
    const captured: AuditEvent[] = [];
    const recordingSink = (ae: AuditEvent): Promise<AppendReceipt> => {
      captured.push(ae);
      return Promise.resolve({
        sequence: captured.length - 1,
        contentHash: `sha256:${"0".repeat(64)}`,
        prevHash: `sha256:${"0".repeat(64)}`,
        entryHash: `sha256:${"0".repeat(64)}`,
      });
    };

    const shell = createPersonalShell({
      budget: 1000,
      allowToolInvoke: true,
      wormSink: recordingSink,
    });

    const received = shell.receive(LEGAL_TEXT, ctx);
    expect(received.status).toBe("intent");
    if (received.status !== "intent") return;
    const action = received.intent.action;

    const submitted = shell.previewAndSubmit(received.intent);
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") return;

    const decided = await shell.approve(submitted.id);
    expect(decided.status).toBe("executed");

    // The injected sink received EXACTLY ONE synthesized AuditEvent (the root used the sink, not the
    // default in-memory log). Assert the synthesis is correct: action/resource/decision/result + ctx.
    expect(captured.length).toBe(1);
    const ae = captured[0];
    if (ae === undefined) return;
    expect(ae.action).toBe("tool:invoke");
    expect(ae.resource).toBe(`personal:${action}`);
    expect(ae.policyDecision.effect).toBe("allow");
    expect(ae.result).toBe("success");
    expect(ae.actorId).toBe(ctx.actorId);
    expect(ae.tenantId).toBe(ctx.tenantId);
    expect(ae.projectId).toBe(ctx.projectId);
    expect(ae.taskId).toBe(ctx.taskId);
    expect(ae.requestId).toBe(ctx.requestId);

    // With the sink injected, timeline() reads the (empty) in-memory log — live read-back is S3.
    expect((await shell.timeline(ctx.taskId)).length).toBe(0);
  });

  it("INJECTED readEntries (S3b seam): timeline folds the reader's entries, NOT the in-memory log", async () => {
    // A RECORDING reader standing in for the live ListEntries read-back (no kernel here). It returns
    // two synthetic LogEntries; the shell never appended to its own in-memory log, so if timeline()
    // folds these two, the seam is proven to read the INJECTED reader (not the in-memory sharedLog).
    const synth = (sequence: number): LogEntry => ({
      sequence,
      event: createAuditEvent({
        actorId: ctx.actorId,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        requestId: ctx.requestId,
        action: "tool:invoke",
        resource: `personal:backup-${sequence}`,
        policyDecision: { effect: "allow", reason: "ok" },
        result: "success",
      }),
      prevHash: `sha256:${"0".repeat(64)}`,
      entryHash: `sha256:${String(sequence).repeat(64).slice(0, 64)}`,
    });
    const injected: readonly LogEntry[] = [synth(0), synth(1)];
    let reads = 0;
    const readEntries = (): Promise<readonly LogEntry[]> => {
      reads++;
      return Promise.resolve(injected);
    };

    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: true, readEntries });

    // No approve() ran -> the in-memory sharedLog is EMPTY. Any folded event came from the reader.
    const events = await shell.timeline(ctx.taskId);
    expect(reads).toBe(1);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    expect(events.every((e) => e.headline.startsWith("已完成"))).toBe(true);
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
    const events = await shell.timeline(ctx.taskId);
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
    expect((await shell.timeline(ctx.taskId)).length).toBe(0);
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
    expect((await shell.timeline(ctx.taskId)).length).toBe(0);
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
    expect((await shell.timeline(ctx.taskId)).length).toBe(1);
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
