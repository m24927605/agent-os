/**
 * SLICE-ACT5d — the REAL-BROWSER {@link BrowserConnector} built over a STRUCTURAL {@link BrowserPage}
 * interface. This module imports NO browser library: it maps a governed {@link BrowserStep} onto the
 * minimal page surface a real headless browser exposes, so it is fully testable with a FAKE page (NO
 * real browser / network / dep). The REAL headless browser is adapted to this `BrowserPage` ONLY in
 * the operator runner (scripts/act5-live-browser.mjs), which dynamic-imports the browser library and
 * fail-closes if it is absent. verify therefore stays ZERO-new-dep + browser-free.
 *
 * (⚠️ This source must not name the browser library — the connector-test greps the source to PROVE it
 * is browser-free; the library name lives ONLY in the .mjs runner's dynamic import.)
 *
 * The connector is a DROP-IN sibling of {@link FakeBrowserConnector}: it implements the same
 * {@link BrowserConnector} contract AND the structural session-lifecycle methods
 * (`openSession`/`closeSession`/`hasSession`) the governed pipeline + the browser-join harness probe.
 * The brain still holds ONLY the opaque `sessionId`; the page handle lives here (the actor side).
 *
 * The step -> page-method mapping (each primitive is one page call):
 *   - navigate -> `page.goto(params.url)` — the egress is enforced UPSTREAM (the per-navigation egress
 *     fold) AND, in the real runner, by the substrate's route-interception (the PRIMARY network
 *     boundary: it aborts non-allowlisted hosts at the browser);
 *   - read     -> `page.content(params.selector?)` — returned RAW on {@link BrowserStepResult.content}.
 *     The EXISTING {@link bindingWrappedBrowserEffect} runs it through {@link returnContentSanitizer}
 *     (redact + bound + untrusted) BEFORE it reaches the brain; the connector does NOT re-sanitize;
 *   - click    -> `page.click(params.selector)`;
 *   - type     -> the text MAY be a credential PLACEHOLDER. It is resolved AT EGRESS via
 *     {@link resolveCredentialText} (the SINGLE last-mile materialization point, the actor side) and
 *     the RESOLVED value is handed to `page.fill(selector, resolved)` — it goes to the page ONLY and
 *     NEVER rides back on the result/WORM (credential-blind to the brain). An unresolvable placeholder
 *     => fail-closed `{ ok:false }` and `fill` is NOT called;
 *   - unknown primitive / unknown session => `{ ok:false }` (fail-closed, deny-by-default).
 *
 * Cohesion/coupling: lives in the hermes vendor-adapter zone alongside browser-closed-loop.ts; imports
 * ONLY the neutral orchestration `MaybePromise` type and the SIBLING browser port/types
 * (`BrowserConnector`, `BrowserStep`, `BrowserStepResult`, `resolveCredentialText`). NO vendor named in
 * core, NO new dependency, NO browser import.
 */
import type { MaybePromise } from "../../../../orchestration/index.js";
import {
  type BrowserConnector,
  type BrowserStep,
  type BrowserStepResult,
  resolveCredentialText,
} from "./browser-closed-loop.js";

/**
 * The MINIMAL structural page surface the connector drives — the same shape a real headless-browser
 * page exposes (and that the operator runner adapts the real browser page to). PURELY structural: this
 * module never names a browser library, so the connector is browser-free at verify time.
 */
export interface BrowserPage {
  /** Navigate the page to `url`. */
  goto(url: string): Promise<void>;
  /** Return the page's text content (optionally scoped to `selector`). */
  content(selector?: string): Promise<string>;
  /** Click the element matching `selector`. */
  click(selector: string): Promise<void>;
  /** Fill the element matching `selector` with `text` (the EGRESS-resolved value for a credential). */
  fill(selector: string, text: string): Promise<void>;
  /** Close the page / its owning context (releases the session's browser state). */
  close(): Promise<void>;
}

/** Options for {@link createBrowserConnectorOverPage}. */
export interface BrowserConnectorOverPageOptions {
  /**
   * The env the connector resolves a `type` text PLACEHOLDER against AT EGRESS (the single last-mile
   * materialization point — mirrors the action transport's injected env). Held on the ACTOR side; the
   * resolved value goes to `page.fill` ONLY, never back to the brain/result/WORM. Defaults to an EMPTY
   * env (so a placeholder with no value fails closed). The operator runner passes `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The {@link BrowserConnector} surface PLUS the structural session-lifecycle methods the governed
 * pipeline + the browser-join harness probe (`openSession`/`closeSession`/`hasSession`). The page-backed
 * connector implements all of them, so it is a drop-in for {@link FakeBrowserConnector}.
 */
export interface PageBrowserConnector extends BrowserConnector {
  /** Open a session SERVER-SIDE; return ONLY the opaque id (the brain holds nothing else). */
  openSession(): string;
  /** Close a session (idempotent) and close its page. */
  closeSession(sessionId: string): void;
  /** True iff `sessionId` names a live server-held session. An unknown/malformed id => false. */
  hasSession(sessionId: string): boolean;
}

/** A cryptographically-opaque-ish session id (same grammar the SESSION_ID schema validates). */
function newSessionId(): string {
  const a = Math.random().toString(36).slice(2);
  const b = Math.random().toString(36).slice(2);
  const t = Date.now().toString(36);
  return `bsess_${a}${b}${t}`;
}

/**
 * Build a {@link PageBrowserConnector} that drives the given {@link BrowserPage}. For the demo / live
 * drive a SINGLE page backs the (one) session; the session map keeps the structural shape the pipeline
 * expects (and so a future multi-page connector slots in without a contract change). NO browser import.
 *
 * @param page the structural page (a FAKE in tests; the adapted real browser page in the runner).
 * @param opts `env` for the credential-blind type-egress resolution (defaults to empty => fail-closed).
 */
export function createBrowserConnectorOverPage(
  page: BrowserPage,
  opts: BrowserConnectorOverPageOptions = {},
): PageBrowserConnector {
  const env = opts.env ?? {};
  // The server-held session set. The single demo page backs whichever session is open; the map exists
  // so `hasSession` is a real gate (the brain may only drive a live, server-held session).
  const sessions = new Set<string>();

  function hasSession(sessionId: string): boolean {
    return typeof sessionId === "string" && sessionId.length > 0 && sessions.has(sessionId);
  }

  async function perform(_context: unknown, step: BrowserStep): Promise<BrowserStepResult> {
    // Fail-closed on an unknown session (defense-in-depth; the effect already gates this).
    if (!hasSession(step.sessionId)) {
      return { ok: false, detail: "unknown session (page connector)" };
    }
    try {
      if (step.primitive === "navigate") {
        const url = typeof step.params.url === "string" ? step.params.url : "";
        await page.goto(url);
        let currentHost = "";
        try {
          currentHost = new URL(url).hostname;
        } catch {
          currentHost = "";
        }
        return { ok: true, detail: "navigated (page)", currentHost };
      }
      if (step.primitive === "read") {
        // Return the page content RAW on `content`; the effect's returnContentSanitizer scrubs it
        // BEFORE the brain. (Do NOT sanitize here — the single sanitizer is in the effect.)
        const selector =
          typeof step.params.selector === "string" ? step.params.selector : undefined;
        const content = await page.content(selector);
        return { ok: true, content };
      }
      if (step.primitive === "click") {
        const selector = typeof step.params.selector === "string" ? step.params.selector : "";
        await page.click(selector);
        return { ok: true, detail: "clicked (page)" };
      }
      if (step.primitive === "type") {
        // EGRESS credential resolution — the ONE place a placeholder is materialized (the actor side).
        // The brain/effect saw ONLY the placeholder in `params.text`; the resolved value goes to the
        // page (fill) and NEVER rides back on the result.
        const selector = typeof step.params.selector === "string" ? step.params.selector : "";
        const text = typeof step.params.text === "string" ? step.params.text : "";
        const resolved = resolveCredentialText(text, env);
        if ("error" in resolved) {
          // FAIL-CLOSED: the placeholder could not be resolved => fill NOTHING (static reason only).
          return {
            ok: false,
            detail: "type: credential could not be resolved (page, fail-closed)",
          };
        }
        await page.fill(selector, resolved.text);
        // The detail is a STATIC marker — it NEVER echoes the resolved value (credential-blind).
        return { ok: true, detail: "typed (page)" };
      }
      // Unknown primitive => deny-by-default (fail-closed); no page method invoked.
      return { ok: false, detail: "unknown browser primitive (page connector, deny)" };
    } catch {
      // The connector must never throw across the effect boundary — fail closed.
      return { ok: false, detail: "page connector error (fail-closed)" };
    }
  }

  const connector: PageBrowserConnector = {
    openSession(): string {
      const id = newSessionId();
      sessions.add(id);
      return id;
    },
    closeSession(sessionId: string): void {
      if (sessions.delete(sessionId)) {
        // Release the page state on close (idempotent; swallow any close error — fail-closed cleanup).
        void Promise.resolve(page.close()).catch(() => undefined);
      }
    },
    hasSession,
    perform: (context: unknown, step: BrowserStep): MaybePromise<BrowserStepResult> =>
      perform(context, step),
  };
  return connector;
}
