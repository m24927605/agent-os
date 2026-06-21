import { describe, expect, it } from "vitest";
import { canonicalizeAuditEvent } from "../canonical.js";
import { type AuditClock, type AuditEventInput, createAuditEvent } from "../event.js";
import { createIngestClient } from "./client.js";
import type { AppendRequestShape, AppendResponseShape, AppendTransport } from "./transport.js";

/**
 * RED-first spec for the sync-commit IngestClient wrapper (slice P2R-R2-S2, design §2/§4/§6).
 *
 * createIngestClient(deps) returns a CommitAppender<AuditEvent, AppendReceipt> whose append():
 *  canonicalize(redact-inside) -> per-source monotonic sequence -> transport.append ->
 *  parseAppendResponse -> durable AppendReceipt. Any transport reject / parse throw propagates
 *  (commitgate aborts; the effect never happens). Only a success advances the sequence counter.
 *
 * The transport is an injected fake — zero network, zero vendor — so this is fully unit-testable.
 */

const clock: AuditClock = { now: () => "2026-06-19T00:00:00.000Z", newId: () => "evt-1" };

function makeEvent(overrides: Partial<AuditEventInput> = {}) {
  const input: AuditEventInput = {
    requestId: "req-1",
    tenantId: "tenant-a",
    projectId: "proj-1",
    taskId: "task-1",
    actorId: "agent:claude",
    action: "fs:read",
    resource: "/workspace/file.txt",
    policyDecision: { effect: "allow", reason: "matched allow rule" },
    result: "success",
    ...overrides,
  };
  return createAuditEvent(input, clock);
}

/** Records every request; resolves a deterministic receipt echoing the request sequence. */
class RecordingTransport implements AppendTransport {
  readonly requests: AppendRequestShape[] = [];
  async append(req: AppendRequestShape): Promise<AppendResponseShape> {
    this.requests.push(req);
    return {
      receipt: {
        sequence: req.sequence,
        contentHash: "sha256:cccc",
        prevHash: "sha256:pppp",
        entryHash: "sha256:eeee",
      },
    };
  }
}

describe("createIngestClient (canonicalize -> sequence -> transport -> receipt; fail-closed)", () => {
  it("happy: transport receives canonical bytes; receipt's 4 fields come from the response", async () => {
    const transport = new RecordingTransport();
    const client = createIngestClient({ transport, sourceId: "src-1" });
    const event = makeEvent();

    const receipt = await client.append(event);

    expect(transport.requests).toHaveLength(1);
    const sent = transport.requests[0];
    if (sent === undefined) throw new Error("expected a recorded request");
    expect(sent.sourceId).toBe("src-1");
    expect(sent.canonicalEvent).toEqual(canonicalizeAuditEvent(event));
    expect(receipt.sequence).toBe(0);
    expect(receipt.contentHash).toBe("sha256:cccc");
    expect(receipt.prevHash).toBe("sha256:pppp");
    expect(receipt.entryHash).toBe("sha256:eeee");
  });

  it("monotonic sequence: three successful appends send sequence 0, 1, 2", async () => {
    const transport = new RecordingTransport();
    const client = createIngestClient({ transport, sourceId: "src-1" });

    await client.append(makeEvent());
    await client.append(makeEvent());
    await client.append(makeEvent());

    expect(transport.requests.map((r) => r.sequence)).toEqual([0, 1, 2]);
  });

  it("fail-closed: a transport reject propagates AND does not advance the counter (retry resends same sequence)", async () => {
    let failNext = true;
    const seen: number[] = [];
    const transport: AppendTransport = {
      async append(req) {
        seen.push(req.sequence);
        if (failNext) {
          failNext = false;
          throw new Error("transport down");
        }
        return {
          receipt: {
            sequence: req.sequence,
            contentHash: "sha256:c",
            prevHash: "sha256:p",
            entryHash: "sha256:e",
          },
        };
      },
    };
    const client = createIngestClient({ transport, sourceId: "src-1" });

    await expect(client.append(makeEvent())).rejects.toThrow(/transport down/);
    // Counter NOT advanced: the retry must resend the SAME sequence (0), then succeed.
    const receipt = await client.append(makeEvent());
    expect(seen).toEqual([0, 0]);
    expect(receipt.sequence).toBe(0);
  });

  it("fail-closed: a transport `error` oneof rejects (via parseAppendResponse) and does not advance the counter", async () => {
    const seen: number[] = [];
    let errorNext = true;
    const transport: AppendTransport = {
      async append(req) {
        seen.push(req.sequence);
        if (errorNext) {
          errorNext = false;
          return { error: { code: "INTERNAL", detail: "durable commit failed" } };
        }
        return {
          receipt: {
            sequence: req.sequence,
            contentHash: "sha256:c",
            prevHash: "sha256:p",
            entryHash: "sha256:e",
          },
        };
      },
    };
    const client = createIngestClient({ transport, sourceId: "src-1" });

    await expect(client.append(makeEvent())).rejects.toThrow(/INTERNAL/);
    const receipt = await client.append(makeEvent());
    expect(seen).toEqual([0, 0]);
    expect(receipt.sequence).toBe(0);
  });

  it("credential non-leak: a runtime-assembled secret canary never reaches the transport bytes", async () => {
    // Canary built at runtime (never a source literal) so scan_secrets.sh does not flag this file.
    const canary = `sk-${"z".repeat(32)}`;
    const transport = new RecordingTransport();
    const client = createIngestClient({ transport, sourceId: "src-1" });

    await client.append(makeEvent({ resource: `/workspace/${canary}` }));

    const recorded = transport.requests[0];
    if (recorded === undefined) throw new Error("expected a recorded request");
    const sentBytes = new TextDecoder().decode(recorded.canonicalEvent);
    expect(sentBytes).not.toContain(canary);
    expect(sentBytes).not.toContain("sk-z");
  });
});
