import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../policy/evaluate.js";
import { type AuditClock, type AuditEventInput, createAuditEvent } from "./event.js";
import { REDACTED, redactSecrets } from "./redact.js";
import { serializeAuditEvent } from "./serialize.js";

const fixedClock: AuditClock = {
  now: () => "2026-06-19T00:00:00.000Z",
  newId: () => "evt-fixed-0001",
};

const validInput: AuditEventInput = {
  requestId: "req-1",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "fs:read",
  resource: "/workspace/readme.md",
  policyDecision: { effect: "deny", reason: "no matching allow rule (deny-by-default)" },
  result: "denied",
};

describe("createAuditEvent — completeness & fail closed", () => {
  it("builds a complete event with all required fields", () => {
    const event = createAuditEvent(validInput, fixedClock);
    const json = JSON.parse(serializeAuditEvent(event));
    for (const field of [
      "eventId",
      "requestId",
      "timestamp",
      "tenantId",
      "projectId",
      "taskId",
      "actorId",
      "action",
      "resource",
      "policyDecision",
      "result",
    ]) {
      expect(json[field]).toBeDefined();
    }
    expect(json.tenantId).toBe("tenant-a");
    expect(json.result).toBe("denied");
  });

  it("throws on an incomplete event rather than emitting a partial record", () => {
    const incomplete = { ...validInput } as Partial<AuditEventInput>;
    incomplete.tenantId = undefined;
    expect(() => createAuditEvent(incomplete as AuditEventInput, fixedClock)).toThrow();
  });

  it("rejects an empty required id (fail closed)", () => {
    expect(() => createAuditEvent({ ...validInput, actorId: "" }, fixedClock)).toThrow();
  });

  it("rejects a whitespace-only action or resource (fail closed)", () => {
    expect(() => createAuditEvent({ ...validInput, action: "  \t" }, fixedClock)).toThrow();
    expect(() => createAuditEvent({ ...validInput, resource: "\n " }, fixedClock)).toThrow();
  });

  it("can record the outcome of a real deny-by-default policy decision", () => {
    const decision = evaluatePolicy(
      {
        requestId: "req-2",
        tenantId: "tenant-a",
        projectId: "proj-1",
        taskId: "task-1",
        actorId: "agent:claude",
        action: "net:egress",
        resource: "https://example.com",
      },
      [],
    );
    const event = createAuditEvent(
      {
        ...validInput,
        action: "net:egress",
        resource: "https://example.com",
        policyDecision: decision,
      },
      fixedClock,
    );
    expect(event.policyDecision.effect).toBe("deny");
    expect(event.result).toBe("denied");
  });
});

describe("audit redaction — Credential Non-Leak", () => {
  it("redacts values stored under secret-like keys (by key name)", () => {
    const redacted = redactSecrets({
      apiKey: "should-be-hidden-A",
      authorization: "Bearer should-be-hidden-B",
      nested: { password: "should-be-hidden-C", note: "ok-to-keep" },
      action: "fs:read",
    });
    expect(redacted.apiKey).toBe(REDACTED);
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.nested.password).toBe(REDACTED);
    expect(redacted.nested.note).toBe("ok-to-keep");
  });

  it("never emits secret-like values when serializing", () => {
    const polluted = redactSecrets({
      ...validInput,
      eventId: "evt-1",
      timestamp: "2026-06-19T00:00:00.000Z",
      context: { apiKey: "super-sensitive-do-not-log" },
    });
    const json = JSON.stringify(polluted);
    expect(json).not.toContain("super-sensitive-do-not-log");
    expect(json).toContain(REDACTED);
  });
});
