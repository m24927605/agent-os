import { describe, expect, it } from "vitest";
import { type AppendResponseShape, parseAppendResponse } from "./index.js";

/**
 * RED-first spec for the fail-closed AppendResponse parser (slice P2R-R2-S1, design §5/§6).
 * Mirrors kernel/internal/client/client.go:38-48: a receipt is the ONLY success path; an error
 * branch, an empty oneof, and the proto-zero CODE_UNSPECIFIED all THROW (deny-by-default).
 *
 * The thrown message may carry the typed code + static detail, but NEVER the canonical_event
 * content (proto/ingest.proto:37 — detail is "static reason / field name only").
 */
describe("parseAppendResponse (fail-closed oneof parse)", () => {
  it("receipt branch: a legal receipt maps to AppendReceipt with the 4 fields equal", () => {
    const resp: AppendResponseShape = {
      receipt: {
        sequence: 7,
        contentHash: "sha256:cccc",
        prevHash: "sha256:pppp",
        entryHash: "sha256:eeee",
      },
    };
    const receipt = parseAppendResponse(resp);
    expect(receipt.sequence).toBe(7);
    expect(receipt.contentHash).toBe("sha256:cccc");
    expect(receipt.prevHash).toBe("sha256:pppp");
    expect(receipt.entryHash).toBe("sha256:eeee");
  });

  it("error branch (e.g. SEQUENCE_REPLAY): throws, message carries code + detail", () => {
    const resp: AppendResponseShape = {
      error: { code: "SEQUENCE_REPLAY", detail: "sequence 3 already settled" },
    };
    expect(() => parseAppendResponse(resp)).toThrow(/SEQUENCE_REPLAY/);
    expect(() => parseAppendResponse(resp)).toThrow(/sequence 3 already settled/);
  });

  it("empty oneof (both undefined): throws (deny-by-default, never a falsy receipt)", () => {
    const resp: AppendResponseShape = {};
    expect(() => parseAppendResponse(resp)).toThrow();
  });

  it("CODE_UNSPECIFIED (proto zero): throws, never treated as success", () => {
    const resp: AppendResponseShape = {
      error: { code: "CODE_UNSPECIFIED", detail: "" },
    };
    expect(() => parseAppendResponse(resp)).toThrow(/CODE_UNSPECIFIED/);
  });

  it("never echoes canonical_event content in the thrown message", () => {
    const canary = "CANARY-CANONICAL-EVENT-do-not-echo";
    // The detail field is static-reason-only; even if a caller-supplied detail were polluted, the
    // parser's thrown reason must remain a static deny reason and the event content never appears.
    const resp: AppendResponseShape = {
      error: { code: "MALFORMED", detail: "canonical_event not parseable" },
    };
    try {
      parseAppendResponse(resp);
      throw new Error("expected parseAppendResponse to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain(canary);
    }
  });
});
