/**
 * SLICE-ACT5c (RED-first) — UNIT tests for the BROWSER click/type primitives + the type-credential
 * EGRESS resolution (`resolveCredentialText`) + the FakeBrowserConnector click/type handling + the
 * manifest superRefine (destructive => requiresApproval forced).
 *
 * NO real browser / network / ~/.env — a FakeBrowserConnector with a server-held session map. The
 * connector NEVER exposes a raw handle / cookies; the brain only ever sees the opaque sessionId.
 *
 * The CORE security properties under test:
 *   - destructive (click/type) => the manifest superRefine FORCES requiresApproval (a manifest with
 *     `sideEffect:"destructive"` + `requiresApproval:false` THROWS in parseToolManifest).
 *   - type-credential is CREDENTIAL-BLIND: a `text` PLACEHOLDER (`openshell:resolve:env:KEY`) passes the
 *     input guard and is resolved by the CONNECTOR at EGRESS (mirroring resolveCredentialHeaders); the
 *     RESOLVED value is the actor's — it NEVER rides back to the brain/result. A LITERAL secret-shaped
 *     `text` is DENIED by the credential-blind input guard (the connector is NEVER called).
 *   - selector/text are STRICT (a smuggled extra key => deny).
 * NON-VACUITY mutations documented inline.
 */
import { describe, expect, it } from "vitest";
import { parseToolManifest } from "../../../../tools/index.js";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type BrowserConnector,
  type BrowserStep,
  type BrowserStepResult,
  FakeBrowserConnector,
  bindingWrappedBrowserEffect,
  resolveCredentialText,
} from "./browser-closed-loop.js";
import {
  browserClickBinding,
  browserClickManifest,
  browserNavigateBinding,
  browserReadBinding,
  browserTypeBinding,
  browserTypeManifest,
} from "./browser-seed-tools.js";

/** Runtime-built OpenAI-shape canary (matches audit/redact's `sk-...`). NOT a source literal. */
function skCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`;
}

/** The credential placeholder grammar the connector resolves at egress. */
function placeholderFor(key: string): string {
  return `openshell:resolve:env:${key}`;
}

const bindings = new Map([
  ["browser.navigate", browserNavigateBinding],
  ["browser.read", browserReadBinding],
  ["browser.click", browserClickBinding],
  ["browser.type", browserTypeBinding],
]);

// ==================================================================================================
// manifest superRefine — destructive (click/type) FORCES requiresApproval:true.
// ==================================================================================================
describe("browser.click/type manifests — destructive => requiresApproval forced (superRefine)", () => {
  it("browser.click manifest is destructive + requiresApproval:true + in-sandbox + not idempotent", () => {
    const m = parseToolManifest(browserClickManifest);
    expect(m.sideEffect).toBe("destructive");
    expect(m.requiresApproval).toBe(true);
    expect(m.idempotent).toBe(false);
    expect(m.containment).toBe("in-sandbox");
  });

  it("browser.type manifest is destructive + requiresApproval:true + in-sandbox + not idempotent", () => {
    const m = parseToolManifest(browserTypeManifest);
    expect(m.sideEffect).toBe("destructive");
    expect(m.requiresApproval).toBe(true);
    expect(m.idempotent).toBe(false);
    expect(m.containment).toBe("in-sandbox");
  });

  it("a destructive browser.click manifest with requiresApproval:false => parseToolManifest THROWS", () => {
    expect(() => parseToolManifest({ ...browserClickManifest, requiresApproval: false })).toThrow();
    // NON-VACUITY: this is the superRefine guardrail. A click manifest that bypassed it (requiresApproval
    // off) would let the destructive effect run unapproved — the approval-gate JOIN test (no pre-auth =>
    // denied@approval) FLIPS RED if the manifest's requiresApproval is forced off.
  });

  it("a destructive browser.type manifest with requiresApproval:false => parseToolManifest THROWS", () => {
    expect(() => parseToolManifest({ ...browserTypeManifest, requiresApproval: false })).toThrow();
  });
});

// ==================================================================================================
// resolveCredentialText — the PURE, testable EGRESS resolver (mirrors resolveCredentialHeaders).
// ==================================================================================================
describe("resolveCredentialText — placeholder->env, non-placeholder->verbatim, missing->fail-closed", () => {
  it("a placeholder text resolves to env[KEY] (egress, the actor's value)", () => {
    const value = `runtime-secret-${Math.random().toString(36).slice(2)}`;
    const out = resolveCredentialText(placeholderFor("LOGIN_PW"), { LOGIN_PW: value });
    expect("text" in out).toBe(true);
    if ("text" in out) expect(out.text).toBe(value);
  });

  it("a NON-placeholder text passes through VERBATIM (no env lookup)", () => {
    const out = resolveCredentialText("hello world", { LOGIN_PW: "x" });
    expect("text" in out).toBe(true);
    if ("text" in out) expect(out.text).toBe("hello world");
  });

  it("a placeholder with a MISSING env value => fail-closed error (no value materialized)", () => {
    const out = resolveCredentialText(placeholderFor("LOGIN_PW"), {});
    expect("error" in out).toBe(true);
    // The error reason is STATIC + value-free (never echoes the KEY's value / any env text).
    if ("error" in out) expect(out.error).not.toContain("LOGIN_PW=");
  });

  it("a placeholder with an EMPTY env value => fail-closed error", () => {
    const out = resolveCredentialText(placeholderFor("LOGIN_PW"), { LOGIN_PW: "" });
    expect("error" in out).toBe(true);
  });
});

// ==================================================================================================
// FakeBrowserConnector — click/type handling; type resolves the text placeholder at EGRESS.
// ==================================================================================================
describe("FakeBrowserConnector — click records the step; type resolves the text placeholder at egress", () => {
  it("click records the step + returns ok", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const step: BrowserStep = {
      sessionId: sid,
      primitive: "click",
      params: { selector: "#submit" },
    };
    const res: BrowserStepResult = await fake.perform({}, step);
    expect(res.ok).toBe(true);
    expect(fake.steps.length).toBe(1);
    expect(fake.steps[0]?.primitive).toBe("click");
  });

  it("type with a PLACEHOLDER text: the connector resolves it at egress; the resolved value is what-it-would-type", async () => {
    const value = `runtime-pw-${Math.random().toString(36).slice(2)}`;
    const fake = new FakeBrowserConnector({ env: { LOGIN_PW: value } });
    const sid = fake.openSession();
    const step: BrowserStep = {
      sessionId: sid,
      primitive: "type",
      params: { selector: "#pw", text: placeholderFor("LOGIN_PW") },
    };
    const res: BrowserStepResult = await fake.perform({}, step);
    expect(res.ok).toBe(true);
    // The connector (the actor) resolved the placeholder at egress — the FAKE records the RESOLVED value
    // as what-it-would-type, reachable ONLY via a TEST probe (never a brain channel).
    expect(fake.peekLastTyped()).toBe(value);
    // The recorded STEP carries only the placeholder (the resolved value never enters the step trace).
    expect(JSON.stringify(fake.steps)).not.toContain(value);
    expect(JSON.stringify(fake.steps)).toContain(placeholderFor("LOGIN_PW"));
  });

  it("type with a PLACEHOLDER text whose env is MISSING => fail-closed (ok:false), nothing typed", async () => {
    const fake = new FakeBrowserConnector({ env: {} });
    const sid = fake.openSession();
    const res: BrowserStepResult = await fake.perform(
      {},
      {
        sessionId: sid,
        primitive: "type",
        params: { selector: "#pw", text: placeholderFor("LOGIN_PW") },
      },
    );
    expect(res.ok).toBe(false);
    expect(fake.peekLastTyped()).toBeUndefined();
  });

  it("type with a NON-placeholder text: the connector types it verbatim", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    await fake.perform(
      {},
      { sessionId: sid, primitive: "type", params: { selector: "#name", text: "Alice" } },
    );
    expect(fake.peekLastTyped()).toBe("Alice");
  });
});

// ==================================================================================================
// bindingWrappedBrowserEffect — click/type fail-closed edges (twin of navigate/read).
// ==================================================================================================
describe("bindingWrappedBrowserEffect — click/type gates before the connector", () => {
  it("click with a valid {sessionId,selector} reaches the connector + records a step", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.click",
      context: {},
      args: { sessionId: sid, selector: "#submit" },
    });
    expect(out.ok).toBe(true);
    expect(fake.steps.length).toBe(1);
    expect(fake.steps[0]?.primitive).toBe("click");
  });

  it("click with an extra (unknown) key => strict-schema deny; connector NEVER called", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.click",
      context: {},
      args: { sessionId: sid, selector: "#x", extra: "smuggled" },
    });
    expect(out.ok).toBe(false);
    expect(fake.steps.length).toBe(0);
  });

  it("type with an extra (unknown) key => strict-schema deny; connector NEVER called", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.type",
      context: {},
      args: { sessionId: sid, selector: "#x", text: "hi", extra: "smuggled" },
    });
    expect(out.ok).toBe(false);
    expect(fake.steps.length).toBe(0);
  });

  it("⚠️ type: a LITERAL secret in text => credential-blind deny (IN guard); connector NEVER called", async () => {
    const fake = new FakeBrowserConnector({ env: { LOGIN_PW: "irrelevant" } });
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.type",
      context: {},
      args: { sessionId: sid, selector: "#pw", text: skCanary() },
    });
    expect(out.ok).toBe(false);
    expect(out.detail).toContain("credential-blind");
    expect(fake.steps.length).toBe(0);
    // NON-VACUITY: a mutation skipping the credential-blind INPUT guard lets a LITERAL secret reach the
    // connector — THIS test FLIPS RED (a raw secret would be typed instead of denied).
  });

  it("⚠️ type: a PLACEHOLDER text PASSES the input guard => the connector resolves it at egress; the resolved value NEVER rides back to the brain", async () => {
    const value = `runtime-pw-${Math.random().toString(36).slice(2)}`;
    const fake = new FakeBrowserConnector({ env: { LOGIN_PW: value } });
    const sid = fake.openSession();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.type",
      context: {},
      args: { sessionId: sid, selector: "#pw", text: placeholderFor("LOGIN_PW") },
    });
    expect(out.ok).toBe(true);
    expect(fake.steps.length).toBe(1);
    // The connector typed the resolved value at egress.
    expect(fake.peekLastTyped()).toBe(value);
    // ⚠️ The resolved value NEVER appears on the brain-facing EffectResult (only the placeholder ever did).
    expect(JSON.stringify(out)).not.toContain(value);
    // NON-VACUITY: a mutation that LEAKS the resolved value onto the result, OR resolves it before the
    // input guard (so the brain ever sees it), FLIPS this RED. Skipping the egress resolution entirely
    // makes the connector type the placeholder instead of the value (peekLastTyped !== value) — also RED.
  });
});

// Reference the port type so an unused-import lint never trips (it is part of the contract).
const _portTypeCheck: BrowserConnector = new FakeBrowserConnector();
void _portTypeCheck;
