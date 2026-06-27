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
  /**
   * SLICE-CRED-ONELEVEL: the OAuth TOKEN (a secret). It belongs in `env` under the constant key
   * `AGENTOS_GMAIL_OAUTH_KEY`, where the transport resolves it at egress. (Retained for the operator
   * driver's call shape; the binding keys its placeholder by the constant NAME, not by this value.)
   */
  readonly oauthKey: string;
  /**
   * The env the REAL transport resolves the placeholder against at egress. ONE-LEVEL:
   * `env["AGENTOS_GMAIL_OAUTH_KEY"]` DIRECTLY HOLDS the token.
   */
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
  /**
   * SLICE-REPORT-FIX — the EFFECT's own ActionResult.ok (the guarded connector's `ok`), surfaced so the
   * caller can tell a REAL send (effect ok:true) from an "executed-but-refused" non-send (effect ok:false
   * — e.g. the guard's "acting account not in the test allowlist"). The pipeline's `executed` status alone
   * only means "the effect stage RAN", NOT that the send succeeded — so the bare outcome is NOT enough to
   * honestly report "sent". PRESENT only when the effect actually ran (the executed path); ABSENT on a
   * pipeline-level deny (denied@<stage>, where the effect never ran).
   */
  readonly effectOk?: boolean;
  /**
   * SLICE-REPORT-FIX — the EFFECT's own (connector) detail (e.g. the guard's deny reason). Surfaced for the
   * honest NOT-SENT label; {@link classifyLiveOutcome} redactSecrets it before it is ever shown. Never a
   * token / resolved-account email (the guard's reasons are static, credential-blind).
   */
  readonly effectDetail?: string;
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
  // SLICE-REPORT-FIX — capture the EFFECT's own ActionResult (ok + detail) as it flows through the
  // pipeline's injected effect. The pipeline's `executed` outcome surfaces only the effect `detail`, NOT
  // its `ok` — so without this capture the caller cannot tell a real send from an "executed-but-refused"
  // non-send (guard deny => effect ok:false). We thread it onto the result so classifyLiveOutcome can read
  // the truth. Stays undefined on a pipeline-level deny (the effect never runs).
  let effectOk: boolean | undefined;
  let effectDetail: string | undefined;
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
    effect: async (tc) => {
      trace.push({
        stage: "effect",
        detail: "guarded connector → google connector → transport (egress)",
      });
      // SLICE-REPORT-FIX — record the EFFECT's own result (the guarded connector's ActionResult.ok +
      // detail) so the runner can surface whether a REAL send happened (ok:true) vs the guard/connector
      // refusing (ok:false) — the bit the pipeline's `executed` status does NOT carry. (Effect-result `ok`
      // lives HERE; the pipeline's GovernedOutcome forwards only `detail`, not `ok`.)
      const r = await baseEffect(tc);
      effectOk = r.ok;
      effectDetail = r.detail;
      return r;
    },
  };

  // SLICE-CRED-ONELEVEL: the gmail.send binding keys its placeholder by the CONSTANT NAME
  // `GMAIL_OAUTH_KEY_ENV` (= "AGENTOS_GMAIL_OAUTH_KEY"), so the descriptor ALWAYS carries
  // `openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY` — independent of process.env. The transport resolves
  // that placeholder against `opts.env` (where AGENTOS_GMAIL_OAUTH_KEY DIRECTLY HOLDS the token), the
  // single last-mile resolution point. `opts.oauthKey` (the token) belongs in `opts.env` under that key;
  // the runner no longer mutates the ambient process.env (the old two-level indirection is gone).
  const outcome: GovernedOutcome<{ id: number }> = await runGovernedToolCall(deps, {
    tool: "gmail.send",
    context: RUN_CONTEXT,
    args: {
      to: opts.testAccount,
      subject: "agent-os live test",
      body: "agent-os governed live self-test",
    },
  });
  trace.push({ stage: "outcome", detail: outcome.status });

  return {
    outcome,
    appended,
    trace,
    http: captured,
    // SLICE-REPORT-FIX — surface the effect's own ok/detail (undefined when the effect never ran, i.e. a
    // pipeline-level deny). classifyLiveOutcome reads these to honestly distinguish a send from a non-send.
    ...(effectOk !== undefined ? { effectOk } : {}),
    ...(effectDetail !== undefined ? { effectDetail } : {}),
  };
}

// ================================================================================================
// SLICE-REPORT-FIX — classifyLiveOutcome: the HONEST send/not-sent verdict for the operator script.
//
// THE BUG THIS FIXES: the pipeline's `outcome.status === "executed"` only means "the effect stage RAN" —
// it does NOT mean the send succeeded. On the guard-deny path the effect RAN but the guarded connector
// returned `{ ok:false, detail:"acting account not in the test allowlist …" }`, so NOTHING was sent — yet
// the old script printed "ok — executed". This function reads the EFFECT's own ActionResult.ok (threaded
// onto {@link RunGmailSelfSendResult.effectOk}) so a non-send can NEVER be reported as a send.
//
// `sent` is TRUE iff the pipeline outcome is "executed" AND the effect's ok === true (a REAL send).
// Otherwise `sent` is false and `label` is a FIXED-shape, redactSecrets'd "NOT SENT — …" reason:
//   - executed + effect ok:false   => "NOT SENT — <redactSecrets(connector detail)>" (guard/connector refused);
//   - denied@<stage>               => "NOT SENT — denied@<stage>" (pipeline-level deny: policy/approval/commit);
//   - executed + effect ok missing => "NOT SENT — effect result unavailable" (fail-closed; not a proven send).
//
// ZERO-CREDENTIAL: the label is redactSecrets'd and assembled from fixed literals + the guard's own static
// (credential-blind) detail — it NEVER echoes a token or a resolved-account email (PII).
// ================================================================================================

/** The honest verdict: was anything REALLY sent, and a fixed-shape, redacted human label. */
export interface LiveOutcomeVerdict {
  /** TRUE only when the pipeline executed the effect AND the effect's ActionResult.ok === true. */
  readonly sent: boolean;
  /** A FIXED-shape, redactSecrets'd label. On a non-send it is the "NOT SENT — …" reason. No token / PII. */
  readonly label: string;
}

/**
 * Classify a {@link RunGmailSelfSendResult} into an HONEST send verdict. PURE over the result; performs no
 * I/O. `sent` is TRUE iff `outcome.status === "executed"` AND `result.effectOk === true`. The label is
 * always redactSecrets'd before return so a connector detail can never become a credential/PII sink.
 */
export function classifyLiveOutcome(result: RunGmailSelfSendResult): LiveOutcomeVerdict {
  const { outcome } = result;

  // Pipeline-level deny (policy / approval / commit / screen / cost): the effect NEVER ran => NOT SENT.
  if (outcome.status !== "executed") {
    return { sent: false, label: redactSecrets(`NOT SENT — denied@${outcome.stage}`) };
  }

  // Executed AND the effect's own ActionResult.ok === true => a REAL send. This is the ONLY `sent:true`.
  if (result.effectOk === true) {
    return { sent: true, label: "SENT — governed live self-send executed" };
  }

  // Executed but the effect (guard/connector) refused (ok:false) — or the effect-ok is unavailable
  // (defensive, fail-closed) => NOT SENT. The connector's static detail (when present) rides the label so
  // the operator learns WHY; redactSecrets guarantees no token/secret-shape can leak through it.
  if (result.effectOk === false) {
    const reason =
      result.effectDetail !== undefined && result.effectDetail.trim().length > 0
        ? result.effectDetail
        : "blocked by the action guard/connector";
    return { sent: false, label: redactSecrets(`NOT SENT — ${reason}`) };
  }
  return { sent: false, label: redactSecrets("NOT SENT — effect result unavailable") };
}

// ================================================================================================
// SLICE-CRED-ONELEVEL — liveGmailPreflight: the credential-blind env gate for the operator scripts
// (scripts/e2e-live-gmail.sh -> scripts/act-live-gmail.mjs). ONE-LEVEL: AGENTOS_GMAIL_OAUTH_KEY DIRECTLY
// HOLDS the token (a secret), so the gate is a NON-BLANK check on it (NOT an identifier validation) — a
// token-shaped value (with a `.`) is correct, not a footgun. The CRED-LEAK-FIX zero-echo invariant is
// preserved and made stronger: EVERY reason here is assembled from FIXED string literals ONLY — it NEVER
// concatenates any env VALUE — so the diagnostic can never become a credential sink. The only env
// identifiers that ever appear in a reason are the fixed VARIABLE NAMES (e.g. the literal
// "AGENTOS_GMAIL_OAUTH_KEY"), never their values.
// ================================================================================================

/**
 * The four operator-opt-in gate vars (all must be set+non-blank to attempt a live send). Under ONE-LEVEL,
 * AGENTOS_GMAIL_OAUTH_KEY is itself the token — so a blank token is caught here (fail-closed "skip").
 */
const LIVE_GATE_VARS = [
  "AGENTOS_ACTION_LIVE",
  "AGENTOS_ACTION_TEST_ACCOUNT",
  GMAIL_OAUTH_KEY_ENV, // = "AGENTOS_GMAIL_OAUTH_KEY"
  "AGENTOS_EGRESS_ALLOW",
] as const;

/** The fixed, zero-interpolation reason strings. NONE of these embed any env VALUE. */
const PREFLIGHT_REASON = {
  skip:
    "SKIP (env not set) — set AGENTOS_ACTION_LIVE + AGENTOS_ACTION_TEST_ACCOUNT + " +
    "AGENTOS_GMAIL_OAUTH_KEY (the OAuth token itself) + AGENTOS_EGRESS_ALLOW to run a real self-send",
  ok:
    "OK — live env present (AGENTOS_GMAIL_OAUTH_KEY holds the token; it resolves at egress; " +
    "the operator running the script is the confirmation)",
} as const;

/**
 * The result of {@link liveGmailPreflight} — a status + a FIXED-string reason (never an env value).
 * ONE-LEVEL: the gate is deny-by-default fail-closed — it returns "ok" (all gate vars present, token in
 * AGENTOS_GMAIL_OAUTH_KEY) or "skip" (any gate var unset/blank, including a blank token => no send). The
 * "blocked" arm is retained in the union for callers/back-compat (the old two-level misconfig status); the
 * one-level gate never returns it.
 */
export interface LiveGmailPreflight {
  readonly status: "ok" | "skip" | "blocked";
  /** A FIXED enum-like reason assembled from string literals ONLY — NEVER any env VALUE. */
  readonly reason: string;
}

/**
 * SLICE-CRED-ONELEVEL — credential-blind preflight for the operator live-gmail scripts. PURE: reads only
 * the supplied `env`, returns a status + a FIXED-string reason. ⚠️ The reason is assembled from string
 * literals ONLY — it NEVER interpolates any env VALUE (so the OAuth token now held DIRECTLY in
 * AGENTOS_GMAIL_OAUTH_KEY can never be echoed). ONE-LEVEL logic (deny-by-default):
 *   - any gate var unset/blank (incl. AGENTOS_GMAIL_OAUTH_KEY, which DIRECTLY HOLDS the token) => "skip"
 *     (PREFLIGHT_REASON.skip — fail-closed: a blank token means there is nothing to send with)
 *   - else (all four gate vars non-blank; AGENTOS_GMAIL_OAUTH_KEY holds a non-blank token) => "ok"
 *     (PREFLIGHT_REASON.ok)
 *
 * The token value is NOT validated as an identifier — it IS the token (a `ya29.…`-shaped secret), so a
 * value containing a `.` is correct, NOT a footgun. (The old two-level "must be a NAME" / "named token
 * unset" teaching branches are removed; the reason set stays value-free.)
 */
export function liveGmailPreflight(env: Record<string, string | undefined>): LiveGmailPreflight {
  // All four opt-in gate vars must be set + non-blank, else SKIP (never echo any value). Because
  // AGENTOS_GMAIL_OAUTH_KEY (which DIRECTLY HOLDS the token) is one of the gate vars, an unset/blank token
  // is caught here — fail-closed, no send. The token VALUE is never validated nor echoed.
  for (const name of LIVE_GATE_VARS) {
    const v = env[name];
    if (v === undefined || v.trim().length === 0) {
      return { status: "skip", reason: PREFLIGHT_REASON.skip };
    }
  }

  // Fully configured (one-level: the token is present in AGENTOS_GMAIL_OAUTH_KEY) => OK.
  return { status: "ok", reason: PREFLIGHT_REASON.ok };
}

/** Re-export the captured-request shape for callers that want to inspect the egress. */
export type { HttpActionRequest };
