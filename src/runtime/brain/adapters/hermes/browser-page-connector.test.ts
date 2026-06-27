/**
 * SLICE-ACT5d (RED-first) — UNIT tests for the REAL-BROWSER connector built over a STRUCTURAL
 * {@link BrowserPage} interface (`createBrowserConnectorOverPage`). NO playwright, NO real browser,
 * NO network: the page is a FAKE that records goto/click/fill calls and returns canned content.
 *
 * The connector maps each {@link BrowserStep}'s primitive onto a {@link BrowserPage} method:
 *   navigate -> page.goto(params.url)
 *   read     -> page.content(params.selector?)  (returned RAW as BrowserStepResult.content — the
 *               EXISTING bindingWrappedBrowserEffect applies returnContentSanitizer; the connector
 *               does NOT re-sanitize)
 *   click    -> page.click(params.selector)
 *   type     -> resolveCredentialText(params.text, env) AT EGRESS, then page.fill(selector, resolved)
 *   unknown  -> { ok: false } (fail-closed)
 *
 * The two CORE invariants under test (mirroring the Fake connector's, now over a real Page port):
 *   (A) READ-CANARY: a page canary returned by page.content() does NOT reach the brain — through the
 *       governed effect (bindingWrappedBrowserEffect) it is redacted/truncated/untrusted. NON-VACUITY:
 *       a mutation where read bypasses the sanitizer path flips this RED.
 *   (B) TYPE-EGRESS: a credential PLACEHOLDER text is resolved AT EGRESS so page.fill() receives the
 *       RESOLVED value, while the brain/result/WORM see ONLY the placeholder (the resolved canary
 *       never leaks). NON-VACUITY: passing the placeholder to fill un-resolved, OR leaking the
 *       resolved value to the result, flips the type test RED.
 *
 * ⚠️ This connector module must NOT import playwright (a grep assertion below proves it); the real
 * Chromium lives ONLY in scripts/act5-live-browser.mjs (dynamic-imported, fail-closed if absent).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type BrowserConnector,
  type BrowserStep,
  bindingWrappedBrowserEffect,
} from "./browser-closed-loop.js";
import { type BrowserPage, createBrowserConnectorOverPage } from "./browser-page-connector.js";
import {
  browserClickBinding,
  browserNavigateBinding,
  browserReadBinding,
  browserTypeBinding,
} from "./browser-seed-tools.js";

/** Runtime-built OpenAI-shape canary (matches audit/redact's `sk-...`). NOT a source literal. */
function skCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`;
}

const bindings = new Map([
  ["browser.navigate", browserNavigateBinding],
  ["browser.read", browserReadBinding],
  ["browser.click", browserClickBinding],
  ["browser.type", browserTypeBinding],
]);

/** The credential-placeholder grammar the connector resolves at egress (the cross-boundary contract). */
function placeholder(key: string): string {
  return `openshell:resolve:env:${key}`;
}

/**
 * A FAKE {@link BrowserPage} — records every goto/click/fill call and returns canned `content`. NO real
 * browser / network. It is the structural double for the real chromium page (which the .mjs adapts).
 */
class FakePage implements BrowserPage {
  readonly gotos: string[] = [];
  readonly clicks: string[] = [];
  readonly fills: { selector: string; text: string }[] = [];
  readonly contentSelectors: (string | undefined)[] = [];
  closed = false;
  private readonly canned: string;

  constructor(canned = "fake page content") {
    this.canned = canned;
  }

  goto(url: string): Promise<void> {
    this.gotos.push(url);
    return Promise.resolve();
  }

  content(selector?: string): Promise<string> {
    this.contentSelectors.push(selector);
    return Promise.resolve(this.canned);
  }

  click(selector: string): Promise<void> {
    this.clicks.push(selector);
    return Promise.resolve();
  }

  fill(selector: string, text: string): Promise<void> {
    this.fills.push({ selector, text });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

// ==================================================================================================
// createBrowserConnectorOverPage — the step -> page-method mapping (over a FAKE page).
// ==================================================================================================
describe("createBrowserConnectorOverPage — BrowserStep -> BrowserPage method mapping", () => {
  it("navigate -> page.goto(params.url) receives the url; returns ok", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page);
    const sid = conn.openSession();
    const step: BrowserStep = {
      sessionId: sid,
      primitive: "navigate",
      params: { url: "https://allowed.example/x" },
    };
    const res = await conn.perform({}, step);
    expect(res.ok).toBe(true);
    expect(page.gotos).toEqual(["https://allowed.example/x"]);
  });

  it("read -> page.content() is returned as BrowserStepResult.content (RAW; NOT re-sanitized here)", async () => {
    const page = new FakePage("the canned body");
    const conn = createBrowserConnectorOverPage(page);
    const sid = conn.openSession();
    const res = await conn.perform({}, { sessionId: sid, primitive: "read", params: {} });
    expect(res.ok).toBe(true);
    // The connector returns the page's content VERBATIM on `content`; the effect sanitizes it.
    expect(res.content).toBe("the canned body");
  });

  it("read with a selector forwards it to page.content(selector)", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page);
    const sid = conn.openSession();
    await conn.perform({}, { sessionId: sid, primitive: "read", params: { selector: "#main" } });
    expect(page.contentSelectors).toEqual(["#main"]);
  });

  it("click -> page.click(params.selector) receives the selector; returns ok", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page);
    const sid = conn.openSession();
    const res = await conn.perform(
      {},
      { sessionId: sid, primitive: "click", params: { selector: "#submit" } },
    );
    expect(res.ok).toBe(true);
    expect(page.clicks).toEqual(["#submit"]);
  });

  it("unknown primitive => { ok:false } (fail-closed); no page method invoked", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page);
    const sid = conn.openSession();
    const res = await conn.perform(
      {},
      // biome-ignore lint/suspicious/noExplicitAny: deliberately forge an unknown primitive.
      { sessionId: sid, primitive: "evil" as any, params: {} },
    );
    expect(res.ok).toBe(false);
    expect(page.gotos.length).toBe(0);
    expect(page.clicks.length).toBe(0);
    expect(page.fills.length).toBe(0);
  });

  it("perform on an unknown sessionId => ok:false (fail-closed; no page method invoked)", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page);
    const res = await conn.perform(
      {},
      { sessionId: "ghost", primitive: "navigate", params: { url: "https://allowed.example/x" } },
    );
    expect(res.ok).toBe(false);
    expect(page.gotos.length).toBe(0);
  });

  it("session lifecycle: open -> hasSession true; close -> page.close() + hasSession false", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page);
    const sid = conn.openSession();
    expect(conn.hasSession(sid)).toBe(true);
    expect(conn.hasSession("not-a-session")).toBe(false);
    conn.closeSession(sid);
    expect(conn.hasSession(sid)).toBe(false);
    expect(page.closed).toBe(true);
  });
});

// ==================================================================================================
// (B) TYPE-EGRESS — the credential placeholder is resolved AT EGRESS; fill gets the RESOLVED value;
// the brain/result never see it. (CORE; the dual of the read data-OUT gate.)
// ==================================================================================================
describe("createBrowserConnectorOverPage — type resolves the credential AT EGRESS (credential-blind)", () => {
  it("type with a placeholder => page.fill() receives the RESOLVED env value (not the placeholder)", async () => {
    const canary = skCanary(); // the ACTOR's materialized credential — must reach fill, NEVER the result.
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page, { env: { MY_SECRET: canary } });
    const sid = conn.openSession();
    const res = await conn.perform(
      {},
      {
        sessionId: sid,
        primitive: "type",
        params: { selector: "#pw", text: placeholder("MY_SECRET") },
      },
    );
    expect(res.ok).toBe(true);
    // fill got the RESOLVED value at egress…
    expect(page.fills).toEqual([{ selector: "#pw", text: canary }]);
    // …and the resolved value NEVER rides back on the result (credential-blind to the brain/WORM).
    const resultBlob = JSON.stringify(res);
    expect(resultBlob).not.toContain(canary);
    // NON-VACUITY: passing the PLACEHOLDER to fill un-resolved flips the `page.fills` expectation RED;
    // leaking the resolved value onto the result flips the resultBlob expectation RED.
  });

  it("type with an UNRESOLVABLE placeholder (empty env) => ok:false; page.fill NEVER called (fail-closed)", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page, { env: {} });
    const sid = conn.openSession();
    const res = await conn.perform(
      {},
      {
        sessionId: sid,
        primitive: "type",
        params: { selector: "#pw", text: placeholder("MISSING") },
      },
    );
    expect(res.ok).toBe(false);
    expect(page.fills.length).toBe(0);
  });

  it("type with a NON-placeholder text passes it through verbatim to fill", async () => {
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page, { env: {} });
    const sid = conn.openSession();
    const res = await conn.perform(
      {},
      { sessionId: sid, primitive: "type", params: { selector: "#q", text: "hello world" } },
    );
    expect(res.ok).toBe(true);
    expect(page.fills).toEqual([{ selector: "#q", text: "hello world" }]);
  });
});

// ==================================================================================================
// (A) READ-CANARY through the GOVERNED EFFECT — the page canary is sanitized before the brain.
// This wires the SAME bindingWrappedBrowserEffect over the page-backed connector (the runner's edge).
// ==================================================================================================
describe("createBrowserConnectorOverPage — read content sanitized by the governed effect (canary redacted)", () => {
  it("⚠️ read: a page CANARY is REDACTED + over-long body TRUNCATED + untrusted before the brain", async () => {
    const canary = skCanary();
    const page = new FakePage(`secret page: ${canary} ${"PAD".repeat(5000)}`);
    const conn = createBrowserConnectorOverPage(page);
    const sid = conn.openSession();
    const effect = bindingWrappedBrowserEffect(conn, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({ tool: "browser.read", context: {}, args: { sessionId: sid } });
    expect(out.ok).toBe(true);
    const seen = out.detail ?? "";
    expect(seen).not.toContain(canary);
    expect(seen).toContain("[REDACTED]");
    expect(seen).toContain("untrusted");
    expect(seen).toContain("truncated");
    // NON-VACUITY: a mutation where the connector pre-sanitizes/re-sanitizes is irrelevant — the
    // CONTROL is the effect's returnContentSanitizer; a mutation bypassing it (e.g. read returns raw
    // straight onto detail) flips this RED. The connector returns RAW content; the effect sanitizes.
  });

  it("⚠️ type through the effect: a placeholder text reaches fill RESOLVED; the WORM/result see only the placeholder", async () => {
    const canary = skCanary();
    const page = new FakePage();
    const conn = createBrowserConnectorOverPage(page, { env: { MY_SECRET: canary } });
    const sid = conn.openSession();
    const effect = bindingWrappedBrowserEffect(conn, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.type",
      context: {},
      args: { sessionId: sid, selector: "#pw", text: placeholder("MY_SECRET") },
    });
    expect(out.ok).toBe(true);
    // The page got the resolved credential at egress; the brain-facing result carries neither the
    // placeholder's resolved value nor the canary.
    expect(page.fills).toEqual([{ selector: "#pw", text: canary }]);
    expect(JSON.stringify(out)).not.toContain(canary);
  });
});

// ==================================================================================================
// ⚠️ DEP-FREE / BROWSER-FREE — the TS connector must NOT import playwright (a static-source grep).
// ==================================================================================================
describe("createBrowserConnectorOverPage — verify-time browser-free (no playwright import)", () => {
  it("the connector source does NOT name/import playwright (real Chromium is the .mjs runner only)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("./browser-page-connector.ts", import.meta.url)),
      "utf8",
    );
    expect(src).not.toMatch(/playwright/i);
    expect(src).not.toMatch(/chromium/i);
    expect(src).not.toMatch(/from\s+["']playwright/);
    expect(src).not.toMatch(/import\(["']playwright/);
  });
});

// Reference the port type so an unused-import lint never trips (it is part of the contract).
const _portTypeCheck: BrowserConnector = createBrowserConnectorOverPage(new FakePage());
void _portTypeCheck;
