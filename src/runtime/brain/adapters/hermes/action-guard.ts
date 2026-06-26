/**
 * SLICE-ACT3a-guard — the real-connector SAFETY GATE for the {@link ActionConnector} family: a wrapper that
 * makes a connector (a) DENY-ALL until `AGENTOS_ACTION_LIVE` is explicitly turned on (the MASTER SWITCH) and
 * (b) — even when live — structurally able to act ONLY on a configured TEST account (the user-chosen
 * "dedicated consumer test account" route). It is a PURE ADDITION: it wraps any ActionConnector and changes
 * NOTHING in the pipeline / authorize edge / the ACT1/ACT2 effect. The un-wrapped composition is unchanged.
 *
 * WHY a separate gate (not the ACT1 effect's credential-blind input guard): the ACT1 edge proves the JOIN
 * (binding -> validated descriptor) against a Fake connector. This gate is the LIVE-SAFETY ring that a REAL
 * connector (ACT3a-live, BLOCKED) is wrapped in BEFORE it ever sends: deny-by-default + an acting-account
 * allowlist. The two are orthogonal — the input guard screens WHAT is sent; this gate screens WHETHER (live)
 * and ON WHOSE ACCOUNT (test allowlist) it may send at all.
 *
 * FAIL-CLOSED at every gate, BEFORE the inner connector (each refusal => `inner.invoke` is NEVER called):
 *   - `config.live !== true`                       => refuse (deny-by-default; master switch off);
 *   - `config.resolveAccount` throws/rejects        => refuse (fail-closed — an account that cannot be
 *                                                      resolved is treated as not-allowlisted);
 *   - empty allowlist / account undefined / ∉ allow => refuse (deny-all / main-account protection).
 * ONLY a live call resolving to an allowlisted test account delegates to `inner.invoke(context, descriptor)`.
 *
 * CREDENTIAL-BLIND: every refusal `detail` is a STATIC reason — it NEVER echoes the resolved account, the
 * descriptor params, or any PII. The config's `testAccounts` is a NON-secret allowlist (account email
 * strings used purely for an equality match), never a credential.
 *
 * HONEST BOUNDARY: ACT3a-guard is the VERIFY-PROVEN gate (a Fake inner connector + a Fake account resolver).
 * The REAL connector transport (agent-os runtime's OWN Google/MCP client — NOT this session's MCP tools), the
 * REAL {@link AccountResolver} (the acting account via live MCP/OAuth auth), and the REAL send are ACT3a-live
 * — deploy/auth-gated, user-initiated + explicitly authorized. This gate GUARANTEES that, once those land,
 * the connector can only ever act on an allowlisted test account and only with `AGENTOS_ACTION_LIVE` on.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside `action-closed-loop.ts`; imports ONLY
 * the neutral orchestration type (`MaybePromise`) + the sibling ActionConnector/ActionDescriptor/ActionResult
 * types. No vendor named, no deep cross-module import, no new dependency. Re-exported via the hermes barrel.
 */
import type { MaybePromise } from "../../../../orchestration/index.js";
import type { ActionConnector, ActionDescriptor, ActionResult } from "./action-closed-loop.js";

/**
 * The ACCOUNT-RESOLVER port: resolves the ACTING account (e.g. the authenticated mailbox the connector would
 * send AS) for a given call. PRESENT-ONLY: returns `undefined` when no account can be determined (which the
 * guard treats as not-allowlisted => refuse). The REAL resolver — the acting account via LIVE MCP/OAuth auth
 * — is ACT3a-live (deploy/auth-gated, BLOCKED); ACT3a-guard ships ONLY the in-repo {@link FakeAccountResolver}.
 */
export interface AccountResolver {
  resolveAccount(context: unknown, descriptor: ActionDescriptor): MaybePromise<string | undefined>;
}

/** How a {@link FakeAccountResolver} behaves: resolve a fixed account/undefined, or throw (fail-closed test). */
export type FakeAccountResolverMode = string | undefined | { readonly throws: true };

/**
 * In-repo {@link AccountResolver} test double (the mandatory in-tree substrate, modeled on
 * {@link FakeActionConnector}): resolves a FIXED account string (or `undefined`), or — when constructed with
 * `{ throws: true }` — REJECTS, so the guard's fail-closed branch is provable WITHOUT a live auth. NO real
 * MCP / OAuth / network — a pure in-memory stand-in for the deploy-gated real resolver.
 */
export class FakeAccountResolver implements AccountResolver {
  private readonly mode: FakeAccountResolverMode;

  constructor(mode: FakeAccountResolverMode) {
    this.mode = mode;
  }

  resolveAccount(_context: unknown, _descriptor: ActionDescriptor): Promise<string | undefined> {
    if (typeof this.mode === "object" && this.mode !== null && this.mode.throws) {
      return Promise.reject(
        new Error("FakeAccountResolver: configured to throw (fail-closed test)"),
      );
    }
    return Promise.resolve(this.mode as string | undefined);
  }
}

/** The guard's configuration: the master switch, the test-account allowlist, and the account resolver. */
export interface ActionGuardConfig {
  /** MASTER SWITCH — the connector is DENY-ALL unless this is exactly `true` (deny-by-default). */
  readonly live: boolean;
  /** The NON-secret allowlist of test account strings the connector may act on. EMPTY => deny-all. */
  readonly testAccounts: readonly string[];
  /** Resolves the ACTING account for a call (the {@link AccountResolver} port). */
  readonly resolveAccount: AccountResolver;
}

/**
 * STATIC refusal reasons. CREDENTIAL-BLIND: these are fixed strings — a refusal NEVER carries the resolved
 * account, the descriptor params, or any PII. (Exported-shaped as module constants so the wording is the one
 * source of truth and the credential-blind test can assert a canary never appears.)
 */
const REFUSE_LIVE_DISABLED = "action live mode disabled (deny-by-default)";
const REFUSE_NOT_ALLOWLISTED = "acting account not in the test allowlist (deny-by-default)";

/**
 * Wrap an {@link ActionConnector} with the ACT3a-guard SAFETY GATE. The returned connector's `invoke`:
 *   1. if `config.live !== true`                         => `{ok:false, detail:<static>}`; inner NOT called.
 *   2. resolve the acting account inside try/catch; a throw/reject => `{ok:false, detail:<static>}`; inner
 *      NOT called (FAIL-CLOSED — an unresolvable account is treated as not-allowlisted).
 *   3. if `testAccounts` is EMPTY, the account is `undefined`, or the account is NOT in `testAccounts`
 *                                                          => `{ok:false, detail:<static>}`; inner NOT called.
 *   4. otherwise                                          => `return inner.invoke(context, descriptor)`
 *      (delegate the ORIGINAL context + descriptor — a transparent pass-through on the allowed path).
 *
 * Every refusal `detail` is STATIC (credential-blind). The guard is pure over `config` + `inner`; it adds NO
 * dependency and does NOT touch the pipeline / authorize edge.
 */
export function createGuardedActionConnector(
  inner: ActionConnector,
  config: ActionGuardConfig,
): ActionConnector {
  return {
    async invoke(context: unknown, descriptor: ActionDescriptor): Promise<ActionResult> {
      // (1) MASTER SWITCH — deny-by-default. Only an explicit `true` lets the call proceed past here.
      if (config.live !== true) {
        return { ok: false, detail: REFUSE_LIVE_DISABLED };
      }

      // (2) Resolve the acting account, FAIL-CLOSED: a throw/reject => refuse, inner NEVER reached. An
      // account that cannot be resolved is structurally indistinguishable from "not allowlisted" => deny.
      let account: string | undefined;
      try {
        account = await config.resolveAccount.resolveAccount(context, descriptor);
      } catch {
        return { ok: false, detail: REFUSE_NOT_ALLOWLISTED };
      }

      // (3) ALLOWLIST gate (main-account protection). EMPTY allowlist => deny-all; an undefined account or an
      // account ∉ the allowlist => refuse. The account string is used ONLY for an equality match — never
      // echoed into the (static) refusal reason.
      if (
        config.testAccounts.length === 0 ||
        account === undefined ||
        !config.testAccounts.includes(account)
      ) {
        return { ok: false, detail: REFUSE_NOT_ALLOWLISTED };
      }

      // (4) ALLOWED — delegate the ORIGINAL context + descriptor to the inner connector (pass-through).
      return inner.invoke(context, descriptor);
    },
  };
}

/** The env var that is the MASTER SWITCH for the real connector. Off by default (deny-by-default). */
const ACTION_LIVE_ENV = "AGENTOS_ACTION_LIVE";
/** The env var carrying the NON-secret comma-separated test-account allowlist. Unset => empty => deny-all. */
const ACTION_TEST_ACCOUNT_ENV = "AGENTOS_ACTION_TEST_ACCOUNT";

/** The exact tokens that turn the master switch ON. Anything else (incl. "TRUE"/"yes"/blank) => off. */
const LIVE_TRUE_TOKENS: ReadonlySet<string> = new Set(["true", "1"]);

/**
 * Read the MASTER SWITCH from env (FAIL-CLOSED, mirroring `egressAllowFromEnv`'s shape). Returns `true` ONLY
 * when `AGENTOS_ACTION_LIVE` is EXACTLY a true-token (`"true"` or `"1"`); unset / blank / any other string
 * (e.g. `"false"`, `"TRUE"`, `"yes"`, `"true "`) => `false`. Pure over env — deny-by-default.
 */
export function actionLiveFromEnv(env: NodeJS.ProcessEnv): boolean {
  return LIVE_TRUE_TOKENS.has(env[ACTION_LIVE_ENV] ?? "");
}

/**
 * Read the test-account allowlist from env (FAIL-CLOSED, mirroring `egressAllowFromEnv`). Reads
 * `AGENTOS_ACTION_TEST_ACCOUNT` as a comma-separated list, trims each, and drops blanks. UNCONFIGURED
 * (unset / blank / only-whitespace) => an EMPTY list => DENY-ALL (the guard refuses on an empty allowlist).
 * Pure over env. NON-secret config (account email strings, never a credential).
 */
export function testAccountsFromEnv(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = env[ACTION_TEST_ACCOUNT_ENV] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Assemble an {@link ActionGuardConfig} from env + a caller-supplied {@link AccountResolver}. Convenience
 * over `actionLiveFromEnv` + `testAccountsFromEnv`: `{ live, testAccounts, resolveAccount }`. UNCONFIGURED
 * env => `{ live:false, testAccounts:[], resolveAccount }` (deny-by-default). The resolver is supplied by the
 * caller because a code object cannot ride env (the REAL resolver is ACT3a-live, deploy-gated).
 */
export function actionGuardConfigFromEnv(
  env: NodeJS.ProcessEnv,
  resolveAccount: AccountResolver,
): ActionGuardConfig {
  return {
    live: actionLiveFromEnv(env),
    testAccounts: testAccountsFromEnv(env),
    resolveAccount,
  };
}
