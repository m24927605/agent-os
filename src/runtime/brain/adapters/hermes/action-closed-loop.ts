/**
 * SLICE-ACT1 — the SIBLING `ActionBinding` port for NON-argv app/API actions (Gmail/Drive/Calendar),
 * the STRUCTURAL TWIN of `ExecToolBinding` / `bindingWrappedExecEffect` (exec-closed-loop.ts). It is a
 * SEPARATE family, deliberately NOT a generalization of the exec seam — the brainstorm panel rejected
 * generalizing `exec-closed-loop.ts` because that would mutate the product's highest-risk argv-purity
 * seam for a capability that does not need that refactor. The exec family is UNCHANGED by this module.
 *
 * WHY no-shell is STRONGER here than argv: an action is a `{service, method, params}` STRUCTURED
 * descriptor — there is NO command string, NO argv, NO `sh -c` to parse. `service`/`method` are
 * COMPOSER-FIXED (the brain proposes only a registered tool NAME + DECLARED params, never the
 * service/method/endpoint — so there is no retarget surface). `params` is built in ONE place by the
 * binding's pure `toParams` from STRICT-validated args, so a `"; rm -rf /"` value is just inert DATA in a
 * structured field — injection of that class is structurally impossible.
 *
 * The same THREE fail-closed gates as the exec twin, BEFORE the connector:
 *   (a) no binding for the tool        => fail-closed deny; `connector.invoke` NOT called;
 *   (b) `argSchema.safeParse` fail     => deny (a smuggled extra key cannot pass); NOT called;
 *   (c) credential-blind INPUT guard   => the SAME `defaultExecSecretDetector` (recursive over nested
 *       objects/arrays) screens the built params + env; a LITERAL secret => fail-closed deny; NOT called.
 * Only a fully validated, credential-blind proposal builds the descriptor and reaches `connector.invoke`.
 *
 * CREDENTIAL discipline: `toCredentialEnv?` emits ONLY a `placeholderForKey(KEY)` placeholder
 * (`openshell:resolve:env:<KEY>`), NEVER a literal token — reusing net.fetch's SAFE_ENV_KEY discipline
 * (see action-seed-tools.ts). The INPUT guard rejects any literal secret in params/env before the edge.
 *
 * HONEST BOUNDARY: ACT1 proves the JOIN logic + invariants against a Fake connector + the real pipeline
 * (EXEC3a posture). The real send + OAuth/SecretResolver-at-egress + MCP transport + real egress reach
 * are deploy/EXEC2-gated/BLOCKED. STRONGER than net.fetch: an API SDK can resolve a host the projector
 * cannot see, so the substrate seal stays PRIMARY and the REAL connector (ACT3) MUST refuse an
 * undeclared host.
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside exec-closed-loop.ts; imports ONLY
 * `zod` (type), the neutral substrate barrel (`ExecSecretDetector`, the recursive detector contract), the
 * neutral orchestration types (`EffectResult`, `MaybePromise`), and the neutral policy type
 * (`GovernanceProjection`). No vendor named, no deep cross-module import. Re-exported via the hermes barrel.
 */
import type { z } from "zod";
import type { EffectResult, MaybePromise } from "../../../../orchestration/index.js";
import type { GovernanceProjection } from "../../../../policy/index.js";
import { type ExecSecretDetector, defaultExecSecretDetector } from "../../../substrate/index.js";

/**
 * The COMPOSER-HELD binding for one registered ACTION tool. The brain supplies only the DECLARED params
 * (validated by `argSchema`); the composer fixes the `service`/`method` (the API endpoint — NEVER
 * brain-supplied, so there is no retarget surface), how params become the structured `params` body
 * (`toParams`), an OPTIONAL placeholder credential env (`toCredentialEnv`), and a REQUIRED
 * `actionProjector` that emits ONLY safe-derived governance fields.
 */
export interface ActionBinding {
  /** Composer-fixed API service (e.g. "gmail", "drive"). NEVER brain-supplied. */
  readonly service: string;
  /** Composer-fixed API method (e.g. "send", "read"). NEVER brain-supplied. */
  readonly method: string;
  /**
   * STRICT schema for the brain's DECLARED params. `.strict()` (no unknown keys) is REQUIRED: a smuggled
   * extra channel (a `bcc`, a raw `params`) must fail validation, so it can never reach the connector.
   */
  readonly argSchema: z.ZodType<unknown>;
  /**
   * Build the structured `params` body from the VALIDATED params. PURE: returns a plain record — never a
   * command string, never argv. The ONE place the descriptor's params are assembled.
   */
  readonly toParams: (validatedArgs: unknown) => Record<string, unknown>;
  /**
   * OPTIONAL composer-built credential env (placeholder strings ONLY — `placeholderForKey(KEY)`). A raw
   * secret here is rejected by the credential-blind INPUT guard BEFORE any invoke — the connector never
   * sees it. Returns a `{ KEY -> placeholder }` map; absent => no credential env.
   */
  readonly toCredentialEnv?: (validatedArgs: unknown) => Readonly<Record<string, string>>;
  /**
   * REQUIRED tool-declared governance projector. PURE: VALIDATED args -> a credential-blind
   * {@link GovernanceProjection} carrying ONLY safe-derived fields (operationClass / networkHosts =
   * composer-fixed provider host / destructiveFlags) — NEVER the params. (Stricter than the exec
   * argvRedacted: not even a local AGT sees a param value.) Never given raw args —
   * `buildActionProjectionForCall` validates with `argSchema` first.
   */
  readonly actionProjector: (validatedArgs: unknown) => GovernanceProjection;
}

/**
 * The structured descriptor the {@link ActionConnector} receives — built in ONE place by
 * `bindingWrappedActionEffect`. `service`/`method` are composer-fixed; `params` is the `toParams` body;
 * `env?` is the OPTIONAL placeholder credential env. NO command string, NO argv — a structured call.
 */
export interface ActionDescriptor {
  readonly service: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly env?: Readonly<Record<string, string>>;
}

/** The canned result an {@link ActionConnector} returns — structurally compatible with EffectResult. */
export interface ActionResult {
  readonly ok: boolean;
  readonly detail?: string;
  readonly tokensUsed?: number;
}

/**
 * The ACTION port (the sibling of the exec substrate). An implementation TURNS a structured descriptor
 * into a real API call. ACT1 ships ONLY the in-repo {@link FakeActionConnector}; the real MCP/OAuth
 * connector is deploy/EXEC2/ACT3-gated. The connector NEVER sees raw brain args — only the validated,
 * credential-blind descriptor the effect builds.
 */
export interface ActionConnector {
  invoke(context: unknown, descriptor: ActionDescriptor): MaybePromise<ActionResult>;
}

/** Options for {@link bindingWrappedActionEffect}. */
export interface BindingWrappedActionEffectOptions {
  /** Secret detector for the credential-blind INPUT guard. Defaults to the `redactSecrets`-changed test. */
  readonly detectSecret?: ExecSecretDetector;
}

/** A canned result for the Fake (override via the constructor to script a deny/ok). */
const DEFAULT_FAKE_RESULT: ActionResult = { ok: true, detail: "fake action ok" };

/**
 * In-repo {@link ActionConnector} test double (the mandatory in-tree substrate, modeled on
 * FakeSandboxAdapter): RECORDS every `(context, descriptor)` it receives and returns a canned
 * {@link ActionResult}. NO real network / OAuth / MCP — a pure in-memory record so the in-repo join can
 * prove the governance edge without a live API.
 */
export class FakeActionConnector implements ActionConnector {
  readonly invokeCalls: { context: unknown; descriptor: ActionDescriptor }[] = [];
  private readonly canned: ActionResult;

  constructor(canned: ActionResult = DEFAULT_FAKE_RESULT) {
    this.canned = canned;
  }

  invoke(context: unknown, descriptor: ActionDescriptor): ActionResult {
    this.invokeCalls.push({ context, descriptor });
    return this.canned;
  }
}

/** The shape the wrapper governs — a proposal carrying the brain's DECLARED args (NOT a descriptor). */
interface BoundActionCall {
  readonly tool: string;
  readonly context: unknown;
  readonly args?: Record<string, unknown>;
}

/**
 * Wrap an {@link ActionConnector} with the binding seam — the STRUCTURAL TWIN of
 * `bindingWrappedExecEffect`. The returned function is the pipeline's injected `effect`. It NEVER lets the
 * brain's raw args become a `service`/`method`/descriptor: those are built ONLY from the binding.
 *
 * Fail-closed at every gate, BEFORE the connector:
 *   - no binding for the tool        => `{ok:false}`; `connector.invoke` NOT called (deny-by-default);
 *   - invalid args (strict schema)   => `{ok:false}`; NOT called;
 *   - a LITERAL secret in params/env => `{ok:false}`; NOT called (credential-blind INPUT guard).
 * Only a fully validated, credential-blind proposal builds the descriptor and reaches `connector.invoke`.
 */
export function bindingWrappedActionEffect(
  connector: ActionConnector,
  bindings: ReadonlyMap<string, ActionBinding>,
  opts: BindingWrappedActionEffectOptions = {},
): (toolCall: BoundActionCall) => Promise<EffectResult> {
  const detectSecret = opts.detectSecret ?? defaultExecSecretDetector;

  return async (toolCall: BoundActionCall): Promise<EffectResult> => {
    try {
      // (a) deny-by-default: a tool with no composer binding NEVER invokes (parallel to the registry).
      const binding = bindings.get(toolCall.tool);
      if (binding === undefined) {
        return { ok: false, detail: `no action binding for ${toolCall.tool} (deny-by-default)` };
      }

      // (b) STRICT validation of the brain's DECLARED args. Unknown/extra/missing key => deny; the
      // connector is NEVER reached. A smuggled extra channel (bcc, raw params) fails here.
      const parsed = binding.argSchema.safeParse(toolCall.args ?? {});
      if (!parsed.success) {
        return { ok: false, detail: "invalid action args (deny)" };
      }
      const validated = parsed.data;

      // Build the descriptor in ONE place — service/method are composer-fixed; params is the toParams
      // body; env (when present) is the OPTIONAL placeholder credential env. A throwing builder is
      // fail-closed (deny), never an unbounded crash to the loop.
      let params: Record<string, unknown>;
      let env: Readonly<Record<string, string>> | undefined;
      try {
        params = binding.toParams(validated);
        env = binding.toCredentialEnv?.(validated);
      } catch {
        return { ok: false, detail: "action binding build error (deny)" };
      }

      // (c) CREDENTIAL-BLIND INPUT guard — the SAME recursive `defaultExecSecretDetector` the exec env
      // guard uses. A LITERAL secret in any nested field => fail-closed deny; the connector is NEVER
      // reached. Fail-closed: a detector THROW is treated as "secret present" (deny).
      //   - PARAMS: screen the whole structure (recursively). The param KEYS are composer-declared field
      //     names (to/subject/body/fileId) — never secret-key-shaped — so only a secret VALUE (the actual
      //     threat) trips it; a nested secret is caught by the recursion.
      //   - ENV: screen each VALUE (not the env OBJECT), EXACTLY as makeExecEffect does. The env map KEY is
      //     the operator's configured credential KEY (which may legitimately contain "token"/"key"); the
      //     by-KEY scrub must NOT false-positive a placeholder VALUE because of its key name. Only the VALUE
      //     (the placeholder, never a literal secret here) is the credential-blind subject.
      let flagged: boolean;
      try {
        flagged = detectSecret(params);
        if (!flagged && env !== undefined) {
          for (const value of Object.values(env)) {
            if (detectSecret(value)) {
              flagged = true;
              break;
            }
          }
        }
      } catch {
        flagged = true;
      }
      if (flagged) {
        return {
          ok: false,
          detail:
            "credential-blind: raw secret in action params/env — use a placeholder, not a literal",
        };
      }

      // (d) delegate to the connector with the validated, credential-blind descriptor.
      const descriptor: ActionDescriptor = {
        service: binding.service,
        method: binding.method,
        params,
        ...(env !== undefined ? { env } : {}),
      };
      const result = await connector.invoke(toolCall.context, descriptor);
      return {
        ok: result.ok,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
        ...(result.tokensUsed !== undefined ? { tokensUsed: result.tokensUsed } : {}),
      };
    } catch {
      // The effect must never throw across the pipeline boundary — fail closed.
      return { ok: false, detail: "action effect error (fail-closed)" };
    }
  };
}
