/**
 * SLICE-ACT5f (RED-first) — UNIT tests for the governed session-bootstrap primitives:
 * `browser.session.open` (MINTS + returns an opaque sessionId) + `browser.session.close` (releases a
 * slot; idempotent) over the `FakeBrowserConnector` + `bindingWrappedBrowserEffect`.
 *
 * NO real browser / network / ~/.env — the in-repo Fake. The CORE properties under test:
 *   - session.open MINTS: the effect returns the connector's minted opaque sessionId (bsess_ shape) in
 *     the result detail; that SAME id then drives navigate (governed); a NEVER-opened id => deny.
 *   - MOAT: the session.open result carries ONLY the opaque sessionId — NEVER the handle / cookies / url /
 *     currentHost. NON-VACUITY: a mutation surfacing the handle/cookie flips the moat assertion RED.
 *   - SESSION CAP (fail-closed): opening `cap` sessions then a (cap+1)th open => deny (resource-exhaustion
 *     guard); a close frees a slot. NON-VACUITY: removing the cap (unbounded) flips the exhaustion test RED.
 *   - session.close releases: after close, navigate on that id => deny; close of an unknown id => safe ok.
 *   - session.open/close NON-destructive, NO approval (benign lifecycle — no external effect).
 */
import { describe, expect, it } from "vitest";
import { defaultExecSecretDetector } from "../../../substrate/index.js";
import {
  type BrowserConnector,
  type BrowserStep,
  FakeBrowserConnector,
  bindingWrappedBrowserEffect,
} from "./browser-closed-loop.js";
import {
  browserNavigateBinding,
  browserReadBinding,
  browserSessionCloseBinding,
  browserSessionCloseManifest,
  browserSessionOpenBinding,
  browserSessionOpenManifest,
} from "./browser-seed-tools.js";

/** Runtime-built `sk-...` canary (NOT a source literal — secret-scan clean). */
function skCanary(): string {
  return `sk-${"a1B2c3D4".repeat(3)}`;
}

/** The full ACT5f bindings map: the 4 step primitives + the 2 session lifecycle primitives. */
const bindings = new Map([
  ["browser.navigate", browserNavigateBinding],
  ["browser.read", browserReadBinding],
  ["browser.session.open", browserSessionOpenBinding],
  ["browser.session.close", browserSessionCloseBinding],
]);

/** Pull the minted sessionId out of an effect result detail (it is the ONLY thing surfaced). */
function mintedSessionId(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const m = detail.match(/bsess_[A-Za-z0-9]{4,}/);
  return m?.[0];
}

// ==================================================================================================
// FakeBrowserConnector.perform — session.open MINTS; session.close releases (idempotent).
// ==================================================================================================
describe("ACT5f FakeBrowserConnector.perform — session.open mints; session.close releases", () => {
  it("session.open returns {ok:true, sessionId:<bsess_...>}; the SAME id is then a live session", async () => {
    const fake = new FakeBrowserConnector();
    const step: BrowserStep = { sessionId: "", primitive: "session.open", params: {} };
    const res = await fake.perform({}, step);
    expect(res.ok).toBe(true);
    expect(typeof res.sessionId).toBe("string");
    expect(res.sessionId).toMatch(/^bsess_[A-Za-z0-9]{4,}$/);
    expect(fake.hasSession(res.sessionId as string)).toBe(true);
  });

  it("session.close releases the id (idempotent): a second close of the same id is a safe ok no-op", async () => {
    const fake = new FakeBrowserConnector();
    const sid = fake.openSession();
    expect(fake.hasSession(sid)).toBe(true);
    const close1 = await fake.perform(
      {},
      { sessionId: sid, primitive: "session.close", params: { sessionId: sid } },
    );
    expect(close1.ok).toBe(true);
    expect(fake.hasSession(sid)).toBe(false);
    // Idempotent: closing the now-unknown id again is a safe ok no-op (not a deny/throw).
    const close2 = await fake.perform(
      {},
      { sessionId: sid, primitive: "session.close", params: { sessionId: sid } },
    );
    expect(close2.ok).toBe(true);
  });

  it("close of an UNKNOWN id is a safe ok no-op (idempotent)", async () => {
    const fake = new FakeBrowserConnector();
    const res = await fake.perform(
      {},
      { sessionId: "ghost", primitive: "session.close", params: { sessionId: "ghost" } },
    );
    expect(res.ok).toBe(true);
  });
});

// ==================================================================================================
// SESSION CAP (fail-closed) — the connector caps the number of open sessions; a close frees a slot.
// ==================================================================================================
describe("ACT5f SESSION CAP — fail-closed resource-exhaustion guard", () => {
  it("opening `cap` sessions succeeds; the (cap+1)th session.open => deny (ok:false)", async () => {
    const cap = 3;
    const fake = new FakeBrowserConnector({ browserSessionCap: cap });
    const opened: string[] = [];
    for (let i = 0; i < cap; i++) {
      const res = await fake.perform({}, { sessionId: "", primitive: "session.open", params: {} });
      expect(res.ok).toBe(true);
      opened.push(res.sessionId as string);
    }
    // The (cap+1)th open is denied (the connector is at the cap — fail-closed).
    const over = await fake.perform({}, { sessionId: "", primitive: "session.open", params: {} });
    expect(over.ok).toBe(false);
    expect(over.sessionId).toBeUndefined();
    // NON-VACUITY: a mutation that removes the cap (unbounded) makes `over.ok` true => this flips RED.

    // A close FREES a slot — a new open then succeeds again.
    const freed = await fake.perform(
      {},
      {
        sessionId: opened[0] as string,
        primitive: "session.close",
        params: { sessionId: opened[0] },
      },
    );
    expect(freed.ok).toBe(true);
    const reopened = await fake.perform(
      {},
      { sessionId: "", primitive: "session.open", params: {} },
    );
    expect(reopened.ok).toBe(true);
  });
});

// ==================================================================================================
// bindingWrappedBrowserEffect — session.open MINTS + surfaces ONLY the opaque id (the moat).
// ==================================================================================================
describe("ACT5f bindingWrappedBrowserEffect — session.open mints + returns ONLY the opaque sessionId", () => {
  it("session.open {} => ok + a minted bsess_ sessionId in the detail; the connector now holds it", async () => {
    const fake = new FakeBrowserConnector();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({ tool: "browser.session.open", context: {}, args: {} });
    expect(out.ok).toBe(true);
    const sid = mintedSessionId(out.detail);
    expect(sid).toMatch(/^bsess_[A-Za-z0-9]{4,}$/);
    // The connector now holds the minted session (server-side); the brain holds only the opaque id.
    expect(fake.hasSession(sid as string)).toBe(true);
  });

  it("⚠️ MOAT: the session.open result carries ONLY the opaque id — NOT the handle / cookies / url / currentHost", async () => {
    const cookie = `cookie-${Math.random().toString(36).slice(2)}`;
    const fake = new FakeBrowserConnector({ cookieSecret: cookie });
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({ tool: "browser.session.open", context: {}, args: {} });
    expect(out.ok).toBe(true);
    const blob = JSON.stringify(out);
    // The opaque sessionId IS surfaced (the brain needs it); the handle/cookie/url are NOT.
    expect(mintedSessionId(out.detail)).toBeDefined();
    expect(blob).not.toContain(cookie);
    expect(blob).not.toContain("currentHost");
    expect(blob).not.toContain("currentUrl");
    expect(blob).not.toContain("cookies");
    expect(blob).not.toContain("handle");
    // NON-VACUITY: a mutation that surfaces the handle/cookie on the result flips this RED.
  });

  it("⚠️ MINTS USABLE: the SAME minted id then drives a navigate (the connector recognizes it)", async () => {
    const fake = new FakeBrowserConnector();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const open = await effect({ tool: "browser.session.open", context: {}, args: {} });
    const sid = mintedSessionId(open.detail) as string;
    const nav = await effect({
      tool: "browser.navigate",
      context: {},
      args: { sessionId: sid, url: "https://allowed.example/x" },
    });
    expect(nav.ok).toBe(true);
    // The connector navigated under the minted id (the open + the navigate steps were recorded).
    expect(fake.steps.some((s) => s.primitive === "navigate" && s.sessionId === sid)).toBe(true);
  });

  it("⚠️ UNKNOWN SESSION STILL DENIES: a never-opened id => navigate deny; the connector is NEVER driven", async () => {
    const fake = new FakeBrowserConnector();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.navigate",
      context: {},
      args: { sessionId: "bsess_neveropenedxyz", url: "https://allowed.example/x" },
    });
    expect(out.ok).toBe(false);
    expect(fake.steps.some((s) => s.primitive === "navigate")).toBe(false);
  });

  it("session.close releases: after close, navigate on that id => deny; the connector is NEVER driven", async () => {
    const fake = new FakeBrowserConnector();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const open = await effect({ tool: "browser.session.open", context: {}, args: {} });
    const sid = mintedSessionId(open.detail) as string;
    const close = await effect({
      tool: "browser.session.close",
      context: {},
      args: { sessionId: sid },
    });
    expect(close.ok).toBe(true);
    const nav = await effect({
      tool: "browser.navigate",
      context: {},
      args: { sessionId: sid, url: "https://allowed.example/x" },
    });
    expect(nav.ok).toBe(false);
    expect(fake.steps.some((s) => s.primitive === "navigate")).toBe(false);
  });

  it("session.close of an UNKNOWN id is a safe ok no-op (idempotent; not a deny)", async () => {
    const fake = new FakeBrowserConnector();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const out = await effect({
      tool: "browser.session.close",
      context: {},
      args: { sessionId: "bsess_ghostsessionxyz" },
    });
    expect(out.ok).toBe(true);
  });

  it("session.open with a smuggled extra key => strict-schema deny; the connector is NEVER driven", async () => {
    const fake = new FakeBrowserConnector();
    const effect = bindingWrappedBrowserEffect(fake, bindings, {
      detectSecret: defaultExecSecretDetector,
    });
    const before = fake.steps.length;
    const out = await effect({
      tool: "browser.session.open",
      context: {},
      args: { sessionId: "bsess_smuggled" } as Record<string, unknown>,
    });
    expect(out.ok).toBe(false);
    // No session was minted (the strict {} schema rejects the smuggled key before perform).
    expect(fake.steps.length).toBe(before);
  });
});

// ==================================================================================================
// MANIFESTS — session.open/close are write + in-sandbox + NON-destructive + NO approval.
// ==================================================================================================
describe("ACT5f manifests — session.open/close are non-destructive, no-approval, in-sandbox writes", () => {
  it("browser.session.open: sideEffect write, containment in-sandbox, requiresApproval false, idempotent false", () => {
    expect(browserSessionOpenManifest.sideEffect).toBe("write");
    expect(browserSessionOpenManifest.containment).toBe("in-sandbox");
    expect(browserSessionOpenManifest.requiresApproval).toBe(false);
    expect(browserSessionOpenManifest.idempotent).toBe(false);
  });

  it("browser.session.close: sideEffect write, containment in-sandbox, requiresApproval false, idempotent true", () => {
    expect(browserSessionCloseManifest.sideEffect).toBe("write");
    expect(browserSessionCloseManifest.containment).toBe("in-sandbox");
    expect(browserSessionCloseManifest.requiresApproval).toBe(false);
    expect(browserSessionCloseManifest.idempotent).toBe(true);
  });

  it("session.open binding has NO sessionId field (it MINTS one; the strict schema accepts only {})", () => {
    // A literal secret can never ride session.open's args (it takes none) — strict {} is the tightest input.
    const parsedEmpty = browserSessionOpenBinding.argSchema.safeParse({});
    expect(parsedEmpty.success).toBe(true);
    const parsedExtra = browserSessionOpenBinding.argSchema.safeParse({ sessionId: skCanary() });
    expect(parsedExtra.success).toBe(false);
  });
});

// Reference the port type so an unused-import lint never trips (it is part of the contract).
const _portTypeCheck: BrowserConnector = new FakeBrowserConnector();
void _portTypeCheck;
