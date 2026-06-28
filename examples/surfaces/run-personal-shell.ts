/**
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 *  REFERENCE COMPOSITION ROOT — the PERSONAL surface.
 *
 *  This is the canonical "run a surface" entry point for the Personal vertical. COPY THIS FILE and
 *  replace the in-memory seams with your real adapters for production. Out of the box it composes the
 *  already-built Personal-surface modules into ONE runnable, end-to-end governed spine over a PURELY
 *  in-memory backbone — NO kernel process, NO docker, NO vendor, NO network, NO filesystem, ZERO
 *  external deps. It demonstrates a REAL governed outcome:
 *
 *      文字 (receive) → 白話計畫 (preview) → 核可佇列 (previewAndSubmit) → 核可 (approve)
 *        → 治理管線 (screen → PDP → cost → commit-before-effect → effect) → 時間軸 (timeline)
 *
 *  ── ADOPTER SEAMS (what to replace for production) ────────────────────────────────────────────────
 *    • allowToolInvoke  : here `true` injects the `personal:*` allow rule. PRODUCTION: drive your real
 *                         policy allow-set (an empty set => the PDP denies@policy — deny-by-default).
 *    • wormSink         : DEFAULT = a shared in-memory `InMemoryAppendOnlyLog`. PRODUCTION: inject the
 *                         real WORM ingest appender (`createIngestAppender(...).append`) so the governed
 *                         AuditEvent lands in the running kernel's WORM.
 *    • readEntries      : DEFAULT = read back that same in-memory log. PRODUCTION: inject the real
 *                         `ListEntries` reader so `timeline()` reconstructs from the live kernel WORM.
 *    • costGate         : DEFAULT = `InMemoryCostGate`. PRODUCTION: inject your real spend gate.
 *    • sandbox          : the effect uses the in-tree `FakeSandboxAdapter` (composed inside the factory).
 *                         PRODUCTION: the real substrate adapter is wired the same DI way inside the root.
 *    • toolRegistry /
 *      secondaries      : optional deny-only admission / advisory adapters — add for production gating.
 *
 *  HONEST SCOPE: every seam below is a FAKE. The example shows the WIRING (the composition); production
 *  swaps the fakes for real adapters across the SAME honest, deploy-gated boundary — the contract shape
 *  (the injected ports) does not change.
 * ════════════════════════════════════════════════════════════════════════════════════════════════════
 */
import {
  StructuredIntent,
  type TimelineEvent,
  createPersonalShell,
} from "../../dist/personal/index.js";

/** The concise, credential-blind governed-outcome summary `main()` prints and the test asserts on. */
export interface PersonalRunSummary {
  readonly surface: "personal";
  /** The governed decision for the approved call: "executed" (effect ran) or "denied" (a gate refused). */
  readonly decision: string;
  /** Number of WORM-backed timeline events read back after approval. */
  readonly timelineEventCount: number;
  /** Whether the timeline carries a completed (已完成) governed event — the effect committed. */
  readonly completed: boolean;
  /** The headline of the first governed timeline event (plain-language, redacted). */
  readonly headline: string | undefined;
  /** True when this root used ONLY in-memory defaults (no external sink/reader/registry/gate). */
  readonly usedInMemoryDefaults: true;
}

/**
 * Run the Personal reference composition root end-to-end and return a governed-outcome summary.
 * Exported so the acceptance test drives the SAME flow `main()` runs (no duplicate wiring).
 */
export async function runExample(): Promise<PersonalRunSummary> {
  // ── THE COMPOSITION ROOT ── in-memory defaults; `allowToolInvoke` injects the `personal:*` allow rule.
  const shell = createPersonalShell({ allowToolInvoke: true });

  // A real AgentContext (parsed/validated by the surface's own schema — never hand-rolled).
  const ctx = StructuredIntent.shape.context.parse({
    actorId: "agent:demo",
    tenantId: "tenant-demo",
    projectId: "proj-demo",
    taskId: "task-demo",
    requestId: "req-demo",
  });

  // 1. 文字 → 結構意圖: a clean, parseable benign request the deterministic gateway resolves.
  const received = shell.receive("backup notes archive", ctx);
  if (received.status !== "intent") {
    throw new Error(`personal: expected an intent, got status=${received.status}`);
  }

  // 2. 白話計畫: render the human-readable plan preview (what would happen before any commitment).
  //    Demonstrates the preview seam; not load-bearing for the outcome (previewAndSubmit re-renders it).
  void shell.preview(received.intent);

  // 3. 核可佇列: build the GovernedCall + queue it (returns a pending id awaiting approval).
  const submitted = shell.previewAndSubmit(received.intent);
  if (submitted.status !== "pending") {
    throw new Error(`personal: expected pending submission, got status=${submitted.status}`);
  }

  // 4. 核可 → 治理管線 → effect: approve drives the SOLE governed entry (screen→PDP→cost→commit→effect).
  const decided = await shell.approve(submitted.id);
  const decision = decided.status; // "executed" on the happy path; "denied" if any gate refused.

  // 5. 時間軸: read back the WORM-backed governed events (the same shared log the appender wrote into).
  const events: TimelineEvent[] = await shell.timeline(ctx.taskId);
  const completed = events.some((e) => e.headline.startsWith("已完成"));

  return {
    surface: "personal",
    decision,
    timelineEventCount: events.length,
    completed,
    headline: events[0]?.headline,
    usedInMemoryDefaults: true,
  };
}

/** Standalone run: `node examples/surfaces/run-personal-shell.ts` (after `pnpm build`). */
async function main(): Promise<void> {
  const s = await runExample();
  // Credential-blind by construction: only neutral governed fields are printed (no secrets, no args).
  console.log("[personal] governed outcome:", JSON.stringify(s, null, 2));
  if (s.decision !== "executed" || !s.completed) {
    console.error("[personal] FAILED: expected an executed + completed governed outcome");
    process.exit(1);
  }
  console.log(
    "[personal] OK — executed governed outcome with a WORM-backed 已完成 timeline event.",
  );
}

// import.meta-guarded run: executes only when this file is the entrypoint, never when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
