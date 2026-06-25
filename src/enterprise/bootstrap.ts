/**
 * createEnterpriseFleet — the Enterprise-vertical COMPOSITION ROOT (SLICE-ES1).
 *
 * This is the first place the R8 isolation primitives (TenantRouter / InMemoryTenantStore /
 * ConsoleProjection) are wired into ONE runnable, multi-tenant governed fleet over a PURELY in-memory
 * backbone (no kernel process, no docker, no vendor): a gateway-per-tenant spine
 *   `route(ctx) → per-tenant governed pipeline (screen→PDP→cost→commit-before-effect→effect)
 *               → per-tenant WORM → operator console/timeline`.
 * It changes no existing module; it only COMPOSES their public barrels by dependency injection (same
 * DI pattern as `createPersonalShell`, `src/personal/bootstrap.ts:129`).
 *
 * ── THE TENANT-SEALED INVARIANT (INDEX §3) ─────────────────────────────────────────────────────────
 * Per-tenant state is INDEPENDENT, closure-bound INSTANCES — NEVER "one shared instance + a tenantId
 * parameter". Concretely, per registered tenant we build a SEPARATE `InMemoryCostGate`, a SEPARATE
 * `InMemoryAppendOnlyLog` (held in a `Map<partitionId, InMemoryAppendOnlyLog>` — one INDEPENDENT log
 * per partition), and a SEPARATE `ApprovalInbox`. The pipeline deps for tenant-T close over T's
 * binding/cost/log; the inbox runner for T is `(tc) => runGovernedToolCall(perTenantDeps(bindingT), tc)`.
 * A caller holding tenant-A's facade has no argument by which to name tenant-B, so cross-tenant
 * read/write/approve is structurally impossible. Collapsing any of these to a single shared instance
 * (e.g. one shared log) would make tenant-A's approve→WORM→timeline leak into tenant-B — exactly what
 * the combined-whole e2e (`bootstrap.e2e.cross-tenant.test.ts`) flips RED.
 *
 * ── THE CRITICAL SEAM (mirrors Personal) ───────────────────────────────────────────────────────────
 * The pipeline hands the appender a STRUCTURAL event `{kind,tool,context,decisionReason}`. The seam
 * appender SYNTHESIZES a real `AuditEvent` via `createAuditEvent(...)`, appends it to THIS partition's
 * `InMemoryAppendOnlyLog` (the WORM), and ALSO writes a console-projectable `event:<seq>` entry
 * `{seq,summary}` into THIS tenant's `TenantScopedRepo`. `console(ctx).timeline()` reads that same
 * per-tenant repo (projecting `event:`-prefixed keys), so "what the appender wrote" == "what the
 * console reads" — per tenant, never crossing.
 *
 * Low coupling: imports cross-module ONLY through public barrels (tenant / orchestration / cost /
 * policy / audit / runtime-brain / runtime-substrate / personal-approval); `iam/ids` is the existing
 * interim pre-barrel exception (type-only here). Names no vendor.
 */
import { generateKeyPairSync } from "node:crypto";
import {
  type AppendReceipt,
  type AuditEvent,
  InMemoryAppendOnlyLog,
  createAuditEvent,
  redactSecrets,
} from "../audit/index.js";
import { type CommitAppender, commitBeforeEffect } from "../commitgate/index.js";
import {
  type CostGate,
  InMemoryCostGate,
  NullCostGate,
  failClosedCostGate,
} from "../cost/index.js";
import type { AgentContext } from "../iam/ids.js";
import {
  type GovernedCall,
  type GovernedToolCallDeps,
  runGovernedToolCall,
} from "../orchestration/index.js";
import {
  ApprovalInbox,
  type DecideOutcome,
  type SubmitOutcome,
} from "../personal/approval/index.js";
import {
  type AllowRule,
  type PolicyRequest,
  type SecondaryPolicyAdapter,
  combineDecisions,
  evaluatePolicy,
  evaluateSecondaries,
} from "../policy/index.js";
import { type SecretDetector, screenBrainEvent } from "../runtime/brain/index.js";
import { FakeSandboxAdapter } from "../runtime/substrate/index.js";
import {
  type CheckerCapability,
  ConsoleProjection,
  InMemoryTenantStore,
  type RouteResult,
  type TenantBinding,
  type TenantConsole,
  TenantRouter,
  enforceMakerChecker,
} from "../tenant/index.js";
import { type ToolRegistry, authorizeToolInvoke } from "../tools/index.js";

/** Options for the in-memory Enterprise fleet. `tenants` are pre-registered at construction (ES1). */
export interface EnterpriseFleetOpts {
  /**
   * The tenants pre-provisioned into the router + store at construction (the static ES1 path). Dynamic
   * runtime onboarding/offboarding is now `registerTenant` / `deprovisionTenant` (SLICE-ES4); both the
   * static loop and the dynamic ops share the SAME `provisionTenant` step (byte-identical provisioning).
   */
  readonly tenants: readonly string[];
  /** Per-tenant token budget for each tenant's independent InMemoryCostGate. */
  readonly budgetPerTenant?: number;
  /**
   * Inject the per-tenant `allow tool:invoke` rule (true) or run with an empty allow set for that
   * tenant -> denied@policy. Defaults to allow-all-tenants. The rule's tenantId === the tenant's id,
   * so even if mis-wired it cannot grant another tenant (policy/evaluate.ts:42-45).
   */
  readonly allowToolInvokePerTenant?: (tenantId: string) => boolean;
  /** Fixed token estimate per call (mirrors the pipeline.e2e `() => 10`). */
  readonly estimateTokens?: number;
  /**
   * TEST FAULT INJECTION ONLY (SLICE-ES3 commit-before-effect proof). When this returns true for a
   * tenant, that tenant's OPERATOR WORM appender REJECTS its append — exercising the fail-closed
   * guarantee that `commitBeforeEffect` refuses the effect when no durable receipt is in hand. Defaults
   * to never-fault, so ES1's submit/approve path and production behaviour are untouched.
   */
  readonly failWormAppendFor?: (tenantId: string) => boolean;
  /**
   * Per-tenant LIVE WORM sink injection (SLICE-ES2b — the Enterprise analogue of Personal's
   * `opts.wormSink`). Given a tenant's `TenantBinding`, return the sink its governed (and operator)
   * AuditEvents are committed to. Injecting `createPartitionedIngestSink(transport, binding)` makes a
   * tenant's events land in the REAL Go kernel's INDEPENDENT per-tenant WORM partition (its own chain
   * head + Ed25519 key, routed by `binding.partitionId`).
   *
   * ABSENT (the default) => BYTE-IDENTICAL to ES1: each tenant's WORM is the per-tenant in-memory
   * `InMemoryAppendOnlyLog` and `wormLogFor` returns it (the ES1 cross-tenant e2e + the ES3 operator
   * e2e construct the fleet with NO wormSinkFor, so they stay green unchanged). The closure binds ONE
   * binding, so the resulting sink can only ever write THAT tenant.
   */
  readonly wormSinkFor?: (binding: TenantBinding) => (event: AuditEvent) => Promise<AppendReceipt>;
  /**
   * SLICE-DVx — a PLATFORM-WIDE, developer-registered tool catalog shared by EVERY tenant's authorize.
   * When provided, each tenant's per-tenant authorize gains a registry deny-by-default PRE-SCREEN in
   * front of the EXISTING per-tenant `fleet:*` PDP: a `tool:invoke` whose tool name is NOT in this
   * registry is denied@authorize (deny-by-default), and a REGISTERED tool is delegated to the SAME
   * per-tenant PDP as today (`authorizeToolInvoke(req, toolRegistry, perTenantAllow)`). The registry can
   * ONLY deny more — it NEVER grants. It is a platform-level admission gate ONLY: it does NOT touch
   * routing, per-tenant WORM, per-tenant inboxes, or the per-tenant allow rules — TENANT ISOLATION is
   * unchanged (`verify:cross-tenant` stays green). ABSENT => BYTE-IDENTICAL to ES1/ES3: per-tenant
   * authorize is `evaluatePolicy(req, allow)` (the existing path), so the ES1 cross-tenant + ES3
   * operator e2e stay green unchanged.
   */
  readonly toolRegistry?: ToolRegistry;
  /**
   * SLICE-IT1a — an INJECTABLE, vendor-neutral PER-TENANT CostGate FACTORY (the spend slot). Called
   * ONCE per tenant at provisioning with that tenant's id; it returns the gate THAT tenant's pipeline
   * reserves against. ABSENT (the default) => each tenant gets its OWN `new InMemoryCostGate(budget)`
   * (byte-identical to ES1). PER-TENANT ISOLATION is LOAD-BEARING: the factory builds an INDEPENDENT
   * gate per tenant (e.g. a SpendGuardCostGate scoped to tenant-A's budget claim is NEVER tenant-B's),
   * so A exhausting/denying never affects B. The injection can ONLY NARROW: a CostGate's `reserve` can
   * DENY (deny@cost), it never grants more budget. Depends ONLY on the vendor-neutral `CostGate` PORT
   * type — never a vendor adapter (SpendGuard/AGT).
   */
  readonly costGateFor?: (tenantId: string) => CostGate;
  /**
   * SLICE-IT1a — INJECTABLE, vendor-neutral ADVISORY secondary policy adapters (e.g. AGT), SHARED
   * across every tenant's per-tenant authorize (the approved default: fleet-wide advisory). ABSENT (the
   * default) => `[]` (byte-identical to ES1: `combineDecisions(decision, [])`). When provided, every
   * tenant's per-tenant authorize folds them via `combineDecisions(decision, opts.secondaries)`: each
   * tenant's PDP is the SOLE deny authority and the merge is any-deny-wins / fail-closed, so a secondary
   * can ONLY NARROW — it never grants/relaxes a per-tenant deny, and (being a deny-only advisory) it
   * does NOT change routing or cross-tenant isolation. Depends ONLY on the vendor-neutral
   * `SecondaryPolicyAdapter` PORT type — never a vendor adapter.
   */
  readonly secondaries?: readonly SecondaryPolicyAdapter[];
}

/** A console resolved for a routed tenant, or a deny when the ctx does not route (fail-closed). */
export type ConsoleResult = { ok: true; console: TenantConsole } | { ok: false; reason: string };

/**
 * SLICE-ES4 — the result of a dynamic tenant lifecycle op (`registerTenant` / `deprovisionTenant`).
 * `ok` => the fleet mutated (a tenant was onboarded / offboarded). `denied` => fail-closed: the op was
 * REFUSED before any mutation (malformed/empty tenantId, a duplicate register, or an unknown tenant on
 * deprovision). `reason` is STATIC (an error code) — never an interpolated tenantId (credential-blind).
 */
export type LifecycleResult = { status: "ok" } | { status: "denied"; reason: string };

/** A privileged operator action: `kind` names the action, `resource` its target (e.g. `agent:<id>`). */
export interface OperatorAction {
  readonly kind: string;
  readonly resource: string;
}

/**
 * The result of `operatorAction` (mirrors the existing facade result shape): on `ok` the operator
 * AuditEvent committed to the tenant's WORM and the effect ran; on `denied` the gate refused — route
 * fail-closed, a maker-checker deny, or a commit failure — and the effect did NOT run. The `event` is
 * the STRUCTURAL operator event handed to the WORM seam (NOT the synthesized AuditEvent). `reason` on a
 * deny is STATIC (an error code / route reason) — never an interpolated `cap`/`ctx` value (credential-blind).
 */
export type OperatorResult =
  | { status: "ok"; event: OperatorEvent }
  | { status: "denied"; reason: string; event: OperatorEvent };

/** The structural event the operator seam appender synthesizes a real AuditEvent from (mirrors StructuralEvent). */
export interface OperatorEvent {
  readonly kind: string;
  readonly resource: string;
  readonly context: unknown;
  readonly decisionReason: string;
}

/** The composed Enterprise-surface facade a fleet operator (or a test) drives end-to-end. */
export interface EnterpriseFleet {
  /** Gateway route boundary: resolve an untrusted ctx to its own tenant's binding (fail-closed). */
  route(ctx: unknown): RouteResult;
  /** Route FIRST, then queue the call in THAT tenant's inbox. Unrouted/unknown tenant -> denied. */
  submitForApproval(ctx: unknown, call: GovernedCall): SubmitOutcome;
  /** Route FIRST, then approve in THAT tenant's inbox (the SOLE governed-pipeline entry). */
  approve(ctx: unknown, id: string): Promise<DecideOutcome<AppendReceipt>>;
  /** Route FIRST, then return THAT tenant's read-only console (fleet()/timeline()). */
  console(ctx: unknown): ConsoleResult;
  /**
   * Privileged operator action端 (SLICE-ES3): route(ctx) → enforceMakerChecker(ctx, action, cap) deny
   * short-circuit → commitBeforeEffect(append operator AuditEvent → THAT tenant's WORM, await receipt,
   * THEN run the tenant-scoped effect). ES3 delivers `suspend-agent` (resource `agent:<sandboxId>`):
   * the effect writes that tenant's repo `agent:<sandboxId>` phase="suspended", observable via
   * `console(ctx).fleet()`. Unrouted/unknown tenant, a maker-checker deny, or a commit failure all
   * fail-closed (denied; effect NOT run).
   */
  operatorAction(
    ctx: unknown,
    action: OperatorAction,
    cap: CheckerCapability,
  ): Promise<OperatorResult>;
  /**
   * Test/inspection probe: the WORM log INSTANCE bound to the routed tenant (undefined if unrouted).
   * Exposes the per-tenant-independence invariant to the combined-whole test (A's log !== B's log).
   */
  wormLogFor(ctx: unknown): InMemoryAppendOnlyLog | undefined;
  /**
   * SLICE-ES4 — onboard a tenant at RUNTIME (dynamic, in-memory). Fail-closed validate FIRST (empty /
   * whitespace tenantId => denied; already-registered => denied — no mutation), then provision the
   * tenant's INDEPENDENT deps (binding, WORM log/sink, CostGate, inbox), ADDITIVELY register its
   * partition in the SAME store, and IMMUTABLY REBUILD the TenantRouter so its no-mutation-API
   * structural isolation is preserved. `registerTenant` is a fleet-admin op; operator authorization for
   * it is deferred (P4) — no ctx is taken.
   */
  registerTenant(tenantId: string): LifecycleResult;
  /**
   * SLICE-ES4 — offboard a tenant at RUNTIME. Fail-closed validate FIRST (not-registered => denied),
   * then remove the binding and IMMUTABLY REBUILD the router so `route(ctx)` for that tenant now
   * fail-closed denies (and submit/approve/operatorAction/console with it). The tenant's append-only
   * WORM log is NOT erased (deprovision revokes routing/action capability, it does NOT delete history;
   * by design) — it simply becomes unreachable via `route`.
   */
  deprovisionTenant(tenantId: string): LifecycleResult;
}

/** The repo's real secret detector: redaction-changed-anything ⇒ a secret was present (pipeline.e2e:31). */
const detectSecret: SecretDetector = (v) => JSON.stringify(redactSecrets(v)) !== JSON.stringify(v);

/**
 * The repo key prefix ConsoleProjection.fleet() projects into {sandboxId, agentName, phase}
 * (projection.ts:27,94). MUST stay byte-for-byte identical so the suspend-agent effect's repo entry
 * surfaces in `console(ctx).fleet()`.
 */
const AGENT_PREFIX = "agent:";

/** The structural event the pipeline hands the appender (pipeline.ts:79-84). */
interface StructuralEvent {
  readonly kind: string;
  readonly tool: string;
  readonly context: unknown;
  readonly decisionReason: string;
}

export function createEnterpriseFleet(opts: EnterpriseFleetOpts): EnterpriseFleet {
  const budget = opts.budgetPerTenant ?? 1000;
  const estimate = opts.estimateTokens ?? 10;
  const allowToolInvoke = opts.allowToolInvokePerTenant ?? (() => true);
  // Defaults to never-fault: ES1's path and production behaviour are untouched (ES3 test hook only).
  const failWormAppendFor = opts.failWormAppendFor ?? (() => false);

  // ── ONE store, ONE console projection over per-tenant partitions; the router is REBUILT per
  //    register/deprovision (ES4) so its no-mutation-API structural isolation is always preserved ──
  // Per tenant: binding{tenantId, partitionId: partition-${tenantId}, storeRef: store-${tenantId}}.
  // The `bindings` Map is the fleet's mutable registry of who-is-onboarded; the ROUTER is a defensive
  // immutable snapshot of it (TenantRouter copies on construction). `store` is the SINGLE concrete
  // InMemoryTenantStore instance for the whole fleet lifetime — register() ADDS a partition IN PLACE
  // (never rebuilt; rebuilding would lose existing tenants' data). The ConsoleProjection holds THIS
  // store, so a newly-registered partition is immediately visible through `console(ctx)`.
  const bindings = new Map<string, TenantBinding>();
  // The store starts EMPTY; the per-tenant provisioning loop below (and registerTenant) populate it
  // via store.register — one code path for static AND dynamic onboarding (byte-identical provisioning).
  const store = new InMemoryTenantStore(new Set<string>());
  const projection = new ConsoleProjection(store);
  // `router` is a `let`: registerTenant/deprovisionTenant reassign it to a fresh TenantRouter built
  // from the current `bindings` (IMMUTABLE REBUILD). The facade closures below read THIS `router`
  // binding, so they always route against the latest snapshot.
  let router = new TenantRouter(bindings);

  // ── PER-TENANT INDEPENDENT INSTANCES (the load-bearing isolation; NOT shared + param) ──
  // One INDEPENDENT WORM log per partition. NEVER one shared log: a shared log would make
  // tenant-A's committed events visible to tenant-B's timeline (INDEX §3 the shared-log trap).
  const wormByPartition = new Map<string, InMemoryAppendOnlyLog>();
  // The per-tenant WORM SINK the seam appenders commit to (SLICE-ES2b). With NO `opts.wormSinkFor` this
  // is the per-tenant in-memory `log.append` (byte-identical to ES1/ES3); with it, the INJECTED live
  // partitioned-kernel sink. Keyed by tenantId; resolved once below (closure-bound per tenant).
  const wormSinkByTenant = new Map<string, (event: AuditEvent) => Promise<AppendReceipt>>();
  // One INDEPENDENT CostGate per tenant (keyed by tenantId): A exhausting its budget never affects B.
  const costByTenant = new Map<string, CostGate>();
  // One INDEPENDENT ApprovalInbox per tenant: B's inbox literally has no record of an A-issued id,
  // so approve(ctxB, A_id) is deny-by-default (unknown id) — not a permission check that could be
  // mis-scoped, but a structural miss.
  const inboxByTenant = new Map<string, ApprovalInbox<GovernedCall, AppendReceipt>>();
  // The FakeSandbox substrate (in-memory; stateless w.r.t. tenant — the effect only echoes status).
  const fake = new FakeSandboxAdapter();

  /**
   * The per-tenant SEAM appender (mirrors Personal): synthesize a real AuditEvent from the structural
   * event, append it to THIS partition's WORM log, AND write a console-projectable `event:<seq>` entry
   * into THIS tenant's repo so `console(ctx).timeline()` reflects the governed action. `result:"success"`
   * + `policyDecision.effect:"allow"` because the pipeline only commits AFTER screen+PDP+cost pass.
   */
  function makeAppender(
    binding: TenantBinding,
    log: InMemoryAppendOnlyLog,
    wormSink: (event: AuditEvent) => Promise<AppendReceipt>,
  ): CommitAppender<StructuralEvent, AppendReceipt> {
    const repo = store.forTenant(binding); // closure-bound to THIS tenant's partition (R8-S2)
    let seq = 0;
    return {
      append: async (event) => {
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
        // The WORM write goes to THIS tenant's sink (SLICE-ES2b): the INJECTED live partitioned-kernel
        // sink (partition_id = binding.partitionId) when `wormSinkFor` is provided, or — by default —
        // the per-tenant in-memory `log.append` (byte-identical to ES1). A reject (fail-closed live
        // append) propagates, the commitgate aborts, the effect never runs.
        const receipt = await wormSink(auditEvent);
        // Console-projectable timeline entry: key `event:<seq>`, value `{seq, summary}` — exactly the
        // shape ConsoleProjection.timeline() projects (projection.ts:65-72,102-112). Summary is
        // redacted on exit (defense in depth) though a secret never reaches here (denied@screen first).
        // UNCHANGED in ES2b so console(ctx).timeline() keeps reflecting the governed action whether the
        // WORM is in-memory or the live kernel partition (per-tenant readback alignment is out-of-scope).
        const entrySeq = ++seq;
        await repo.put(`event:${entrySeq}`, {
          seq: entrySeq,
          summary: redactSecrets(`Governed action ${event.tool} completed`),
        });
        return receipt;
      },
    };
  }

  /**
   * The per-tenant OPERATOR SEAM appender (SLICE-ES3; mirrors makeAppender, distinct event/action).
   * Synthesizes a real OPERATOR AuditEvent (`action: event.kind`, `resource: event.resource`, the
   * maker-checker `policyDecision`, `result:"success"`) and appends it to THIS partition's WORM. The
   * `commitBeforeEffect` guard awaits this receipt BEFORE the tenant-scoped effect runs. If
   * `failWormAppendFor(this tenant)` is set, the append REJECTS — exercising the fail-closed refusal
   * (no receipt ⇒ no effect). Closure-bound to ONE binding/log: it can only ever write this tenant.
   */
  function makeOperatorAppender(
    binding: TenantBinding,
    wormSink: (event: AuditEvent) => Promise<AppendReceipt>,
  ): CommitAppender<OperatorEvent, AppendReceipt> {
    return {
      append: async (event) => {
        if (failWormAppendFor(binding.tenantId)) {
          // Fail-closed test fault: signal append failure by REJECTING (never by resolving a falsy
          // receipt — the commitgate contract). The guard then refuses the effect.
          throw new Error("worm append rejected (deny-by-default)");
        }
        const ctx = event.context as AgentContext;
        const auditEvent = createAuditEvent({
          actorId: ctx.actorId,
          tenantId: ctx.tenantId,
          projectId: ctx.projectId,
          taskId: ctx.taskId,
          requestId: ctx.requestId,
          sandboxId: ctx.sandboxId,
          action: event.kind,
          resource: event.resource,
          policyDecision: { effect: "allow", reason: event.decisionReason },
          result: "success",
        });
        // ES2b: the operator WORM write routes through THIS tenant's sink — the INJECTED live
        // partitioned-kernel sink (partition_id = binding.partitionId) or, by default, the per-tenant
        // in-memory log (byte-identical to ES3). A reject => commitBeforeEffect refuses the effect.
        return wormSink(auditEvent);
      },
    };
  }

  /**
   * The tenant-scoped operator EFFECT (SLICE-ES3). Generic dispatch on `action.kind`; ES3 delivers
   * `suspend-agent`. For suspend-agent (`resource: "agent:<sandboxId>"`) it writes/updates THIS tenant's
   * repo at `<AGENT_PREFIX><sandboxId>` with the EXACT {sandboxId, agentName, phase} shape
   * ConsoleProjection.fleet() projects (projection.ts:53-61,94), so `console(ctx).fleet()` reflects
   * phase "suspended". Closure-bound to ONE binding's repo — it can only ever mutate this tenant. Only
   * reached AFTER the operator AuditEvent has a durable WORM receipt (commit-before-effect).
   */
  async function applyOperatorEffect(
    binding: TenantBinding,
    action: OperatorAction,
  ): Promise<void> {
    if (action.kind === "suspend-agent") {
      // Derive sandboxId from `agent:<sandboxId>` (strip the prefix the projection keys on).
      const sandboxId = action.resource.startsWith(AGENT_PREFIX)
        ? action.resource.slice(AGENT_PREFIX.length)
        : action.resource;
      const repo = store.forTenant(binding); // closure-bound to THIS tenant's partition (R8-S2)
      await repo.put(`${AGENT_PREFIX}${sandboxId}`, {
        sandboxId,
        agentName: sandboxId,
        phase: "suspended",
      });
      return;
    }
    // Unknown action kind: fail-closed (no silent effect). ES3 only delivers suspend-agent; other
    // privileged actions land later behind the SAME route → maker-checker → commit-before-effect path.
    throw new Error("unsupported operator action (deny-by-default)");
  }

  /**
   * The per-tenant governed-pipeline deps factory (closure-bound to ONE binding). Every port —
   * authorize's allow rule, cost, appender — is scoped to THIS tenant; the caller has no parameter to
   * name another. The PDP allow rule's tenantId === binding.tenantId, so even a mis-routed request to
   * a foreign rule fails closed (policy/evaluate.ts:42-45 cross-tenant deny-by-default).
   */
  function perTenantDeps(
    binding: TenantBinding,
  ): GovernedToolCallDeps<GovernedCall, AppendReceipt> {
    const cost = costByTenant.get(binding.tenantId);
    const log = wormByPartition.get(binding.partitionId);
    const wormSink = wormSinkByTenant.get(binding.tenantId);
    if (cost === undefined || log === undefined || wormSink === undefined) {
      // Unreachable for a registered tenant (the maps are populated below for each); fail-closed.
      throw new Error("unprovisioned tenant (deny-by-default)");
    }
    // `fleet:*` (NOT a bare `*`, which the PDP rejects as dangerously broad, evaluate.ts:75-77): a
    // non-wildcard prefix that matches every `fleet:<tool>` within the segment. tenantId === this
    // tenant, so it can ONLY grant this tenant (cross-tenant deny-by-default, evaluate.ts:42-45).
    const allow: AllowRule[] = allowToolInvoke(binding.tenantId)
      ? [
          {
            id: `es1-${binding.tenantId}`,
            action: "tool:invoke",
            resource: "fleet:*",
            tenantId: binding.tenantId,
          },
        ]
      : [];
    return {
      screen: (tc) => {
        const r = screenBrainEvent(tc as never, detectSecret);
        return r.status === "ok" ? { ok: true as const } : { ok: false as const, reason: r.reason };
      },
      authorize: async (tc) => {
        const req = {
          ...(tc.context as object),
          action: "tool:invoke",
          resource: tc.tool,
        } as PolicyRequest;
        // SLICE-DVx: with an injected PLATFORM registry, the registry deny-by-default runs IN FRONT of
        // the EXISTING per-tenant `fleet:*` PDP (`authorizeToolInvoke` = deny-by-default pre-screen ->
        // evaluatePolicy over THIS tenant's `allow`); an UNREGISTERED tool is denied before the PDP. It
        // adds ONLY a deny gate — `allow` (per-tenant, tenantId-scoped) is unchanged, so cross-tenant
        // deny-by-default is preserved. WITHOUT a registry, this is BYTE-IDENTICAL to ES1:
        // `evaluatePolicy(req, allow)`. Either branch folds through `combineDecisions(_, [])` as before.
        const decision = opts.toolRegistry
          ? authorizeToolInvoke(req, opts.toolRegistry, allow)
          : evaluatePolicy(req, allow);
        // SLICE-IT1a: evaluate the INJECTED shared advisory secondaries fail-closed (a throwing/rejecting
        // adapter -> a synthetic deny), then fold them into THIS tenant's decision. ABSENT => `[]` adapters
        // -> `[]` decisions, byte-identical to ES1's `combineDecisions(decision, [])`. combineDecisions is
        // any-deny-wins / per-tenant-PDP-sovereign: a secondary can only deny more — it never grants,
        // and (deny-only advisory) it does not affect this tenant's routing/isolation.
        // SLICE-R9a: `evaluateSecondaries` is async, so this closure is `async` and `await`s it.
        const secondaryDecisions = await evaluateSecondaries(opts.secondaries ?? [], req);
        const combined = combineDecisions(decision, secondaryDecisions);
        // Scrub UNTRUSTED secondary `reason` text before it flows into THIS tenant's committed
        // AuditEvent (the appender writes `decisionReason` -> the per-tenant WORM). ABSENT => identity.
        return { effect: combined.effect, reason: redactSecrets(combined.reason) };
      },
      cost,
      estimateTokens: () => estimate,
      appender: makeAppender(binding, log, wormSink),
      effect: async (tc) => {
        const res = await fake.createSandbox(tc.context, { image: tc.tool });
        return { ok: res.status === "ok", detail: res.status };
      },
    };
  }

  /**
   * SLICE-ES4 — the REUSABLE per-tenant provisioning step (extracted from the ES1 ctor loop, BEHAVIOUR
   * BYTE-IDENTICAL). Builds tenant-T's binding{tenantId, partition-${T}, store-${T}}, its INDEPENDENT
   * WORM log + sink, its INDEPENDENT CostGate, and its INDEPENDENT inbox (the inbox runner is
   * closure-bound to T's binding via perTenantDeps — the SOLE pipeline entry, T's pipeline over T's
   * cost/log only). It also ADDITIVELY registers T's partition in the shared store. It registers the
   * binding into `bindings` but does NOT rebuild the router — the caller (ctor loop / registerTenant)
   * decides when to snapshot the router (the ctor builds it once after the loop; registerTenant rebuilds
   * per call). The PER-TENANT INDEPENDENCE here is the load-bearing isolation: never one shared
   * instance + a tenantId parameter.
   */
  function provisionTenant(tenantId: string): TenantBinding {
    const binding: TenantBinding = {
      tenantId,
      partitionId: `partition-${tenantId}`,
      storeRef: `store-${tenantId}`,
    };
    // ADDITIVELY register THIS tenant's partition (fail-closed throw on a duplicate — but callers
    // validate against `bindings` first, so a duplicate never reaches here on the happy path).
    store.register(binding.partitionId);
    // A fresh Ed25519 keypair per partition — per-tenant independent signing material (honest
    // enterprise posture; ES1 generates in-process, real per-tenant key provision is ES4/P4 — see the
    // HONEST SCOPE note: attester == operator). When the LIVE partitioned sink is injected, the kernel
    // holds the real signing key per partition; this in-memory key still backs the default
    // (no-wormSinkFor) byte-identical-to-ES1 path + `wormLogFor`.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const log = new InMemoryAppendOnlyLog({ publicKey, privateKey });
    wormByPartition.set(binding.partitionId, log);
    // Resolve THIS tenant's WORM sink ONCE (closure-bound). Injected live sink => kernel partition;
    // ABSENT => the per-tenant in-memory `log.append` (byte-identical to ES1/ES3). NEVER one shared
    // sink: the default closes over THIS binding's own `log`.
    const injected = opts.wormSinkFor?.(binding);
    wormSinkByTenant.set(
      binding.tenantId,
      injected ?? ((auditEvent: AuditEvent) => Promise.resolve(log.append(auditEvent))),
    );
    // SLICE-IT1a: build THIS tenant's INDEPENDENT gate from the INJECTED per-tenant factory, or —
    // ABSENT — the ES1-identical `new InMemoryCostGate(budget)`. PER-TENANT ISOLATION: the factory is
    // called with THIS tenant's id and returns a gate scoped to THIS tenant (A's always-deny/SpendGuard
    // gate is NEVER B's). FAIL-CLOSED PROVISIONING: if the factory THROWS for THIS tenant, install a
    // deny-all `NullCostGate` for it (its calls deny@cost) instead of aborting the whole fleet — so one
    // tenant's gate-construction fault NEVER prevents the other tenants from being provisioned (A's
    // fault denies A only, never B). The chosen gate is wrapped fail-closed so an EXTERNAL gate's thrown
    // reserve/commit/release becomes a structured deny; the in-tree gate never throws, so the ABSENT
    // path is byte-identical. The injected gate is THIS tenant's spend authority; the invariant is that
    // a gate that DENIES cannot grant the effect.
    let tenantGate: CostGate;
    try {
      tenantGate = opts.costGateFor?.(binding.tenantId) ?? new InMemoryCostGate(budget);
    } catch {
      // Factory fault => deny-all for THIS tenant (deny-by-default), fleet construction continues.
      tenantGate = new NullCostGate();
    }
    costByTenant.set(binding.tenantId, failClosedCostGate(tenantGate));
    inboxByTenant.set(
      binding.tenantId,
      new ApprovalInbox<GovernedCall, AppendReceipt>((tc) =>
        runGovernedToolCall(perTenantDeps(binding), tc),
      ),
    );
    bindings.set(tenantId, binding);
    return binding;
  }

  // Provision the per-tenant INDEPENDENT instances for the build-time tenants (ES1 static path). The
  // router was snapshotted from an EMPTY `bindings` above; re-snapshot it ONCE after the loop so the
  // pre-registered tenants route. This is byte-identical to the ES1 ctor (one router, built from the
  // fully-populated bindings) — the cross-tenant + operator e2e stay green unchanged.
  for (const tenantId of opts.tenants) {
    provisionTenant(tenantId);
  }
  router = new TenantRouter(bindings);

  return {
    route: (ctx) => router.resolve(ctx),

    submitForApproval: (ctx, call) => {
      // Route FIRST (fail-closed): an unrouted/unknown tenant never reaches an inbox.
      const routed = router.resolve(ctx);
      if (!routed.ok) {
        return { status: "denied", reason: routed.reason };
      }
      const inbox = inboxByTenant.get(routed.binding.tenantId);
      if (inbox === undefined) {
        return { status: "denied", reason: "unprovisioned tenant (deny-by-default)" };
      }
      // ApprovalInbox.submit(preview, call): the preview is not load-bearing for ES1 (Enterprise takes
      // a GovernedCall directly; no intent/plan projection), so pass a minimal valid PlanPreview.
      return inbox.submit({ title: "", steps: [], affectedResources: [], summary: "" }, call);
    },

    approve: async (ctx, id) => {
      const routed = router.resolve(ctx);
      if (!routed.ok) {
        return { status: "denied", reason: routed.reason };
      }
      const inbox = inboxByTenant.get(routed.binding.tenantId);
      if (inbox === undefined) {
        return { status: "denied", reason: "unprovisioned tenant (deny-by-default)" };
      }
      // B approving an A-issued id resolves B's inbox, which has no such pending entry -> deny-by-default.
      return inbox.approve(id);
    },

    console: (ctx) => {
      const routed = router.resolve(ctx);
      if (!routed.ok) {
        return { ok: false, reason: routed.reason };
      }
      return { ok: true, console: projection.forTenant(routed.binding) };
    },

    operatorAction: async (ctx, action, cap) => {
      // The structural operator event mirrored back in every result (ok OR denied). Built up-front so a
      // route/maker-checker deny still returns a well-formed `event` — no value-leaking branches.
      const event: OperatorEvent = {
        kind: action.kind,
        resource: action.resource,
        context: ctx,
        decisionReason: "", // filled with the maker-checker reason only on the allow path
      };

      // 1. Gateway route boundary FIRST (fail-closed): an unrouted/unknown tenant never reaches the gate
      //    or the WORM. Reason is the router's static reason (no cap/ctx value).
      const routed = router.resolve(ctx);
      if (!routed.ok) {
        return { status: "denied", reason: routed.reason, event };
      }
      const binding = routed.binding;
      const wormSink = wormSinkByTenant.get(binding.tenantId);
      if (wormSink === undefined) {
        // Unreachable for a registered tenant; fail-closed.
        return { status: "denied", reason: "unprovisioned tenant (deny-by-default)", event };
      }

      // 2. Maker-checker gate (REUSE enforceMakerChecker — the 5 checks live there, NOT here): a deny
      //    short-circuits BEFORE any audit/effect. Reasons are the primitive's STATIC error codes
      //    (cross_tenant_capability / maker_is_checker / action_identity_mismatch / invalid_*), never an
      //    interpolated cap/ctx value (credential-blind).
      const decision = enforceMakerChecker(ctx, action, cap);
      if (decision.effect === "deny") {
        return { status: "denied", reason: decision.reason, event };
      }

      // 3. Commit-before-effect (REUSE commitBeforeEffect — ordering lives there, NOT here): append the
      //    operator AuditEvent to THIS tenant's WORM, AWAIT the receipt, and only THEN run the effect.
      //    An append failure ⇒ the effect is REFUSED (fail-closed); we surface that as denied.
      const auditedEvent: OperatorEvent = { ...event, decisionReason: decision.reason };
      const outcome = await commitBeforeEffect({
        appender: makeOperatorAppender(binding, wormSink),
        event: auditedEvent,
        // 4. The tenant-scoped suspend-agent effect: write THIS tenant's repo `agent:<sandboxId>` in the
        //    EXACT shape ConsoleProjection.fleet() projects, so console(ctx).fleet() shows phase
        //    "suspended". The path stays generic (dispatch on action.kind) but ES3 delivers suspend-agent.
        effect: async () => {
          await applyOperatorEffect(binding, action);
        },
      });

      if (outcome.status === "aborted") {
        // No durable receipt ⇒ the effect never ran. Static reason (the guard's own message; no cap/ctx).
        return { status: "denied", reason: "commit_before_effect_aborted", event: auditedEvent };
      }
      return { status: "ok", event: auditedEvent };
    },

    wormLogFor: (ctx) => {
      const routed = router.resolve(ctx);
      if (!routed.ok) {
        return undefined;
      }
      return wormByPartition.get(routed.binding.partitionId);
    },

    registerTenant: (tenantId) => {
      // 1. Fail-closed VALIDATE before any mutation. Empty / whitespace tenantId => denied (a blank id
      //    would also fail parseAgentContext at route time, but reject it up-front, deny-by-default).
      if (tenantId.trim().length === 0) {
        return { status: "denied", reason: "invalid tenant id (deny-by-default)" };
      }
      // 2. Duplicate => denied, NO mutation: the existing tenant's binding/log/inbox are untouched
      //    (we never call provisionTenant, so store.register — which would throw and clobber nothing —
      //    is never even reached, and no instance is overwritten).
      if (bindings.has(tenantId)) {
        return { status: "denied", reason: "tenant already registered (deny-by-default)" };
      }
      // 3. Provision THIS tenant's INDEPENDENT deps + ADDITIVELY register its partition in the shared
      //    store (the ConsoleProjection already holds that store, so the new partition is visible), then
      //    IMMUTABLY REBUILD the router from the now-larger bindings — preserving the no-mutation-API
      //    structural isolation (TenantRouter defensively copies; there is no add-binding API to abuse).
      //    RE-REGISTRATION of a previously-deprovisioned id: deprovision revokes routing but, by the
      //    append-only WORM invariant, NEVER erases the tenant's partition/history — so store.register
      //    (provisionTenant's first step) throws on the still-present partition. We translate that into a
      //    clean fail-closed `denied` (a retired id is not re-onboardable in-process; that would risk
      //    silently reusing the old tenant's WORM/inbox state). store.register throws BEFORE any other
      //    per-tenant set and before bindings.set/the router rebuild, so the fleet stays consistent.
      try {
        provisionTenant(tenantId);
      } catch {
        return { status: "denied", reason: "tenant id retired (deny-by-default)" };
      }
      router = new TenantRouter(bindings);
      return { status: "ok" };
    },

    deprovisionTenant: (tenantId) => {
      // 1. Fail-closed VALIDATE: a tenant that was never registered cannot be offboarded => denied.
      if (!bindings.has(tenantId)) {
        return { status: "denied", reason: "unknown tenant (deny-by-default)" };
      }
      // 2. Remove the binding and IMMUTABLY REBUILD the router WITHOUT it — `route(ctx)` for this tenant
      //    now fail-closed denies (and submit/approve/operatorAction/console with it, all route-first).
      bindings.delete(tenantId);
      router = new TenantRouter(bindings);
      // The tenant's append-only WORM log in `wormByPartition` is INTENTIONALLY NOT erased (deprovision
      // = revoke routing/action capability, NOT delete history; append-only, by design). Its cost/inbox
      // entries may also remain (now unreachable, since route denies). We never touch the WORM.
      return { status: "ok" };
    },
  };
}
