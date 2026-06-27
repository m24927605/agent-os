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

/**
 * A primitive the browser sub-family understands. ACT5a+b: navigate + read; ACT5c adds click + type; ACT5f
 * adds the GOVERNED SESSION LIFECYCLE: `session.open` (MINT a server-held session, return its opaque
 * id) + `session.close` (release a session — idempotent). The lifecycle primitives let a brain bootstrap a
 * sessionId end-to-end (open -> navigate -> … -> close), each step governed; the moat is unchanged (the
 * brain receives ONLY the opaque id, never the handle/cookies).
 */
export type BrowserPrimitive =
  | "navigate"
  | "read"
  | "click"
  | "type"
  | "session.open"
  | "session.close";

/**
 * The credential placeholder grammar the BROWSER connector resolves at EGRESS — OpenShell's
 * `openshell:resolve:env:<KEY>` (the SAME contract `resolveCredentialHeaders` resolves for the action
 * transport). A LOCAL constant copy (NOT imported) so the adapter never deep-imports a non-barrel
 * internal; this string IS the cross-boundary contract.
 */
const PLACEHOLDER_PREFIX = "openshell:resolve:env:";

/** The successful `resolveCredentialText` result — the materialized text the connector would type. */
export interface ResolvedText {
  readonly text: string;
}

/** The fail-closed `resolveCredentialText` result — a STATIC reason (NEVER a resolved/env-derived value). */
export interface ResolveTextError {
  readonly error: string;
}

/**
 * Resolve a credential PLACEHOLDER in a `type` text against `env` — PURE, NO network, the dual of
 * `resolveCredentialHeaders` for the browser family. This is the SINGLE last-mile materialization point;
 * it runs ONLY at the connector (the actor) at EGRESS, NEVER in the brain/effect path:
 *   - a text that IS `openshell:resolve:env:<KEY>` is resolved: `env[KEY]` must be a NON-EMPTY string,
 *     else => {@link ResolveTextError} (FAIL-CLOSED — the connector must NOT type a phantom value).
 *   - a NON-placeholder text passes through VERBATIM.
 *
 * CREDENTIAL-BLIND: the error reason is a STATIC string — it NEVER includes the KEY's value or any
 * env-derived text. The resolved value is the ACTOR's; it must NEVER ride back to the brain/result/WORM.
 */
export function resolveCredentialText(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedText | ResolveTextError {
  if (text.startsWith(PLACEHOLDER_PREFIX)) {
    const key = text.slice(PLACEHOLDER_PREFIX.length);
    const resolved = env[key];
    if (typeof resolved !== "string" || resolved.length === 0) {
      // FAIL-CLOSED: a missing/empty env value => error (static reason; NEVER echo the value/KEY).
      return { error: "credential placeholder could not be resolved from env (fail-closed)" };
    }
    return { text: resolved };
  }
  return { text };
}

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
  /**
   * ACT5f — set ONLY by a successful `session.open`: the freshly-MINTED opaque session id (the brain's new
   * reference). It is the ONLY thing `session.open` surfaces — NEVER the handle/cookies/url. The effect
   * (`bindingWrappedBrowserEffect`) reads it and returns it to the brain so the brain can drive the rest of
   * the task on this session. A cap-exhausted `session.open` returns `ok:false` with NO `sessionId`.
   */
  readonly sessionId?: string;
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

/** The default cap on concurrently-open sessions a connector will hold (fail-closed exhaustion guard). */
export const DEFAULT_BROWSER_SESSION_CAP = 8;

/**
 * A cryptographically-opaque-ish session id. Server-generated; the brain treats it as a black box.
 *
 * ⚠️ TEST-ONLY id-gen: the FAKE uses `Math.random` for opacity + in-test unguessability ONLY. The CONTRACT
 * requires the REAL connector (ACT5d page connector) to mint with `crypto.randomUUID` (it already does) so
 * a compromised brain cannot GUESS a phantom sessionId. The shape (`bsess_` + url-safe chars) matches the
 * strict `SESSION_ID` schema the bindings validate; the unknown-session gate denies any id never minted.
 */
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
  /**
   * The env the connector resolves `type` text PLACEHOLDERS against AT EGRESS (mirrors the action
   * transport's injected env). The Fake holds it on the ACTOR side; tests inject a runtime canary value
   * to PROVE the resolved value never rides back to the brain/WORM. Defaults to an EMPTY env (so a
   * placeholder with no value fails closed).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * ACT5f — the cap on concurrently-open sessions (fail-closed resource-exhaustion guard). A
   * `session.open` when the open count is AT the cap returns `ok:false` (deny — a compromised brain cannot
   * exhaust the connector by minting unbounded sessions). A `session.close` frees a slot. Defaults to
   * {@link DEFAULT_BROWSER_SESSION_CAP}. Injectable so a test can drive the cap with a small value.
   */
  readonly browserSessionCap?: number;
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
  private readonly env: Readonly<Record<string, string | undefined>>;
  /** ACT5f — the fail-closed cap on concurrently-open sessions (resource-exhaustion guard). */
  private readonly sessionCap: number;
  /**
   * The RESOLVED value the connector last "typed" at egress — the ACTOR's materialized credential. It is
   * reachable ONLY via {@link peekLastTyped} (a TEST probe, never a brain channel) and is NEVER pushed
   * into the {@link steps} trace (the step records the placeholder only). `undefined` until a type runs.
   */
  private lastTyped: string | undefined;

  constructor(opts: FakeBrowserConnectorOptions = {}) {
    this.canned = opts.content ?? "fake page content";
    this.cookieSecret = opts.cookieSecret ?? "fake-cookie-do-not-leak";
    this.env = opts.env ?? {};
    this.sessionCap = opts.browserSessionCap ?? DEFAULT_BROWSER_SESSION_CAP;
  }

  /**
   * Open a session SERVER-SIDE; return ONLY the opaque id (the brain holds nothing else). This is the
   * trusted server-side helper (uncapped — a test/operator opening sessions directly). The FAIL-CLOSED CAP
   * (resource-exhaustion guard) is enforced on the GOVERNED `session.open` primitive in {@link perform}
   * (via {@link atSessionCap}), so a brain-driven open is bounded while this helper stays simple.
   */
  openSession(): string {
    const id = newSessionId();
    this.sessions.set(id, {});
    return id;
  }

  /** True iff the connector is AT its session cap (the fail-closed exhaustion guard for `session.open`). */
  private atSessionCap(): boolean {
    return this.sessions.size >= this.sessionCap;
  }

  /** Close a session (idempotent — closing an unknown/already-closed id is a safe no-op). */
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

  /**
   * TEST-ONLY probe of the RESOLVED value the connector last "typed" at egress — to assert the actor's
   * materialized credential is what-it-would-type, while proving (in the brain/WORM blobs) it never
   * leaks back. `undefined` until a `type` step has run. NEVER a brain channel.
   */
  peekLastTyped(): string | undefined {
    return this.lastTyped;
  }

  perform(_context: unknown, step: BrowserStep): BrowserStepResult {
    // ACT5f — the GOVERNED SESSION LIFECYCLE primitives dispatch BEFORE the unknown-session gate (a
    // session.open has no live session yet — it MINTS one; a session.close is idempotent over an
    // unknown/already-closed id). They are NOT pushed onto `steps` as a navigation/UI step.
    if (step.primitive === "session.open") {
      // FAIL-CLOSED CAP: at the session cap => deny (NO sessionId surfaced). A close frees a slot. The
      // cap is checked on this GOVERNED primitive (a compromised brain cannot mint unbounded sessions).
      if (this.atSessionCap()) {
        return { ok: false, detail: "session cap reached (fake, fail-closed)" };
      }
      const id = this.openSession();
      return { ok: true, sessionId: id };
    }
    if (step.primitive === "session.close") {
      // Idempotent: closing an unknown/already-closed id is a safe ok no-op (frees a slot if present).
      const id = typeof step.params.sessionId === "string" ? step.params.sessionId : "";
      this.closeSession(id);
      return { ok: true, detail: "session closed (fake)" };
    }
    // Fail-closed on an unknown session (defense-in-depth; the effect already gates this). The lifecycle
    // primitives above are handled first, so this gate applies ONLY to navigate/read/click/type.
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
    if (step.primitive === "click") {
      // The step is already recorded (the auditable trace); a real connector would dispatch the click.
      // The actual network/UI effect is OPAQUE (substrate-enforced); the Fake just confirms ok.
      return { ok: true, detail: "clicked (fake)" };
    }
    if (step.primitive === "type") {
      // EGRESS credential resolution — the ONE place the placeholder is materialized (the actor side,
      // mirroring resolveCredentialHeaders). The brain/effect saw ONLY the placeholder in `params.text`.
      const text = typeof step.params.text === "string" ? step.params.text : "";
      const resolved = resolveCredentialText(text, this.env);
      if ("error" in resolved) {
        // FAIL-CLOSED: the placeholder could not be resolved => type NOTHING (lastTyped stays unset).
        return { ok: false, detail: "type: credential could not be resolved (fake, fail-closed)" };
      }
      // Record the RESOLVED value as what-it-would-type — reachable ONLY via peekLastTyped (a test probe).
      // It is NOT pushed into `this.steps` (the recorded step carries the placeholder only).
      this.lastTyped = resolved.text;
      return { ok: true, detail: "typed (fake)" };
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

      // ACT5f — the GOVERNED SESSION LIFECYCLE primitives are EXEMPT from the unknown-session gate:
      //   - `session.open` has NO sessionId yet — it MINTS one (a sessionId arg is not even in its schema);
      //   - `session.close` is idempotent — closing an unknown/already-closed id is a safe no-op ok.
      // For these, the connector's `perform` is reached after the strict-schema + credential-blind gates
      // (below). For navigate/read/click/type the unknown-session gate STILL fail-closes (no phantom-session
      // driving). `isLifecycle` keys PURELY on the composer-fixed primitive (NEVER brain-supplied).
      const isLifecycle =
        binding.primitive === "session.open" || binding.primitive === "session.close";

      // (a') UNKNOWN-SESSION gate: the brain may only DRIVE a live, server-held session. A missing /
      // malformed sessionId, or one the connector does not hold, is a fail-closed deny — the connector's
      // `perform` is NEVER called (no phantom-session driving). We read the sessionId from the RAW args
      // (it is a declared field on every DRIVING primitive's schema) and probe the connector via the
      // structural `hasSession` capability when present (the Fake exposes it; a real one would too).
      if (!isLifecycle) {
        const sessionId = readSessionId(toolCall.args);
        if (sessionId === undefined) {
          return { ok: false, detail: "browser: missing/malformed sessionId (deny)" };
        }
        const hasSession = (connector as { hasSession?: (id: string) => boolean }).hasSession;
        if (typeof hasSession === "function" && !hasSession.call(connector, sessionId)) {
          return { ok: false, detail: "browser: unknown session (deny)" };
        }
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

      // (d) delegate to the connector with the validated, credential-blind step. The step's `sessionId` is
      // read from the RAW args (a declared field on every DRIVING primitive's schema, and on session.close);
      // for `session.open` (which MINTS) there is no incoming id, so the step carries an empty reference
      // (the connector ignores it and returns the minted one).
      const step: BrowserStep = {
        sessionId: readSessionId(toolCall.args) ?? "",
        primitive: binding.primitive,
        params,
      };
      const result = await connector.perform(toolCall.context, step);

      // (e) READ DATA-OUT GATE: for `read`, the connector's content is run through the sanitizer BEFORE it
      // reaches the brain. The sanitized shape (redacted + bounded + untrusted) is the brain-facing detail;
      // the raw content NEVER rides `detail`. (NON-VACUITY: skipping this step leaks a page canary.)
      if (binding.primitive === "read") {
        const sanitized = returnContentSanitizer(result.content ?? "", { maxBytes: readMaxBytes });
        return { ok: result.ok, detail: JSON.stringify(sanitized) };
      }

      // ACT5f — SESSION.OPEN: surface the connector's freshly-MINTED opaque sessionId to the brain (its new
      // reference), and ONLY that — NEVER the handle/cookies/url/currentHost. The brain reads the id from
      // the detail and uses it in subsequent calls. A cap-exhausted open has `ok:false` + NO sessionId, so
      // the brain sees a non-mint (deny). The MOAT: `result.sessionId` is the sole field surfaced; the
      // connector NEVER puts a handle/cookie on the result, and we do not echo `currentHost`/`currentUrl`.
      if (binding.primitive === "session.open") {
        if (result.ok && typeof result.sessionId === "string") {
          return { ok: true, detail: `session opened: ${result.sessionId}` };
        }
        // Cap-exhausted / failed mint => deny (no session minted). Static reason; no id surfaced.
        return { ok: false, detail: "session.open denied (cap reached or unavailable)" };
      }

      // navigate / click / type / session.close (and any non-read step): surface ONLY the connector's own
      // ok + safe static detail. We do NOT surface `currentHost`/`currentUrl`/`sessionId` — the brain learns
      // nothing about the session's location or any minted handle here.
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
