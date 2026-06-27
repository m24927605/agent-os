/**
 * SLICE-ACT5a+b (RED-first) — UNIT tests for the BROWSER sub-family port + session + the
 * `returnContentSanitizer` (the data-OUT gate) + `bindingWrappedBrowserEffect` edge cases.
 *
 * NO real browser / network / ~/.env — a FakeBrowserConnector with a server-held session map. The
 * connector NEVER exposes a raw handle / cookies; the brain only ever sees the opaque sessionId.
 *
 * The CORE security property under test: a page CANARY secret (built at RUNTIME, never a source
 * literal) returned by the connector's `read` is NOT returned to the brain — it is redacted
 * (redactSecrets), truncated (size-bound), and marked untrusted by the sanitizer BEFORE it leaves
 * the effect. NON-VACUITY mutations are documented inline.
 */
import { describe, expect, it } from "vitest";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type BrowserConnector,
  type BrowserStep,
  type BrowserStepResult,
  FakeBrowserConnector,
  bindingWrappedBrowserEffect,
  returnContentSanitizer,
} from "./browser-closed-loop.js";
import { browserNavigateBinding, browserReadBinding } from "./browser-seed-tools.js";

/** Runtime-built OpenAI-shape canary (matches audit/redact's `sk-...`). NOT a source literal. */
function skCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`;
}
/** Runtime-built Google-OAuth-shape canary (matches audit/redact's `ya29.`). NOT a source literal. */
function googleCanary(): string {
  return `ya29.${"Z9y8X7w6".repeat(4)}`;
}

const bindings = new Map([
  ["browser.navigate", browserNavigateBinding],
  ["browser.read", browserReadBinding],
]);

// ==================================================================================================
// returnContentSanitizer — the PURE data-OUT gate: redact + bound + mark untrusted.
// ==================================================================================================
describe("returnContentSanitizer — redact + size-bound + untrusted-mark (pure)", () => {
  it("REDACTS a runtime canary secret (sk- and ya29.) from the returned content", () => {
    const raw = `before ${skCanary()} middle ${googleCanary()} after`;
    const out = returnContentSanitizer(raw);
    expect(out.content).not.toContain(skCanary());
    expect(out.content).not.toContain(googleCanary());
    expect(out.content).toContain("[REDACTED]");
    // NON-VACUITY: a mutation that drops `redactSecrets(raw)` in the sanitizer => this expectation
    // FLIPS RED (the canary survives into out.content).
  });

  it("TRUNCATES content longer than maxBytes and marks truncated:true", () => {
    const raw = "x".repeat(10_000);
    const out = returnContentSanitizer(raw, { maxBytes: 8192 });
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThanOrEqual(8192);
  });

  it("does NOT truncate content within maxBytes (truncated:false)", () => {
    const out = returnContentSanitizer("short page", { maxBytes: 8192 });
    expect(out.truncated).toBe(false);
    expect(out.content).toBe("short page");
  });

  it("ALWAYS marks the returned content untrusted:true (page data is not instruction)", () => {
    const out = returnContentSanitizer("ordinary page text");
    expect(out.untrusted).toBe(true);
  });

  it("uses a default maxBytes when none is supplied (still bounded)", () => {
    const out = returnContentSanitizer("y".repeat(100_000));
    expect(out.truncated).toBe(true);
    expect(out.content.length).toBeLessThan(100_000);
  });
});

// ==================================================================================================
// FakeBrowserConnector — server-held session map; NEVER exposes a raw handle / cookies.
// ==================================================================================================
describe("FakeBrowserConnector — server-held session; opaque sessionId; no handle leak", () => {
  it("session.open returns an opaque sessionId; the brain never holds a handle/cookies", () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    expect(typeof sid).toBe("string");
    expect(sid.length).toBeGreaterThan(0);
    // The connector holds the live state; the only thing exported is the opaque id.
    expect(fake.hasSession(sid)).toBe(true);
    // Nothing on the public surface returns a raw cookie/handle.
    expect((fake as unknown as { cookies?: unknown }).cookies).toBeUndefined();
  });

  it("validates sessionId shape: an unknown/malformed id is NOT a live session", () => {
    const fake = new FakeBrowserConnector();
    expect(fake.hasSession("not-a-real-session")).toBe(false);
    expect(fake.hasSession("")).toBe(false);
  });

  it("navigate records the url + currentHost; read returns the canned content", async () => {
    const fake = new FakeBrowserConnector({ content: "canned page body" });
    const sid = fake.openSession();
    const navStep: BrowserStep = {
      sessionId: sid,
      primitive: "navigate",
      params: { url: "https://allowed.example/x" },
    };
    const nav: BrowserStepResult = await fake.perform({}, navStep);
    expect(nav.ok).toBe(true);
    expect(nav.currentHost).toBe("allowed.example");
    const read: BrowserStepResult = await fake.perform(
      {},
      {
        sessionId: sid,
        primitive: "read",
        params: {},
      },
    );
    expect(read.ok).toBe(true);
    expect(read.content).toBe("canned page body");
    // It records every step (an auditable in-memory trace, NOT a handle/cookie surface).
    expect(fake.steps.length).toBe(2);
  });

  it("perform on an unknown sessionId => ok:false (fail-closed; the Fake itself rejects)", async () => {
    const fake = new FakeBrowserConnector();
    const res = await fake.perform(
      {},
      {
        sessionId: "ghost",
        primitive: "read",
        params: {},
      },
    );
    expect(res.ok).toBe(false);
  });
});

// ==================================================================================================
// bindingWrappedBrowserEffect — the fail-closed edge BEFORE the connector (twin of the action effect).
// ==================================================================================================
describe("bindingWrappedBrowserEffect — fail-closed gates before the connector", () => {
  it("no binding for the tool => deny; connector NEVER called (deny-by-default)", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.unknown",
      context: {},
      args: { sessionId: sid },
    });
    expect(out.ok).toBe(false);
    expect(fake.steps.length).toBe(0);
  });

  it("unknown sessionId => deny; FakeBrowserConnector.perform NEVER called", async () => {
    const fake = new FakeBrowserConnector();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.read",
      context: {},
      args: { sessionId: "ghost-session" },
    });
    expect(out.ok).toBe(false);
    expect(fake.steps.length).toBe(0);
  });

  it("navigate with an extra (unknown) key => strict-schema deny; connector NEVER called", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.navigate",
      context: {},
      args: { sessionId: sid, url: "https://allowed.example/x", extra: "smuggled" },
    });
    expect(out.ok).toBe(false);
    expect(fake.steps.length).toBe(0);
  });

  it("a literal secret in params => credential-blind deny (IN guard); connector NEVER called", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    // The selector field carries a literal secret canary => the IN guard must deny.
    const out = await effect({
      tool: "browser.read",
      context: {},
      args: { sessionId: sid, selector: `#x ${skCanary()}` },
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("credential-blind");
    expect(fake.steps.length).toBe(0);
  });

  it("⚠️ read: a page CANARY secret is REDACTED + the over-long body TRUNCATED + untrusted before the brain", async () => {
    const canary = skCanary();
    const fake = new FakeBrowserConnector({
      content: `secret page: ${canary} ${"PAD".repeat(5000)}`,
    });
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.read",
      context: {},
      args: { sessionId: sid },
    });
    expect(out.ok).toBe(true);
    // The detail is the ONLY channel the brain sees the read content on. It MUST NOT contain the canary.
    const seen = out.detail ?? "";
    expect(seen).not.toContain(canary);
    expect(seen).toContain("[REDACTED]");
    // Untrusted-marked + truncated (the page was padded past the bound).
    expect(seen).toContain("untrusted");
    expect(seen).toContain("truncated");
    // NON-VACUITY: a mutation skipping `returnContentSanitizer` on the read result in the effect =>
    // this canary expectation FLIPS RED (the raw canary reaches `out.detail`).
  });

  it("navigate: a valid {sessionId,url} reaches the connector and records a step", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.navigate",
      context: {},
      args: { sessionId: sid, url: "https://allowed.example/x" },
    });
    expect(out.ok).toBe(true);
    expect(fake.steps.length).toBe(1);
    expect(fake.steps[0]?.primitive).toBe("navigate");
  });
});

// Reference the port type so an unused-import lint never trips (it is part of the contract).
const _portTypeCheck: BrowserConnector = new FakeBrowserConnector();
void _portTypeCheck;
