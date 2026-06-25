/**
 * createPersonalShell — the Personal-vertical COMPOSITION ROOT (SLICE-P2R-PV-S1).
 *
 * This is the first place the already-built Personal-surface modules are wired into one runnable,
 * end-to-end spine — `文字 → 澄清 → 白話計畫 → 核可 → 治理管線 → effect → 時間軸` — over a PURELY
 * in-memory backbone (no kernel process, no docker, no vendor). It changes no existing module; it
 * only COMPOSES their public barrels by dependency injection (same DI pattern as P2-I / commitgate).
 *
 *   receive(text, ctx)            -> ReceiveOutcome      (personal/intent `receiveText`)
 *   clarify(text, ctx)/answer(..) -> ClarifyStep         (personal/intent `startClarify`/`answerClarify`)
 *   preview(intent)               -> PlanPreview         (personal/plan `renderPlanPreview`)
 *   previewAndSubmit(intent)      -> SubmitOutcome        (build a GovernedCall + inbox.submit)
 *   approve(id)                   -> DecideOutcome        (inbox.approve -> runGovernedToolCall)
 *   timeline(taskId?)             -> TimelineEvent[]      (buildTaskTimeline over the SHARED WORM)
 *
 * ── THE CRITICAL SEAM (INDEX §2) ──────────────────────────────────────────────────────────────────
 * The pipeline's injected appender is handed a STRUCTURAL event `{kind,tool,context,decisionReason}`
 * and the timeline reads a FULL `AuditEvent` off `LogEntry.event`. So the appender here is NOT the
 * `okAppender` (which returns only `{sequence}` and the timeline cannot read). Instead it SYNTHESIZES a
 * real `AuditEvent` via `createAuditEvent(...)` from the structural event's `context`/`tool`/reason,
 * APPENDS it to a SHARED `InMemoryAppendOnlyLog`, and returns that `AppendReceipt`. `timeline()` then
 * folds the SAME shared log's `entries()`. This is the only way "what the appender wrote" equals
 * "what the timeline reads".
 *
 * Low coupling: imports cross-module ONLY through public barrels (orchestration / cost / audit /
 * runtime-substrate / runtime-brain / policy / personal-{intent,plan,approval,timeline}); `iam/ids` is
 * the existing interim pre-barrel exception. Names no vendor.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  type AppendReceipt,
  type AuditEvent,
  InMemoryAppendOnlyLog,
  type LogEntry,
  createAuditEvent,
  redactSecrets,
} from "../audit/index.js";
import type { CommitAppender } from "../commitgate/index.js";
import { type CostGate, InMemoryCostGate, failClosedCostGate } from "../cost/index.js";
import type { AgentContext } from "../iam/ids.js";
import {
  type GovernedCall,
  type GovernedToolCallDeps,
  runGovernedToolCall,
} from "../orchestration/index.js";
import {
  type AllowRule,
  type PolicyRequest,
  type SecondaryPolicyAdapter,
  combineDecisions,
  evaluatePolicy,
  evaluateSecondaries,
} from "../policy/index.js";
import { type SecretDetector, screenBrainEvent } from "../runtime/brain/index.js";
import { type AdapterResult, FakeSandboxAdapter } from "../runtime/substrate/index.js";
import { type ToolRegistry, authorizeToolInvoke } from "../tools/index.js";
import { ApprovalInbox, type DecideOutcome, type SubmitOutcome } from "./approval/index.js";
import {
  type ClarifyStep,
  type ReceiveOutcome,
  type StructuredIntent,
  answerClarify,
  receiveText,
  startClarify,
} from "./intent/index.js";
import { type PlanPreview, renderPlanPreview } from "./plan/index.js";
import { type TimelineEvent, buildTaskTimeline } from "./timeline/index.js";

/** A GovernedCall enriched with the intent payload the screen guard inspects for secret egress. */
export interface PersonalToolCall extends GovernedCall {
  readonly tool: string;
  readonly context: AgentContext;
  /** Carries the intent's targets so the credential screen can catch a secret that slipped a target. */
  readonly args: Record<string, unknown>;
}

/** Options for the in-memory Personal shell. Defaults give a runnable happy-path backbone. */
export interface PersonalShellOpts {
  /** Token budget for the in-memory CostGate. */
  readonly budget?: number;
  /** Inject the `allow tool:invoke` rule (true) or run with an empty allow set -> denied@policy. */
  readonly allowToolInvoke?: boolean;
  /** Fixed token estimate per call (mirrors the pipeline.e2e `() => 10`). */
  readonly estimateTokens?: number;
  /**
   * The WORM write-sink the synthesized `AuditEvent` is committed to (SLICE-P2R-PV-S2). Injecting the
   * REAL grpc-js ingest appender (`createIngestAppender(...).append`) makes the Personal governed event
   * land in the running Go kernel's WORM. ABSENT => the S1-identical default: write the shared in-memory
   * `InMemoryAppendOnlyLog` (which `timeline()` reads by default).
   */
  readonly wormSink?: (event: AuditEvent) => Promise<AppendReceipt>;
  /**
   * The WORM read-back source `timeline()` reconstructs from (SLICE-P2R-PV-S3b; mirrors `wormSink`).
   * Injecting the REAL `ListEntries` reader (`createEntriesReader({endpoint})`) makes `timeline()`
   * read back the live Go kernel's WORM over a real RPC — so "the WORM we WROTE == the WORM we READ".
   * ABSENT => the S1/S2-identical default: read the shared in-memory `InMemoryAppendOnlyLog`
   * (byte-identical to S1/S2 behavior, only awaited). FAIL-CLOSED is the reader's own contract: a real
   * read failure rejects, so `timeline()` rejects rather than returning a partial/empty reconstruction.
   */
  readonly readEntries?: () => Promise<readonly LogEntry[]>;
  /**
   * SLICE-DVx — an INJECTABLE, developer-registered tool catalog. When provided, the authorize seam
   * gains a registry deny-by-default PRE-SCREEN in front of the EXISTING `personal:*` PDP: a
   * `tool:invoke` whose tool name is NOT in this registry is denied@authorize (deny-by-default), and a
   * REGISTERED tool is delegated to the SAME `personal:*` PDP as today (`authorizeToolInvoke(req,
   * toolRegistry, allow)`). The registry can ONLY deny more — it NEVER grants (the PDP remains the sole
   * grant authority). ABSENT => BYTE-IDENTICAL to today: authorize is `evaluatePolicy(req, allow)`
   * (the S1 hardcoded path), so the existing bootstrap.e2e stays green unchanged. This is the Personal
   * half of the three-surface UNIFIED registry-backed admission (Developer already does this; DVx adds
   * the SAME deny-by-default to Personal + Enterprise behind an optional opt).
   */
  readonly toolRegistry?: ToolRegistry;
  /**
   * SLICE-IT1a — an INJECTABLE, vendor-neutral CostGate (the spend slot). ABSENT (the default) => the
   * S1-identical `new InMemoryCostGate(budget)` (byte-identical to today). When provided (e.g. a
   * config-driven SpendGuardCostGate wired by IT1b), the governed pipeline reserves against THIS gate
   * instead — and the injection can ONLY NARROW: a CostGate's `reserve` can DENY (deny@cost), it never
   * grants more budget than the gate allows. The surface depends ONLY on the vendor-neutral `CostGate`
   * PORT type here — never a vendor adapter (SpendGuard/AGT).
   */
  readonly costGate?: CostGate;
  /**
   * SLICE-IT1a — INJECTABLE, vendor-neutral ADVISORY secondary policy adapters (e.g. AGT). ABSENT (the
   * default) => `[]` (byte-identical to today: `combineDecisions(decision, [])`). When provided, every
   * adapter is folded into the decision via `combineDecisions(decision, opts.secondaries)`: PDP is the
   * SOLE deny authority and the merge is any-deny-wins / fail-closed (a malformed/throwing advisory =
   * deny), so a secondary can ONLY NARROW — it can NEVER grant/relax what the PDP denied. The surface
   * depends ONLY on the vendor-neutral `SecondaryPolicyAdapter` PORT type — never a vendor adapter.
   */
  readonly secondaries?: readonly SecondaryPolicyAdapter[];
}

/** The composed Personal-surface facade a human (or a test) can drive end-to-end. */
export interface PersonalShell {
  receive(text: string, ctx: AgentContext): ReceiveOutcome;
  clarify(text: string, ctx: AgentContext): ClarifyStep;
  answer(step: ClarifyStep & { status: "asking" }, answer: string): ClarifyStep;
  preview(intent: StructuredIntent): PlanPreview;
  previewAndSubmit(intent: StructuredIntent): SubmitOutcome;
  approve(id: string): Promise<DecideOutcome<AppendReceipt>>;
  timeline(taskId?: string): Promise<TimelineEvent[]>;
  /** Test probe: is the last sandbox the effect created startable (ok) or was none created (denied)? */
  probeLastSandbox(): Promise<AdapterResult>;
}

/** The repo's real secret detector: redaction-changed-anything ⇒ a secret was present (pipeline.e2e:31). */
const detectSecret: SecretDetector = (v) => JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/**
 * Deterministic `GovernedCall` from a StructuredIntent. The tool string is derived purely from the
 * intent's action (vendor-free, stable); the intent's targets ride in `args` so the credential screen
 * can catch a secret that slipped past rawText validation into a target (defense in depth).
 */
export function buildToolCall(intent: StructuredIntent): PersonalToolCall {
  return {
    tool: `personal:${intent.action}`,
    context: intent.context,
    args: { targets: intent.targets },
  };
}

export function createPersonalShell(opts: PersonalShellOpts = {}): PersonalShell {
  const budget = opts.budget ?? 1000;
  const estimate = opts.estimateTokens ?? 10;
  // The injected allow rule (INDEX §4): `personal:*` matches every `personal:<action>` tool within the
  // segment; absent (allowToolInvoke=false) the allow set is empty -> evaluatePolicy denies@policy.
  const allow: AllowRule[] = opts.allowToolInvoke
    ? [{ id: "pv-s1", action: "tool:invoke", resource: "personal:*" }]
    : [];

  // ── The shared WORM the appender writes and the timeline reads (the critical seam) ──
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const sharedLog = new InMemoryAppendOnlyLog({ publicKey, privateKey });
  const fake = new FakeSandboxAdapter();
  // SLICE-IT1a: the INJECTED CostGate or — ABSENT — the S1-identical `new InMemoryCostGate(budget)`.
  // The injected gate is the spend AUTHORITY for this shell (replacement, like the wormSink seam); the
  // invariant is that a CostGate that DENIES cannot grant the effect — it never relaxes a deny. Wrapped
  // fail-closed so an EXTERNAL gate's thrown reserve/commit/release becomes a structured deny (the
  // in-tree InMemoryCostGate never throws, so the ABSENT path stays byte-identical to today).
  const cost: CostGate = failClosedCostGate(opts.costGate ?? new InMemoryCostGate(budget));

  // The structural event the pipeline hands the appender (pipeline.ts:79-84).
  interface StructuralEvent {
    readonly kind: string;
    readonly tool: string;
    readonly context: unknown;
    readonly decisionReason: string;
  }

  // The S1-identical default WORM sink: append the synthesized AuditEvent to the shared in-memory log
  // that `timeline()` reads. With NO `opts.wormSink`, behavior is byte-identical to S1.
  const defaultInMemorySink = (ae: AuditEvent): Promise<AppendReceipt> =>
    Promise.resolve(sharedLog.append(ae));

  // The S1/S2-identical default WORM reader: read the shared in-memory log `timeline()` folds. With NO
  // `opts.readEntries`, the reconstruction is byte-identical to S1/S2 (the same `sharedLog.entries()`),
  // only awaited. An injected reader (`createEntriesReader`) instead reads back the live kernel WORM.
  const defaultInMemoryReader = (): Promise<readonly LogEntry[]> =>
    Promise.resolve(sharedLog.entries() as LogEntry[]);

  /**
   * The seam appender: synthesize a REAL AuditEvent from the structural event, then COMMIT it to the
   * injectable WORM sink (SLICE-P2R-PV-S2). `result:"success"` + `policyDecision.effect:"allow"` because
   * the pipeline only commits AFTER screen+PDP+cost pass — the append marks the committed (about-to-run)
   * effect, which the timeline then renders as 「已完成」. The AuditEvent SYNTHESIS is unchanged from S1
   * and stays the single source here; only the FINAL write is routed through `opts.wormSink` (the live
   * Go-kernel ingest appender) or, by default, the shared in-memory log.
   */
  const appender: CommitAppender<StructuralEvent, AppendReceipt> = {
    append: (event) => {
      const ctx = event.context as AgentContext;
      const auditEvent = createAuditEvent({
        actorId: ctx.actorId,
        tenantId: ctx.tenantId,
        projectId: ctx.projectId,
        taskId: ctx.taskId,
        requestId: ctx.requestId,
        sandboxId: ctx.sandboxId,
        action: "tool:invoke",
        resource: event.tool,
        policyDecision: { effect: "allow", reason: event.decisionReason },
        result: "success",
      });
      return (opts.wormSink ?? defaultInMemorySink)(auditEvent);
    },
  };

  // The id the FakeSandbox created during the last effect (for the test probe). undefined => the
  // effect never ran (a gate short-circuited) so there is no sandbox to start.
  let lastSandboxId: string | undefined;

  // The five injected ports (pipeline.e2e makeDeps template, but with the SEAM appender above).
  const deps: GovernedToolCallDeps<PersonalToolCall, AppendReceipt> = {
    screen: (tc) => {
      // screenBrainEvent only forwards the value to the detector + reads status; the structural call
      // is a superset of what it inspects, so a secret anywhere in tool/context/args is caught.
      const r = screenBrainEvent(tc as never, detectSecret);
      return r.status === "ok" ? { ok: true as const } : { ok: false as const, reason: r.reason };
    },
    authorize: async (tc) => {
      const req = { ...tc.context, action: "tool:invoke", resource: tc.tool } as PolicyRequest;
      // SLICE-DVx: with an injected registry, the registry deny-by-default runs IN FRONT of the
      // EXISTING `personal:*` PDP (`authorizeToolInvoke` = deny-by-default pre-screen -> evaluatePolicy);
      // an UNREGISTERED tool is denied before the PDP. WITHOUT a registry, this is BYTE-IDENTICAL to S1:
      // `evaluatePolicy(req, allow)`. Either branch is folded through `combineDecisions(_, [])` exactly
      // as before, so the seam shape (effect/reason) is unchanged.
      const decision = opts.toolRegistry
        ? authorizeToolInvoke(req, opts.toolRegistry, allow)
        : evaluatePolicy(req, allow);
      // SLICE-IT1a: evaluate the INJECTED advisory secondaries fail-closed (a throwing/rejecting adapter
      // -> a synthetic deny), then fold them into the decision. ABSENT => `[]` adapters -> `[]` decisions,
      // byte-identical to today's `combineDecisions(decision, [])`. combineDecisions is any-deny-wins /
      // PDP-sovereign: a secondary can only deny more — it never grants/relaxes a PDP deny.
      // SLICE-R9a: `evaluateSecondaries` is async (it may await a cross-language advisory), so this
      // closure is `async` and `await`s it; the fold + redact semantics are otherwise unchanged.
      const secondaryDecisions = await evaluateSecondaries(opts.secondaries ?? [], req);
      const combined = combineDecisions(decision, secondaryDecisions);
      // The combined reason folds UNTRUSTED secondary `reason` strings (an external/vendor seam); scrub
      // them before the reason flows into the committed AuditEvent's policyDecision.reason (the appender
      // writes `decisionReason` -> WORM). Mirrors the audit layer's redact-before-sink posture
      // (canonical.ts). On the ABSENT path the reason has no adapter text, so redact is identity.
      return { effect: combined.effect, reason: redactSecrets(combined.reason) };
    },
    cost,
    estimateTokens: () => estimate,
    appender,
    effect: async (tc) => {
      const res = await fake.createSandbox(tc.context, { image: tc.tool });
      lastSandboxId = res.status === "ok" ? res.sandboxId : undefined;
      return { ok: res.status === "ok", detail: res.status };
    },
  };

  // The inbox's injected runner is the SOLE effect entry: approve(id) -> runGovernedToolCall(deps, tc).
  const inbox: ApprovalInbox<PersonalToolCall, AppendReceipt> = new ApprovalInbox(
    (tc: PersonalToolCall) => runGovernedToolCall(deps, tc),
  );

  return {
    receive: (text, ctx) => receiveText(text, ctx),
    clarify: (text, ctx) => startClarify(text, ctx),
    answer: (step, answer) => answerClarify(step, answer),
    preview: (intent) => renderPlanPreview(intent),
    previewAndSubmit: (intent) => inbox.submit(renderPlanPreview(intent), buildToolCall(intent)),
    approve: (id) => inbox.approve(id),
    timeline: async (taskId) => {
      // Read from the injected WORM read-back (live kernel via ListEntries) or, by default, the shared
      // in-memory log — then fold to plain-language events. A reader reject (fail-closed) propagates.
      const entries = await (opts.readEntries ?? defaultInMemoryReader)();
      return buildTaskTimeline(entries, { taskId, redact: redactSecrets });
    },
    probeLastSandbox: async () => {
      if (lastSandboxId === undefined) {
        // Surface the "no effect ran" case as a denied transition (no sandbox to start).
        return fake.startSandbox(
          { actorId: "x", tenantId: "x", projectId: "x", taskId: "x", requestId: "x" },
          "sbx-none",
        );
      }
      return fake.startSandbox(
        // Identity is re-validated by the adapter; reuse a minimal valid context shape.
        { actorId: "agent:probe", tenantId: "t", projectId: "p", taskId: "t", requestId: "r" },
        lastSandboxId,
      );
    },
  };
}
