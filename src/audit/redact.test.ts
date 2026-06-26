import { describe, expect, it } from "vitest";
import { canonicalizeAuditEvent } from "./canonical.js";
import { type AuditClock, type AuditEventInput, createAuditEvent } from "./event.js";
import { REDACTED, redactSecrets } from "./redact.js";

// Secret-shaped canaries built at runtime — NOT written as literals, so scan_secrets.sh
// does not flag this source file (INDEX §2.1.4: canary is an in-memory sentinel).
const SK = `sk-${"x".repeat(32)}`;
const GH = `ghp_${"y".repeat(36)}`;
const AKIA = `AKIA${"A1B2C3D4E5F6G7H8".slice(0, 16)}`;
const XOX = `xoxb-${"z".repeat(20)}`;
const PEM = `-----BEGIN ${"RSA"} PRIVATE KEY-----`;
const JWT = `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(12)}`;

// Google credential shapes (SLICE-CRED-HARDENING-GOOGLE) — runtime-built canaries.
const YA29 = `ya29.${"t".repeat(40)}`; // Google OAuth access token (ya29. + 40 chars >= 20)
const AIZA = `AIza${"k".repeat(35)}`; // Google API key (AIza + exactly 35 chars)
const BEARER_TOKEN = `Bearer ${"u".repeat(30)}`; // generic bearer header (Bearer + 30 chars >= 20)
// Credential placeholder the connector emits — colons break the {20,} run, so it must NOT match.
const PLACEHOLDER = "openshell:resolve:env:GMAIL_OAUTH_KEY";

const clock: AuditClock = { now: () => "2026-06-19T00:00:00.000Z", newId: () => "evt-1" };

describe("redactSecrets — value-scanning (not just by-key)", () => {
  it("scrubs a secret-shaped value stored under a NON-secret key", () => {
    const out = redactSecrets({ resource: SK, note: "ok-to-keep" });
    expect(out.resource).not.toContain("sk-");
    expect(out.resource).toBe(REDACTED);
    expect(out.note).toBe("ok-to-keep");
  });

  it("scrubs a secret embedded inside a larger string, keeping the rest", () => {
    const out = redactSecrets({ msg: `token is ${GH} for now` });
    expect(out.msg).not.toContain(GH);
    expect(out.msg).toContain(REDACTED);
    expect(out.msg).toContain("token is");
  });

  it("scrubs secret-shaped values nested in objects and arrays", () => {
    const out = redactSecrets({ items: [{ x: SK }, "plain", GH] });
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-x");
    expect(json).not.toContain("ghp_y");
    expect(json).toContain(REDACTED);
    expect(json).toContain("plain");
  });

  it("keeps the existing by-key behaviour and leaves ordinary text untouched", () => {
    const out = redactSecrets({ apiKey: "anything-here", note: "nothing secret" });
    expect(out.apiKey).toBe(REDACTED);
    expect(out.note).toBe("nothing secret");
  });

  it("keeps secrets out of canonical bytes even via a non-secret AuditEvent field", () => {
    const input: AuditEventInput = {
      requestId: "req-1",
      tenantId: "tenant-a",
      projectId: "proj-1",
      taskId: "task-1",
      actorId: "agent:claude",
      action: "fs:read",
      resource: `/workspace/${SK}`,
      policyDecision: { effect: "deny", reason: "no matching allow rule (deny-by-default)" },
      result: "denied",
    };
    const bytes = new TextDecoder().decode(canonicalizeAuditEvent(createAuditEvent(input, clock)));
    expect(bytes).not.toContain("sk-x");
    expect(bytes).toContain(REDACTED);
  });
});

describe("redactSecrets — Google credential shapes (SLICE-CRED-HARDENING-GOOGLE)", () => {
  it("redacts a Google OAuth access token (ya29.<20+ chars>)", () => {
    const out = redactSecrets({ resource: YA29 });
    expect(out.resource).not.toContain("ya29.");
    expect(out.resource).toBe(REDACTED);
  });

  it("redacts a Google API key (AIza + 35 chars)", () => {
    const out = redactSecrets({ resource: AIZA });
    expect(out.resource).not.toContain("AIza");
    expect(out.resource).toBe(REDACTED);
  });

  it("redacts a generic Bearer header value (Bearer + 20+ token chars)", () => {
    const out = redactSecrets({ note: `auth: ${BEARER_TOKEN}` });
    expect(out.note).not.toContain(BEARER_TOKEN);
    expect(out.note).toContain(REDACTED);
    expect(out.note).toContain("auth:");
  });

  it("scrubs the matched substring, leaving surrounding text intact", () => {
    const out = redactSecrets({ msg: `token=${YA29} done` });
    expect(out.msg).not.toContain(YA29);
    expect(out.msg).toContain(REDACTED);
    expect(out.msg).toContain("token=");
    expect(out.msg).toContain("done");
  });

  // ── CRITICAL: the credential placeholder must NOT be flagged as a secret ──
  it("does NOT false-flag the credential placeholder openshell:resolve:env:KEY", () => {
    // Use a NON-secret key (resource) so the by-KEY pass does not mask this; we are
    // asserting the by-VALUE scrubber leaves the placeholder byte-identical
    // (colons break the {20,} run, so neither Bearer nor the other patterns match).
    const out = redactSecrets({ resource: PLACEHOLDER });
    expect(out.resource).toBe(PLACEHOLDER);
  });

  it("does NOT match the placeholder even when prefixed with Bearer", () => {
    const value = `Bearer ${PLACEHOLDER}`;
    const out = redactSecrets({ resource: value });
    // The placeholder substring must survive — only a real long token would be redacted.
    expect(out.resource).toContain(PLACEHOLDER);
    expect(out.resource).not.toContain(REDACTED);
  });

  // ── low-false-positive: short / bare prefixes must NOT match ──
  it("does NOT match a short Bearer value (< 20 token chars)", () => {
    const short = redactSecrets({ resource: "Bearer me" });
    expect(short.resource).toBe("Bearer me");
    const tooShort = redactSecrets({ resource: `Bearer ${"q".repeat(19)}` });
    expect(tooShort.resource).toBe(`Bearer ${"q".repeat(19)}`);
  });

  it("does NOT match a bare AIza prefix without the 35-char tail", () => {
    const out = redactSecrets({ resource: "AIza" });
    expect(out.resource).toBe("AIza");
  });

  it("does NOT match a bare ya29. prefix without the 20+ tail", () => {
    const out = redactSecrets({ resource: "ya29." });
    expect(out.resource).toBe("ya29.");
    const tooShort = redactSecrets({ resource: `ya29.${"t".repeat(19)}` });
    expect(tooShort.resource).toBe(`ya29.${"t".repeat(19)}`);
  });

  // ── INPUT-guard linkage: redactSecrets CHANGES a ya29. value (guard keys on changed) ──
  it("changes a ya29. token value (so the credential-blind INPUT guard treats it as secret)", () => {
    // Non-secret key (`arg0`) so the change is driven by the by-VALUE pattern, not by-KEY —
    // the INPUT guard keys on redactSecrets producing a CHANGED payload.
    const original = { params: { arg0: YA29 } };
    const out = redactSecrets(original);
    expect(JSON.stringify(out)).not.toEqual(JSON.stringify(original));
    expect(out.params.arg0).toBe(REDACTED);
  });
});

describe("redactSecrets — no-regression for the existing 6 classes", () => {
  it("still redacts sk- / ghp_ / AKIA / xox / PEM / JWT shapes", () => {
    expect(redactSecrets({ r: SK }).r).toBe(REDACTED);
    expect(redactSecrets({ r: GH }).r).toBe(REDACTED);
    expect(redactSecrets({ r: AKIA }).r).toBe(REDACTED);
    expect(redactSecrets({ r: XOX }).r).toBe(REDACTED);
    expect(redactSecrets({ r: `${PEM} body` }).r).toContain(REDACTED);
    expect(redactSecrets({ r: JWT }).r).toBe(REDACTED);
  });

  it("leaves benign strings byte-identical (no new false positives)", () => {
    const benign = "the quick brown fox AIza jumps over Bearer me at ya29.";
    expect(redactSecrets({ r: benign }).r).toBe(benign);
  });
});
