import { describe, expect, it } from "vitest";
import { canonicalizeAuditEvent } from "./canonical.js";
import { type AuditClock, type AuditEventInput, createAuditEvent } from "./event.js";
import { REDACTED, redactSecrets } from "./redact.js";

// Secret-shaped canaries built at runtime — NOT written as literals, so scan_secrets.sh
// does not flag this source file (INDEX §2.1.4: canary is an in-memory sentinel).
const SK = `sk-${"x".repeat(32)}`;
const GH = `ghp_${"y".repeat(36)}`;

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
