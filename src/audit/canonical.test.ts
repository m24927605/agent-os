import { describe, expect, it } from "vitest";
import { canonicalizeAuditEvent, contentAddress } from "./canonical.js";
import {
  type AuditClock,
  type AuditEvent,
  type AuditEventInput,
  createAuditEvent,
} from "./event.js";

const clock: AuditClock = {
  now: () => "2026-06-19T00:00:00.000Z",
  newId: () => "evt-1",
};

const input: AuditEventInput = {
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "fs:read",
  resource: "/workspace/a",
  policyDecision: { effect: "deny", reason: "no matching allow rule (deny-by-default)" },
  result: "denied",
};

const ev = () => createAuditEvent(input, clock);
const decode = (u: Uint8Array) => new TextDecoder().decode(u);
const corrupt = (o: object) => canonicalizeAuditEvent(o as unknown as AuditEvent);

describe("canonicalizeAuditEvent / contentAddress", () => {
  it("is deterministic regardless of object key insertion order", () => {
    const e = ev();
    const shuffled = {
      result: e.result,
      action: e.action,
      policyDecision: e.policyDecision,
      resource: e.resource,
      actorId: e.actorId,
      taskId: e.taskId,
      projectId: e.projectId,
      tenantId: e.tenantId,
      timestamp: e.timestamp,
      requestId: e.requestId,
      eventId: e.eventId,
    } as AuditEvent;
    expect(decode(canonicalizeAuditEvent(shuffled))).toBe(decode(canonicalizeAuditEvent(e)));
    expect(contentAddress(shuffled)).toBe(contentAddress(e));
  });

  it("changes the content address when any field changes (collision-sensitive)", () => {
    const a = contentAddress(createAuditEvent(input, clock));
    const b = contentAddress(createAuditEvent({ ...input, result: "success" }, clock));
    expect(a).not.toBe(b);
  });

  it("emits a sha256:<64-hex> content address", () => {
    expect(contentAddress(ev())).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("throws on non-finite numbers and array-nested undefined (no silent coercion)", () => {
    expect(() => corrupt({ ...ev(), bad: Number.NaN })).toThrow();
    expect(() => corrupt({ ...ev(), bad: Number.POSITIVE_INFINITY })).toThrow();
    expect(() => corrupt({ ...ev(), arr: [undefined] })).toThrow();
  });

  it("redacts before canonicalizing — no secret value appears in the bytes", () => {
    const polluted = corrupt({ ...ev(), context: { apiKey: "CANARY-SECRET-do-not-serialize" } });
    const text = decode(polluted);
    expect(text).not.toContain("CANARY-SECRET-do-not-serialize");
    expect(text).toContain("[REDACTED]");
  });
});
