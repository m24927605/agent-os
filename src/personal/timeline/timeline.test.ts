import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AuditEventInput, createAuditEvent } from "../../audit/event.js";
import { InMemoryAppendOnlyLog, type LogEntry } from "../../audit/kernel/log.js";
import { buildTaskTimeline } from "./index.js";

// Deterministic clock so fixture events (and thus timeline order) are reproducible.
let tick = 0;
const clock = {
  now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
  newId: () => `event-${tick}`,
};

function inputOf(over: Partial<AuditEventInput> = {}): AuditEventInput {
  return {
    requestId: "req-1",
    tenantId: "personal",
    projectId: "home",
    taskId: "task-1",
    actorId: "user-1",
    action: "backup",
    resource: "photos",
    policyDecision: { effect: "allow", reason: "owner approved" },
    result: "success",
    ...over,
  };
}

// Build a real append-only chain so the test consumes the EXACT LogEntry shape the WORM kernel
// produces (never a hand-rolled object that could drift from the kernel contract).
function chainOf(inputs: AuditEventInput[]): LogEntry[] {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const log = new InMemoryAppendOnlyLog({ publicKey, privateKey });
  for (const input of inputs) {
    log.append(createAuditEvent(input, clock));
  }
  return log.entries().slice();
}

describe("buildTaskTimeline — read-only plain-language projection of the WORM chain", () => {
  it("projects N LogEntry into N TimelineEvent with strictly increasing, chain-aligned sequence", () => {
    const entries = chainOf([
      inputOf({ action: "backup", resource: "photos" }),
      inputOf({ action: "move", resource: "docs" }),
      inputOf({ action: "delete", resource: "tmp" }),
    ]);

    const timeline = buildTaskTimeline(entries);

    expect(timeline).toHaveLength(entries.length);
    const sequences = timeline.map((e) => e.sequence);
    expect(sequences).toEqual(entries.map((e) => e.sequence));
    const strictlyIncreasing = sequences.every(
      (seq, i) => i === 0 || seq > (sequences[i - 1] ?? Number.NEGATIVE_INFINITY),
    );
    expect(strictlyIncreasing).toBe(true);
  });

  it("renders a plain-language headline reflecting action/result, including a denied event", () => {
    const entries = chainOf([
      inputOf({ action: "backup", resource: "photos", result: "success" }),
      inputOf({
        action: "delete",
        resource: "system32",
        result: "denied",
        policyDecision: { effect: "deny", reason: "outside allowed paths" },
      }),
    ]);

    const [first, denied] = buildTaskTimeline(entries);
    const [firstEntry] = entries;

    expect(first?.headline).toContain("photos");
    expect(first?.at).toBe(firstEntry?.event.timestamp);
    // A denied event must read as plain-language refusal carrying the reason.
    expect(denied?.headline).toContain("被拒絕");
    expect(denied?.detail).toContain("outside allowed paths");
  });

  it("is read-only: frozen entries are accepted and the returned array does not mutate input", () => {
    const entries = chainOf([inputOf({ action: "backup", resource: "photos" })]);
    const frozen = Object.freeze(entries.map((e) => Object.freeze({ ...e })));

    const timeline = buildTaskTimeline(frozen);

    // Mutating the projection must not touch the input chain.
    timeline.push({ at: "x", headline: "x", detail: "x", sequence: 999 });
    const [survivor] = frozen;
    expect(frozen).toHaveLength(1);
    expect(survivor?.sequence).toBe(0);
  });

  it("never adds, drops, or reorders entries — sequence multiset is preserved", () => {
    const entries = chainOf([
      inputOf({ action: "a", resource: "r0" }),
      inputOf({ action: "b", resource: "r1" }),
      inputOf({ action: "c", resource: "r2" }),
      inputOf({ action: "d", resource: "r3" }),
    ]);
    // Hand the projector an out-of-order array; it must restore canonical sequence order
    // without inventing or dropping any sequence.
    const [e0, e1, e2, e3] = entries;
    const shuffled = [e2, e0, e3, e1].filter((e): e is LogEntry => e !== undefined);

    const timeline = buildTaskTimeline(shuffled);

    expect(timeline).toHaveLength(entries.length);
    expect(new Set(timeline.map((e) => e.sequence))).toEqual(
      new Set(entries.map((e) => e.sequence)),
    );
    expect(timeline.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
  });

  it("optionally filters to a single taskId without renumbering sequence", () => {
    const entries = chainOf([
      inputOf({ taskId: "task-1", action: "backup", resource: "photos" }),
      inputOf({ taskId: "task-2", action: "move", resource: "docs" }),
      inputOf({ taskId: "task-1", action: "delete", resource: "tmp" }),
    ]);

    const timeline = buildTaskTimeline(entries, { taskId: "task-1" });

    expect(timeline.map((e) => e.sequence)).toEqual([0, 2]);
  });

  it("redacts a secret-shaped canary so no timeline field leaks it (adversarial exit redaction)", () => {
    // Secret-shaped canary assembled at runtime — NEVER a source literal (design §1 invariant 4).
    const canary = `sk-${"a".repeat(32)}`;
    const entries = chainOf([inputOf({ action: "share", resource: `report-${canary}` })]);

    const timeline = buildTaskTimeline(entries);

    const allText = timeline
      .flatMap((e) => [e.at, e.headline, e.detail, String(e.sequence)])
      .join("\n");
    expect(allText).not.toContain(canary);
  });

  it("honors an injected redactor (default is the audit barrel redactor)", () => {
    const entries = chainOf([inputOf({ action: "copy", resource: "secretfile" })]);

    const timeline = buildTaskTimeline(entries, {
      redact: (s) => s.replaceAll("secretfile", "X"),
    });

    const allText = timeline.flatMap((e) => [e.headline, e.detail]).join("\n");
    expect(allText).not.toContain("secretfile");
  });
});
