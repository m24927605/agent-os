/**
 * SLICE-ACT5a+b — the BROWSER sub-family port: a DISTINCT, STATEFUL, screen-driven governed UI binding,
 * sibling to the (stateless, single-shot) `ActionBinding` family (action-closed-loop.ts) and the exec
 * family. It does NOT modify either — it PARALLELS the ActionBinding pattern.
 *
 * WHY a distinct sub-family (ACT5 phase design): a browser TASK is a SEQUENCE of UI interactions whose
 * next step depends on what the prior step rendered — the next step's params are not known at proposal
 * time. So instead of one PURE descriptor (gmail/drive), EACH browser primitive (navigate/read/…) is a
 * strict-schema, projector-carrying governed action that RE-ENTERS `runGovernedToolCall` on its own. A
 * browser task = a string of "per-step-governed" actions over a SERVER-HELD session.
 *
 * SESSION DISCIPLINE (the moat): the brain holds ONLY an opaque `sessionId` (a reference). The raw
 * browser handle, cookies, and login state live in the {@link BrowserConnector} (the actor side, a
 * sandboxed headless browser at deploy — ACT5d). The brain NEVER receives a handle/cookie; an
 * unknown/malformed sessionId is a fail-closed DENY (the effect never calls the connector).
 *
 * Two seal-relevant gates ACT5a+b adds on top of the shared pipeline:
 *   - `browser.navigate` is NETWORK-EGRESS: its host is BRAIN-SUPPLIED (like net.fetch, unlike gmail), so
 *     its projector emits `networkHosts=[new URL(url).hostname]` and the PER-NAVIGATION egress fold gates
 *     it (deny-all default). The url is validated by the IDENTICAL `isAllowedFetchUrl` net.fetch uses.
 *   - `browser.read` returns PAGE CONTENT to the (untrusted) brain — a NEW data-OUT channel. The
 *     {@link returnContentSanitizer} (the dual of the credential-blind INPUT guard) is applied to the
 *     connector's content BEFORE it reaches the brain: redactSecrets -> size-bound -> mark untrusted.
 *
 * The SAME three fail-closed gates as the action twin, BEFORE the connector, plus an UNKNOWN-SESSION gate:
 *   (a) no binding for the tool        => deny; `connector.perform` NOT called;
 *   (a') unknown/malformed sessionId   => deny; NOT called (the brain may not drive a phantom session);
 *   (b) strict `argSchema` fail        => deny; NOT called (a smuggled extra key cannot pass);
 *   (c) credential-blind INPUT guard   => the SAME `defaultExecSecretDetector` over the built params; a
 *       LITERAL secret => deny; NOT called.
 *
 * HONEST BOUNDARY: fake browser, NO real browser / network / ~/.env. The real sandboxed Chromium is
 * ACT5d (deploy-gated). The read host-allowlist relies on navigate's egress-gate + the substrate's REAL
 * network boundary (redirects/embeds) as the PRIMARY line; `redactSecrets` is best-effort, so the
 * host-allowlist is the primary defense and redact/bound/untrusted are layered on top. NOT advertised to
 * the brain yet (ACT5e).
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside action-closed-loop.ts; imports
 * ONLY `zod` (type), the neutral orchestration types (`EffectResult`, `MaybePromise`), the neutral
 * `GovernanceProjection`, the substrate `ExecSecretDetector` contract, and the `audit` barrel's
 * `redactSecrets`. No vendor named, no deep cross-module import.
 */
import type { z } from "zod";
import { redactSecrets } from "../../../../audit/index.js";
import type { EffectResult, MaybePromise } from "../../../../orchestration/index.js";
import type { GovernanceProjection } from "../../../../policy/index.js";
import { type ExecSecretDetector, defaultExecSecretDetector } from "../../../substrate/index.js";

/** The default size bound for `browser.read` content returned to the brain (8 KiB). */
export const DEFAULT_READ_MAX_BYTES = 8192;

/** A primitive the browser sub-family understands. ACT5a+b ships navigate + read (click/type = ACT5c). */
export type BrowserPrimitive = "navigate" | "read";

/**
 * One step the {@link BrowserConnector} performs against a SERVER-HELD session. The brain holds ONLY the
 * `sessionId` (a reference) — never a raw handle. `params` is the VALIDATED, credential-blind param body
 * the binding built (the connector never sees raw brain args).
 */
export interface BrowserStep {
  readonly sessionId: string;
  readonly primitive: BrowserPrimitive;
  readonly params: Record<string, unknown>;
}

/**
 * The result one step yields. `content` (read only) is the RAW page content the actor read — it is run
 * through {@link returnContentSanitizer} by the effect BEFORE it can reach the brain. `currentHost` is a
 * host-only marker (never a full url/path) for the actor's own bookkeeping; it is NOT surfaced to the
 * brain or the WORM by the effect.
 */
export interface BrowserStepResult {
  readonly ok: boolean;
  readonly detail?: string;
  readonly content?: string;
  readonly currentHost?: string;
}

/**
 * The BROWSER port (the stateful actor). An implementation drives a real sandboxed browser session. ACT5
 * ships ONLY the in-repo {@link FakeBrowserConnector}; the real headless-Chromium connector is
 * deploy-gated (ACT5d). The connector NEVER returns a raw handle/cookies — only the {@link BrowserStepResult}.
 */
export interface BrowserConnector {
  perform(context: unknown, step: BrowserStep): MaybePromise<BrowserStepResult>;
}

/** The sanitized, brain-facing shape a `browser.read` content goes through (the data-OUT gate output). */
export interface SanitizedContent {
  /** The redacted + size-bounded content. */
  readonly content: string;
  /** True iff the content was cut to fit `maxBytes`. */
  readonly truncated: boolean;
  /** ALWAYS true: page content is untrusted DATA, never instruction (mitigates injection-IN). */
  readonly untrusted: true;
}

/**
 * The return-content SANITIZER — the data-OUT gate, the DUAL of the credential-blind INPUT guard. PURE +
 * TESTABLE. Applied to a `browser.read` content BEFORE it reaches the brain:
 *   1. `redactSecrets(raw)` — scrub known-shape secrets (sk-/ya29./AIza/Bearer/JWT/…). BEST-EFFORT (a
 *      non-shape secret/PII may survive — hence the host-allowlist is the PRIMARY line, this is layered).
 *   2. size-bound — truncate to `maxBytes` (default {@link DEFAULT_READ_MAX_BYTES}); `truncated:true` if cut.
 *   3. mark `untrusted:true` — the downstream knows this is page DATA, not an instruction.
 *
 * NON-VACUITY: a mutation that skips step 1 lets a page canary survive (the read-canary test FLIPS RED).
 */
export function returnContentSanitizer(
  raw: string,
  opts: { maxBytes?: number } = {},
): SanitizedContent {
  const maxBytes = opts.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  // (1) redact known-shape secrets FIRST (so a secret near the cut boundary is scrubbed before slicing).
  const redacted = redactSecrets(raw);
  // (2) size-bound. We bound by CODE-UNIT length (a conservative upper bound on byte length for the
  //     ASCII-dominant page text this fake handles); a real connector would bound by UTF-8 bytes.
  const truncated = redacted.length > maxBytes;
  const content = truncated ? redacted.slice(0, maxBytes) : redacted;
  // (3) always mark untrusted.
  return { content, truncated, untrusted: true };
}

/**
 * The COMPOSER-HELD binding for one registered BROWSER primitive (the twin of `ActionBinding`). The brain
 * supplies only the DECLARED params (validated by `argSchema`); the composer fixes the `primitive`, how
 * params become the structured `params` body (`toParams`), and a REQUIRED `governanceProjector` emitting
 * ONLY safe-derived fields (host-only networkHosts for navigate; none for read).
 */
export interface BrowserBinding {
  /** Composer-fixed browser primitive. NEVER brain-supplied. */
  readonly primitive: BrowserPrimitive;
  /** STRICT schema for the brain's DECLARED params. `.strict()` REQUIRED (a smuggled key must fail). */
  readonly argSchema: z.ZodType<unknown>;
  /** Build the structured `params` body from VALIDATED params. PURE: a plain record, never argv/script. */
  readonly toParams: (validatedArgs: unknown) => Record<string, unknown>;
  /**
   * REQUIRED governance projector. PURE: VALIDATED args -> a credential-blind {@link GovernanceProjection}
   * (host-only networkHosts for navigate so the egress fold gates it; NEVER the params). Never given raw
   * args — `buildBrowserProjectionForCall` validates with `argSchema` first.
   */
  readonly governanceProjector: (validatedArgs: unknown) => GovernanceProjection;
}

/** Options for {@link bindingWrappedBrowserEffect}. */
export interface BindingWrappedBrowserEffectOptions {
  /** Secret detector for the credential-blind INPUT guard. Defaults to `defaultExecSecretDetector`. */
  readonly detectSecret?: ExecSecretDetector;
  /** Max bytes for the `browser.read` data-OUT sanitizer. Defaults to {@link DEFAULT_READ_MAX_BYTES}. */
  readonly readMaxBytes?: number;
}

/** A cryptographically-opaque-ish session id. Server-generated; the brain treats it as a black box. */
function newSessionId(): string {
  // No new dep: a high-entropy opaque id from two Math.random draws + a monotonic-ish time component.
  // (A real connector would use crypto.randomUUID; the FAKE only needs opacity + unguessability-in-test.)
  const a = Math.random().toString(36).slice(2);
  const b = Math.random().toString(36).slice(2);
  const t = Date.now().toString(36);
  return `bsess_${a}${b}${t}`;
}

/** A live session held SERVER-SIDE. The brain never sees this object — only its opaque id. */
interface FakeSession {
  currentUrl?: string;
}

/** Options to script the {@link FakeBrowserConnector}. */
export interface FakeBrowserConnectorOptions {
  /** The canned content `read` returns (tests inject content with a canary secret / over-long string). */
  readonly content?: string;
  /** A secret cookie/handle the connector holds — used to PROVE it never leaks to the brain/WORM. */
  readonly cookieSecret?: string;
}

/**
 * In-repo {@link BrowserConnector} test double — a SERVER-HELD session map (`sessionId -> {currentUrl}`).
 * `navigate` records the url + returns ok; `read` returns the constructor-configured canned `content`.
 * It RECORDS every step (an in-memory audit trace) but NEVER exposes a raw handle/cookies on its public
 * surface — the `cookieSecret` it holds is reachable ONLY via `peekCookieSecret()` (a TEST probe, never a
 * brain channel). NO real network / browser. `perform` on an unknown sessionId is fail-closed (ok:false).
 */
export class FakeBrowserConnector implements BrowserConnector {
  /** Every step the connector received (an auditable in-memory trace, NOT a handle/cookie surface). */
  readonly steps: BrowserStep[] = [];
  private readonly sessions = new Map<string, FakeSession>();
  private readonly canned: string;
  private readonly cookieSecret: string;

  constructor(opts: FakeBrowserConnectorOptions = {}) {
    this.canned = opts.content ?? "fake page content";
    this.cookieSecret = opts.cookieSecret ?? "fake-cookie-do-not-leak";
  }

  /** Open a session SERVER-SIDE; return ONLY the opaque id (the brain holds nothing else). */
  openSession(): string {
    const id = newSessionId();
    this.sessions.set(id, {});
    return id;
  }

  /** Close a session (idempotent). */
  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** True iff `sessionId` names a live server-held session. An unknown/malformed id => false. */
  hasSession(sessionId: string): boolean {
    return typeof sessionId === "string" && sessionId.length > 0 && this.sessions.has(sessionId);
  }

  /** TEST-ONLY probe of the held cookie secret — to assert it NEVER appears in a brain/WORM channel. */
  peekCookieSecret(): string {
    return this.cookieSecret;
  }

  perform(_context: unknown, step: BrowserStep): BrowserStepResult {
    // Fail-closed on an unknown session (defense-in-depth; the effect already gates this).
    if (!this.hasSession(step.sessionId)) {
      return { ok: false, detail: "unknown session (fake)" };
    }
    this.steps.push(step);
    const session = this.sessions.get(step.sessionId) as FakeSession;
    if (step.primitive === "navigate") {
      const url = typeof step.params.url === "string" ? step.params.url : "";
      session.currentUrl = url;
      let currentHost = "";
      try {
        currentHost = new URL(url).hostname;
      } catch {
        currentHost = "";
      }
      return { ok: true, detail: "navigated (fake)", currentHost };
    }
    // read — return the canned page content (the EFFECT sanitizes it before the brain sees it).
    return { ok: true, content: this.canned };
  }
}

/** The shape the wrapper governs — a proposal carrying the brain's DECLARED args (NOT a step). */
interface BoundBrowserCall {
  readonly tool: string;
  readonly context: unknown;
  readonly args?: Record<string, unknown>;
}

/** Extract a brain-supplied `sessionId` from raw args (a string field), or `undefined`. */
function readSessionId(args: Record<string, unknown> | undefined): string | undefined {
  const sid = args?.sessionId;
  return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

/**
 * Wrap a {@link BrowserConnector} with the binding seam — the STRUCTURAL TWIN of
 * `bindingWrappedActionEffect`, plus an UNKNOWN-SESSION gate and the read data-OUT sanitizer. The returned
 * function is the pipeline's injected `effect`.
 *
 * Fail-closed at every gate, BEFORE the connector:
 *   - no binding for the tool        => deny; `connector.perform` NOT called (deny-by-default);
 *   - unknown/malformed sessionId    => deny; NOT called (no driving a phantom session);
 *   - invalid args (strict schema)   => deny; NOT called;
 *   - a LITERAL secret in params     => deny; NOT called (credential-blind INPUT guard).
 * On the executed path, for `read`, the connector's `content` is run through {@link returnContentSanitizer}
 * and the SANITIZED shape (redacted + bounded + untrusted) is serialized into `detail` — the ONLY channel
 * the brain sees the content on. The raw content NEVER rides `detail`.
 */
export function bindingWrappedBrowserEffect(
  connector: BrowserConnector,
  bindings: ReadonlyMap<string, BrowserBinding>,
  opts: BindingWrappedBrowserEffectOptions = {},
): (toolCall: BoundBrowserCall) => Promise<EffectResult> {
  const detectSecret = opts.detectSecret ?? defaultExecSecretDetector;
  const readMaxBytes = opts.readMaxBytes ?? DEFAULT_READ_MAX_BYTES;

  return async (toolCall: BoundBrowserCall): Promise<EffectResult> => {
    try {
      // (a) deny-by-default: a tool with no composer binding NEVER performs.
      const binding = bindings.get(toolCall.tool);
      if (binding === undefined) {
        return { ok: false, detail: `no browser binding for ${toolCall.tool} (deny-by-default)` };
      }

      // (a') UNKNOWN-SESSION gate: the brain may only drive a live, server-held session. A missing /
      // malformed sessionId, or one the connector does not hold, is a fail-closed deny — the connector's
      // `perform` is NEVER called (no phantom-session driving). We read the sessionId from the RAW args
      // (it is a declared field on every browser primitive's schema) and probe the connector via the
      // structural `hasSession` capability when present (the Fake exposes it; a real one would too).
      const sessionId = readSessionId(toolCall.args);
      if (sessionId === undefined) {
        return { ok: false, detail: "browser: missing/malformed sessionId (deny)" };
      }
      const hasSession = (connector as { hasSession?: (id: string) => boolean }).hasSession;
      if (typeof hasSession === "function" && !hasSession.call(connector, sessionId)) {
        return { ok: false, detail: "browser: unknown session (deny)" };
      }

      // (b) STRICT validation of the brain's DECLARED args. Unknown/extra/missing key => deny.
      const parsed = binding.argSchema.safeParse(toolCall.args ?? {});
      if (!parsed.success) {
        return { ok: false, detail: "invalid browser args (deny)" };
      }
      const validated = parsed.data;

      // Build the params body in ONE place (the toParams). A throwing builder is fail-closed.
      let params: Record<string, unknown>;
      try {
        params = binding.toParams(validated);
      } catch {
        return { ok: false, detail: "browser binding build error (deny)" };
      }

      // (c) CREDENTIAL-BLIND INPUT guard — the SAME recursive detector the exec/action guards use. A
      // LITERAL secret in any nested param field => fail-closed deny; the connector is NEVER reached. A
      // detector THROW is treated as "secret present" (deny).
      let flagged: boolean;
      try {
        flagged = detectSecret(params);
      } catch {
        flagged = true;
      }
      if (flagged) {
        return {
          ok: false,
          detail:
            "credential-blind: raw secret in browser params — use a placeholder, not a literal",
        };
      }

      // (d) delegate to the connector with the validated, credential-blind step.
      const step: BrowserStep = { sessionId, primitive: binding.primitive, params };
      const result = await connector.perform(toolCall.context, step);

      // (e) READ DATA-OUT GATE: for `read`, the connector's content is run through the sanitizer BEFORE it
      // reaches the brain. The sanitized shape (redacted + bounded + untrusted) is the brain-facing detail;
      // the raw content NEVER rides `detail`. (NON-VACUITY: skipping this step leaks a page canary.)
      if (binding.primitive === "read") {
        const sanitized = returnContentSanitizer(result.content ?? "", { maxBytes: readMaxBytes });
        return { ok: result.ok, detail: JSON.stringify(sanitized) };
      }

      // navigate (and any non-read step): surface ONLY the connector's own ok + safe detail. We do NOT
      // surface `currentHost`/`currentUrl` — the brain learns nothing about the session's location here.
      return {
        ok: result.ok,
        ...(result.detail !== undefined ? { detail: result.detail } : {}),
      };
    } catch {
      // The effect must never throw across the pipeline boundary — fail closed.
      return { ok: false, detail: "browser effect error (fail-closed)" };
    }
  };
}
