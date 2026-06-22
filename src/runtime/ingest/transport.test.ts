/**
 * RED-first tests for the concrete RPC AppendTransport adapter (slice P2R-R2-S6).
 *
 * These run with an IN-PROCESS injected `AppendService` stub (the S5 generated typed contract) — no
 * external gRPC process, no network. They lock the adapter's only job: map a success oneof to an
 * `AppendResponseShape` (handed to S1 `parseAppendResponse` for the receipt), and map EVERY transport
 * failure (RPC error, connection refused, timeout) to a REJECT (fail-closed — never a falsy receipt).
 *
 * The `error` oneof is NOT swallowed: the adapter returns it verbatim as `AppendResponseShape{error}`
 * so S1's parser is the single place that turns it into a throw — the adapter never decides success.
 */
import { describe, expect, it } from "vitest";
import { parseAppendResponse } from "../../audit/index.js";
import type { AppendRequestShape } from "../../audit/index.js";
import {
  AppendError_Code,
  type AppendRequest,
  type AppendResponse,
  type AppendService,
} from "../_generated/ingest/ingest.js";
import { createRpcAppendTransport } from "./transport.js";

const REQ: AppendRequestShape = {
  sourceId: "src-test",
  sequence: 0,
  canonicalEvent: new Uint8Array([1, 2, 3]),
};

/** An in-process `AppendService` whose Append is driven by an injected handler — zero network. */
function stubClient(handler: (req: AppendRequest) => Promise<AppendResponse>): AppendService {
  // Checkpoint is part of the AppendService contract (R10-S4) but is not exercised by the S6
  // transport tests; fail-closed so an accidental call surfaces rather than returning a faked anchor.
  return {
    Append: handler,
    Checkpoint: () => Promise.reject(new Error("Checkpoint not exercised in this test")),
    // ListEntries (P2R-PV-S3a) is part of the contract but not exercised by the S6 transport tests;
    // fail-closed so an accidental call surfaces rather than returning a faked entry set.
    ListEntries: () => Promise.reject(new Error("ListEntries not exercised in this test")),
  };
}

describe("createRpcAppendTransport (S6)", () => {
  it("happy: maps a receipt oneof to AppendResponseShape that S1 parses to an AppendReceipt", async () => {
    const client = stubClient((req) =>
      Promise.resolve({
        result: {
          $case: "receipt",
          receipt: {
            sequence: req.sequence,
            contentHash: "sha256:aa",
            prevHash: "sha256:bb",
            entryHash: "sha256:cc",
          },
        },
      }),
    );
    const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client });

    const shape = await transport.append(REQ);
    const receipt = parseAppendResponse(shape);
    expect(receipt).toEqual({
      sequence: 0,
      contentHash: "sha256:aa",
      prevHash: "sha256:bb",
      entryHash: "sha256:cc",
    });
  });

  it("forwards the request fields verbatim to the underlying client (no mutation)", async () => {
    let seen: AppendRequest | undefined;
    const client = stubClient((req) => {
      seen = req;
      return Promise.resolve({
        result: { $case: "error", error: { code: AppendError_Code.MALFORMED, detail: "x" } },
      });
    });
    const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client });
    await transport.append(REQ).catch(() => undefined);
    expect(seen).toMatchObject({
      sourceId: "src-test",
      sequence: 0,
      canonicalEvent: new Uint8Array([1, 2, 3]),
    });
  });

  it("fail-closed: a transport-level RPC error REJECTS (never a falsy receipt)", async () => {
    const client = stubClient(() => Promise.reject(new Error("connection refused")));
    const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client });

    await expect(transport.append(REQ)).rejects.toThrow();
  });

  it("fail-closed: a synchronous throw from the client REJECTS", async () => {
    const client = stubClient(() => {
      throw new Error("channel closed");
    });
    const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client });

    await expect(transport.append(REQ)).rejects.toThrow();
  });

  it("fail-closed: no response within timeoutMs REJECTS (timeout)", async () => {
    // The client never settles — only the timeout can resolve the race, and it must REJECT.
    const client = stubClient(() => new Promise<AppendResponse>(() => {}));
    const transport = createRpcAppendTransport({
      endpoint: "passthrough:fake",
      client,
      timeoutMs: 20,
    });

    await expect(transport.append(REQ)).rejects.toThrow(/timeout/i);
  });

  it("fail-closed: server error oneof is returned VERBATIM (adapter does not swallow it; S1 throws)", async () => {
    const client = stubClient(() =>
      Promise.resolve({
        result: {
          $case: "error",
          error: { code: AppendError_Code.SEQUENCE_REPLAY, detail: "sequence" },
        },
      }),
    );
    const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client });

    const shape = await transport.append(REQ);
    expect(shape.receipt).toBeUndefined();
    expect(shape.error).toEqual({ code: "SEQUENCE_REPLAY", detail: "sequence" });
    // The adapter never decided success — S1 is the single fail-closed decision point.
    expect(() => parseAppendResponse(shape)).toThrow(/append denied/);
  });

  it("fail-closed: an empty/absent oneof maps to an empty AppendResponseShape (S1 then throws)", async () => {
    const client = stubClient(() => Promise.resolve({ result: undefined }));
    const transport = createRpcAppendTransport({ endpoint: "passthrough:fake", client });

    const shape = await transport.append(REQ);
    expect(shape.receipt).toBeUndefined();
    expect(shape.error).toBeUndefined();
    expect(() => parseAppendResponse(shape)).toThrow(/empty response/);
  });
});
