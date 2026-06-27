/**
 * SLICE-ACT3-live — the importable, testable CORE of the live self-send runner (scripts/act-live-gmail.mjs).
 * It wires the FULL governed pipeline for `gmail.send` (the action-join.test.ts shape) over the REAL
 * `runGovernedToolCall`, with `deps.effect = bindingWrappedActionEffect(createGuardedActionConnector(
 * createGoogleActionConnector(transport), { live, testAccounts, resolveAccount }), seedActionBindings(...))`,
 * an in-memory WORM appender, and runs ONE self-send. It returns the governance trace, the appended WORM
 * events, and a handle on the transport's captured requests so the caller (test OR operator runner) can assert
 * the invariants and print a redacted trace.
 *
 * RUNTIME-DIRECT posture (HONEST): the transport (the egress actor) resolves the credential placeholder from
 * env at the network boundary — the single, last-mile resolution point. Everything upstream (the brain, the
 * authorize fold, the projection, the WORM intent + boundary) is CREDENTIAL-BLIND: it sees ONLY the
 * `openshell:resolve:env:<KEY>` placeholder, never the real token. The production-strongest posture is a
 * sandbox SecretResolver (EXEC2) where the runtime never holds the token; runtime-direct is the reasonable
 * first live path for a throwaway test account.
 *
 * TESTABILITY: the transport is built from {@link createHttpActionTransport} with an INJECTED fake fetch that
 * RECORDS each outbound request (post-credential-resolution). So a unit test (FAKE fetch + FAKE resolver, NO
 * network) can prove: the connector reaches the transport with the RESOLVED Authorization; the WORM/projection
 * carry NO resolved token; live-off / not-allowlisted / wrong-egress => no send. The OPERATOR runner injects
 * the REAL `globalThis.fetch` (live-only) — the egress that actually hits Google.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone; imports ONLY neutral barrels
 * (audit/commitgate/cost/orchestration/policy/tools) + sibling hermes action modules. No new dependency.
 * Re-exported via the hermes barrel.
 */
import { redactSecrets } from "../../../../audit/index.js";
import type { CommitAppender } from "../../../../commitgate/index.js";
import { type CostGate, InMemoryCostGate } from "../../../../cost/index.js";
import {
  type ApprovalOutcome,
  type AuthorizeDecision,
  type GovernedOutcome,
  type GovernedToolCallDeps,
  createBudgetApprover,
  runGovernedToolCall,
} from "../../../../orchestration/index.js";
import {
  type PolicyDecision,
  combineDecisions,
  egressDecisionForProjection,
} from "../../../../policy/index.js";
import { type Primitive, authorizeToolInvoke } from "../../../../tools/index.js";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import { bindingWrappedActionEffect } from "./action-closed-loop.js";
import { createGoogleAccountResolver } from "./action-google-account-resolver.js";
import { createGoogleActionConnector } from "./action-google-connector.js";
import { createGuardedActionConnector } from "./action-guard.js";
import {
  type FetchImpl,
  type HttpActionRequest,
  createHttpActionTransport,
} from "./action-http-transport.js";
import { buildActionProjectionForCall } from "./action-projection-for-call.js";
import {
  GMAIL_OAUTH_KEY_ENV,
  seedActionBindings,
  seedActionRegistry,
} from "./action-seed-tools.js";

/** The full {egress-allowlist, approval} wiring — the only set that registers gmail.send (destructive). */
const ACTION_WIRED: ReadonlySet<Primitive> = new Set<Primitive>(["egress-allowlist", "approval"]);

/** The neutral context ids the pipeline + WORM events carry (no secret, no PII). */
const RUN_CONTEXT = {
  actorId: "agent:hermes-live",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-live-gmail",
} as const;

/** A captured outbound request (post-credential-resolution) the transport actually sent to the fetch layer. */
export interface CapturedHttp {
  readonly requests: { method: string; url: string; headers: Record<string, string> }[];
}

/** Options for {@link runGmailSelfSend}. */
export interface RunGmailSelfSendOptions {
  /** Master switch — the guard is deny-all unless this is exactly true. */
  readonly live: boolean;
  /** The single SELF-send recipient (also the test-account allowlist entry). */
  readonly testAccount: string;
  /** The egress host allowlist (the fold gates the gmail host). */
  readonly egressAllow: readonly string[];
  /** The OAuth credential KEY the gmail.send binding resolves a placeholder for. */
  readonly oauthKey: string;
  /** The env the REAL transport resolves the placeholder against at egress (carries the token). */
  readonly env: Record<string, string>;
  /**
   * TEST override for the resolved acting account. When provided, the resolver is a fixed-answer fake (the
   * guard compares it to the allowlist) — so a unit test needs no userinfo HTTP. When OMITTED, the runner
   * uses the REAL {@link createGoogleAccountResolver} over the same transport (the live path).
   */
  readonly resolvedAccount?: string | undefined;
  /**
   * Whether `resolvedAccount` was explicitly supplied (so `undefined` can mean "fake resolver yields
   * undefined" vs "use the real resolver"). Set by the test helper; the live runner leaves it false.
   */
  readonly useFakeResolver?: boolean;
  /** A canary token (test-only) — surfaced back so the test can assert it never reached the WORM/projection. */
  readonly canary?: string;
  /**
   * The fetch the transport uses. DEFAULTS to a capturing fake that returns 200 `{ "id": "fake" }` (so the
   * runner core is testable with NO network). The OPERATOR runner injects `globalThis.fetch` (live egress).
   */
  readonly fetchImpl?: FetchImpl;
}

/** What {@link runGmailSelfSend} returns — the outcome, the WORM events, the trace, and the captured egress. */
export interface RunGmailSelfSendResult {
  readonly outcome: GovernedOutcome<{ id: number }>;
  readonly appended: unknown[];
  readonly trace: { stage: string; detail: string }[];
  readonly http: CapturedHttp;
}

/**
 * Build the FULL governed pipeline for gmail.send and run ONE self-send. Fail-closed at every gate; the
 * connector is reached ONLY on a fully-permitted (live + allowlisted + egress-allowed + approved) path.
 */
export async function runGmailSelfSend(
  opts: RunGmailSelfSendOptions,
): Promise<RunGmailSelfSendResult> {
  const registry = seedActionRegistry(ACTION_WIRED);
  const bindings = seedActionBindings(ACTION_WIRED);
  const trace: { stage: string; detail: string }[] = [];

  // --- The capturing transport. A fake fetch RECORDS each outbound request POST credential-resolution, so a
  // test can prove the resolved token appears ONLY here (never in the WORM/projection). The default fetch is
  // a canned 200; the operator runner injects globalThis.fetch (the live egress).
  const captured: CapturedHttp = { requests: [] };
  // The DELEGATE fetch — the operator runner's injected `globalThis.fetch` (live egress) OR a canned 200.
  const delegateFetch: FetchImpl =
    opts.fetchImpl ??
    (() =>
      Promise.resolve({ status: 200, text: () => Promise.resolve('{"id":"fake-message-id"}') }));
  // One capture point: record the RESOLVED outbound request (post credential-resolution) exactly ONCE, then
  // delegate. So the resolved token appears here (egress) and NOWHERE upstream.
  const capturingFetch: FetchImpl = (url, init) => {
    captured.requests.push({ method: init.method, url, headers: { ...init.headers } });
    return delegateFetch(url, init);
  };
  const transport = createHttpActionTransport({ env: opts.env, fetchImpl: capturingFetch });

  // --- The resolver: a fixed-answer fake when the test supplies one; else the REAL userinfo resolver.
  const resolveAccount =
    opts.useFakeResolver === true
      ? {
          resolveAccount: () => Promise.resolve(opts.resolvedAccount),
        }
      : createGoogleAccountResolver(transport);

  // --- The guarded → google connector → real transport, wrapped by the binding effect (the action edge).
  const guarded = createGuardedActionConnector(createGoogleActionConnector(transport), {
    live: opts.live,
    testAccounts: [opts.testAccount],
    resolveAccount,
  });
  const baseEffect = bindingWrappedActionEffect(guarded, bindings, {
    detectSecret: defaultExecSecretDetector,
  });

  // --- An in-memory WORM appender (records every appended event). Credential-blind: the events carry only
  // safe-derived fields; we assert the canary never lands here.
  const appended: unknown[] = [];
  let receiptId = 0;
  const appender: CommitAppender<unknown, { id: number }> = {
    append: (event) => {
      appended.push(event);
      return Promise.resolve({ id: ++receiptId });
    },
  };

  const allowRules = [
    {
      id: "allow-gmail",
      action: "tool:invoke",
      resource: "gmail.**",
      tenantId: RUN_CONTEXT.tenantId,
    },
  ];
  const cost: CostGate = new InMemoryCostGate(1_000_000);
  // gmail.send is destructive => approval-gated; pre-authorize it (the OPERATOR running the runner is the
  // human confirmation — see scripts/act-live-gmail.mjs's "ABOUT TO SEND" gate).
  const approve = createBudgetApprover((tc) => {
    const name = (tc as { tool?: unknown } | null)?.tool;
    return typeof name === "string" && name === "gmail.send";
  });

  const deps: GovernedToolCallDeps<
    { tool: string; context: unknown; args?: Record<string, unknown> },
    { id: number }
  > = {
    screen: (tc) => {
      trace.push({ stage: "screen", detail: `ok: ${tc.tool}` });
      return { ok: true };
    },
    authorize: (tc) => {
      const c = tc.context as typeof RUN_CONTEXT;
      const req = {
        requestId: c.requestId,
        tenantId: c.tenantId,
        projectId: c.projectId,
        taskId: c.taskId,
        actorId: c.actorId,
        action: "tool:invoke",
        resource: tc.tool,
      };
      const projection = buildActionProjectionForCall(
        { tool: tc.tool, ...(tc.args !== undefined ? { args: tc.args } : {}) },
        bindings,
        (name) => registry.lookup(name),
        "effectful",
      );
      const pdp: PolicyDecision = authorizeToolInvoke(req, registry, allowRules);
      const containment = registry.lookup(tc.tool)?.containment;
      let egressDecisions: PolicyDecision[];
      if (projection !== undefined && projection.networkHosts.length > 0) {
        egressDecisions = [egressDecisionForProjection(projection.networkHosts, opts.egressAllow)];
      } else if (containment === "network-egress") {
        egressDecisions = [
          {
            effect: "deny",
            reason: "egress: network-egress tool with no projectable host — denied (fail-closed)",
            auditRequired: true,
          },
        ];
      } else {
        egressDecisions = [];
      }
      const combined = combineDecisions(pdp, egressDecisions);
      const decision: AuthorizeDecision = {
        effect: combined.effect,
        reason: redactSecrets(combined.reason),
        requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false,
        external: containment === "network-egress" || containment === "host-fs-write",
        ...(projection !== undefined ? { projection } : {}),
      };
      trace.push({
        stage: "authorize",
        detail: `${decision.effect}; egress+approval folded; requiresApproval=${decision.requiresApproval}`,
      });
      return decision;
    },
    approve: (tc): ApprovalOutcome | Promise<ApprovalOutcome> => {
      trace.push({ stage: "approval", detail: "pre-authorized by operator (gmail.send)" });
      return approve(tc);
    },
    cost,
    estimateTokens: () => 10,
    appender: {
      append: (event) => {
        trace.push({ stage: "commit", detail: "WORM append (intent / boundary)" });
        return appender.append(event);
      },
    },
    effect: (tc) => {
      trace.push({
        stage: "effect",
        detail: "guarded connector → google connector → transport (egress)",
      });
      return baseEffect(tc);
    },
  };

  // The gmail.send binding reads `process.env[GMAIL_OAUTH_KEY_ENV]` to name the per-service credential KEY,
  // so the descriptor carries the `openshell:resolve:env:<KEY>` placeholder for that KEY. Point it at
  // `opts.oauthKey` for this run, then RESTORE (so the runner never mutates the ambient env globally).
  const prevOauthKey = process.env[GMAIL_OAUTH_KEY_ENV];
  process.env[GMAIL_OAUTH_KEY_ENV] = opts.oauthKey;
  let outcome: GovernedOutcome<{ id: number }>;
  try {
    outcome = await runGovernedToolCall(deps, {
      tool: "gmail.send",
      context: RUN_CONTEXT,
      args: {
        to: opts.testAccount,
        subject: "agent-os live test",
        body: "agent-os governed live self-test",
      },
    });
  } finally {
    if (prevOauthKey === undefined) delete process.env[GMAIL_OAUTH_KEY_ENV];
    else process.env[GMAIL_OAUTH_KEY_ENV] = prevOauthKey;
  }
  trace.push({ stage: "outcome", detail: outcome.status });

  return { outcome, appended, trace, http: captured };
}

/** Re-export the captured-request shape for callers that want to inspect the egress. */
export type { HttpActionRequest };
