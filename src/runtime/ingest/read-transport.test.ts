/**
 * RED-first tests for the WORM read-back reader (slice P2R-PV-S3b).
 *
 * `createEntriesReader` calls the kernel `ListEntries` RPC and folds each returned `Entry` into a
 * `LogEntry` (JSON.parse the canonical_event bytes into an AuditEvent, carry prev_hash/entry_hash).
 * These run with an IN-PROCESS injected `AppendService` stub — zero network. They lock the reader's
 * load-bearing invariant: it is FAIL-CLOSED. Any RPC reject OR any canonical_event that is not valid
 * JSON makes the WHOLE read REJECT — the reader NEVER returns a partial array a caller might trust.
 */
import { describe, expect, it } from "vitest";
import type { AppendService, ListEntriesResponse } from "../_generated/ingest/ingest.js";
import { createEntriesReader } from "./read-transport.js";

/** An in-process `AppendService` whose ListEntries is driven by an injected handler — zero network. */
function stubClient(listEntries: () => Promise<ListEntriesResponse>): AppendService {
  return {
    Append: () => Promise.reject(new Error("Append not exercised in this test")),
    Checkpoint: () => Promise.reject(new Error("Checkpoint not exercised in this test")),
    ListEntries: listEntries,
  };
}

const enc = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

const SYNTH = {
  eventId: "00000000-0000-4000-8000-000000000001",
  requestId: "req-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  actorId: "agent:claude",
  action: "tool:invoke",
  resource: "personal:backup",
  policyDecision: { effect: "allow", reason: "ok" },
  result: "success",
};

describe("createEntriesReader (S3b)", () => {
  it("folds each Entry into a LogEntry: parses canonical_event JSON, carries prev/entry hash + sequence", async () => {
    const client = stubClient(() =>
      Promise.resolve({
        entries: [
          {
            sequence: 0,
            canonicalEvent: enc(SYNTH),
            prevHash: `sha256:${"0".repeat(64)}`,
            entryHash: `sha256:${"a".repeat(64)}`,
          },
        ],
      }),
    );
    const read = createEntriesReader({ endpoint: "passthrough:fake", client });

    const entries = await read();
    expect(entries.length).toBe(1);
    const e = entries[0];
    if (e === undefined) return;
    expect(e.sequence).toBe(0);
    expect(e.prevHash).toBe(`sha256:${"0".repeat(64)}`);
    expect(e.entryHash).toBe(`sha256:${"a".repeat(64)}`);
    expect(e.event.action).toBe("tool:invoke");
    expect(e.event.resource).toBe("personal:backup");
    expect(e.event.taskId).toBe("task-1");
  });

  it("fail-closed: a ListEntries RPC reject REJECTS the reader (never a partial array)", async () => {
    const client = stubClient(() => Promise.reject(new Error("connection refused")));
    const read = createEntriesReader({ endpoint: "passthrough:fake", client });

    await expect(read()).rejects.toThrow();
  });

  it("fail-closed: a canonical_event that is not valid JSON REJECTS the whole read (no partial)", async () => {
    const client = stubClient(() =>
      Promise.resolve({
        entries: [
          {
            sequence: 0,
            canonicalEvent: enc(SYNTH),
            prevHash: `sha256:${"0".repeat(64)}`,
            entryHash: `sha256:${"a".repeat(64)}`,
          },
          {
            // Not JSON -> JSON.parse throws -> the WHOLE read must reject, not return [entry0].
            sequence: 1,
            canonicalEvent: new TextEncoder().encode("not-json{"),
            prevHash: `sha256:${"a".repeat(64)}`,
            entryHash: `sha256:${"b".repeat(64)}`,
          },
        ],
      }),
    );
    const read = createEntriesReader({ endpoint: "passthrough:fake", client });

    await expect(read()).rejects.toThrow();
  });
});
