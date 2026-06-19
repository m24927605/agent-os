import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AuditClock, type AuditEventInput, createAuditEvent } from "../event.js";
import { GENESIS_PREV_HASH, InMemoryAppendOnlyLog } from "./log.js";

const clock: AuditClock = { now: () => "2026-06-19T00:00:00.000Z", newId: () => "evt" };

function mkEvent(seq: number) {
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
  };
  return createAuditEvent(input, clock);
}

function newLog() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return new InMemoryAppendOnlyLog({ publicKey, privateKey });
}

describe("InMemoryAppendOnlyLog — append-only, hash-chained", () => {
  it("assigns monotonic sequences and links prevHash to the previous entryHash", () => {
    const log = newLog();
    const r0 = log.append(mkEvent(0));
    const r1 = log.append(mkEvent(1));
    const r2 = log.append(mkEvent(2));
    expect([r0.sequence, r1.sequence, r2.sequence]).toEqual([0, 1, 2]);
    expect(r0.prevHash).toBe(GENESIS_PREV_HASH);
    expect(r1.prevHash).toBe(r0.entryHash);
    expect(r2.prevHash).toBe(r1.entryHash);
    expect(r0.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r0.entryHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("has no rewrite surface (append-only by construction)", () => {
    const log = newLog();
    expect("append" in log).toBe(true);
    expect("update" in log).toBe(false);
    expect("delete" in log).toBe(false);
  });

  it("produces a checkpoint over the chain head", () => {
    const log = newLog();
    const r0 = log.append(mkEvent(0));
    const r1 = log.append(mkEvent(1));
    const cp = log.checkpoint();
    expect(cp.length).toBe(2);
    expect(cp.headEntryHash).toBe(r1.entryHash);
    expect(typeof cp.signature).toBe("string");
    expect(r0.entryHash).not.toBe(r1.entryHash);
  });
});
