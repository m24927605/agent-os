import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AuditClock, type AuditEventInput, createAuditEvent } from "../event.js";
import { InMemoryAppendOnlyLog, type LogEntry } from "./log.js";
import { verifyChain } from "./verify.js";

const clock: AuditClock = { now: () => "2026-06-19T00:00:00.000Z", newId: () => "evt" };

function mkEvent(seq: number, over: Partial<AuditEventInput> = {}) {
  const input: AuditEventInput = {
    requestId: `req-${seq}`,
    tenantId: "tenant-a",
    projectId: "proj-1",
    taskId: "task-1",
    actorId: "agent:claude",
    action: "fs:read",
    resource: `/workspace/${seq}`,
    policyDecision: { effect: "deny", reason: "no matching allow rule (deny-by-default)" },
    result: "denied",
    eventId: `evt-${seq}`,
    ...over,
  };
  return createAuditEvent(input, clock);
}

function build3() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const log = new InMemoryAppendOnlyLog({ publicKey, privateKey });
  log.append(mkEvent(0));
  log.append(mkEvent(1));
  log.append(mkEvent(2));
  return { log, publicKey, privateKey, entries: log.entries(), checkpoint: log.checkpoint() };
}

describe("verifyChain — recompute + signature + tamper detection", () => {
  it("verifies an intact, correctly-signed chain", () => {
    const { entries, checkpoint, publicKey } = build3();
    expect(verifyChain({ entries, checkpoint }, publicKey)).toEqual({ ok: true, length: 3 });
  });

  it("detects tampering with an entry's event content", () => {
    const { entries, checkpoint, publicKey } = build3();
    const tampered: LogEntry[] = entries.map((e, i) =>
      i === 1 ? { ...e, event: { ...e.event, resource: "/etc/passwd" } } : e,
    );
    const res = verifyChain({ entries: tampered, checkpoint }, publicKey);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.brokenAt).toBe(1);
    }
  });

  it("detects reordering of entries", () => {
    const { entries, checkpoint, publicKey } = build3();
    const swapped = [entries[1], entries[0], entries[2]] as LogEntry[];
    expect(verifyChain({ entries: swapped, checkpoint }, publicKey).ok).toBe(false);
  });

  it("detects a sequence gap (a removed entry)", () => {
    const { entries, checkpoint, publicKey } = build3();
    const gapped = [entries[0], entries[2]] as LogEntry[];
    const res = verifyChain({ entries: gapped, checkpoint }, publicKey);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.brokenAt).toBe(1);
    }
  });

  it("rejects a checkpoint signed by a different key", () => {
    const { entries, checkpoint } = build3();
    const { publicKey: wrongKey } = generateKeyPairSync("ed25519");
    expect(verifyChain({ entries, checkpoint }, wrongKey).ok).toBe(false);
  });

  it("does not leak a secret-keyed value into receipts or the checkpoint", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const log = new InMemoryAppendOnlyLog({ publicKey, privateKey });
    // canary smuggled into a free-form context field (cast); redaction must keep it out of hashes/outputs.
    const evt = mkEvent(0) as unknown as Record<string, unknown>;
    evt.context = { apiKey: "CANARY-SECRET-do-not-chain" };
    const receipt = log.append(evt as never);
    const checkpoint = log.checkpoint();
    expect(JSON.stringify(receipt)).not.toContain("CANARY-SECRET-do-not-chain");
    expect(JSON.stringify(checkpoint)).not.toContain("CANARY-SECRET-do-not-chain");
  });
});
