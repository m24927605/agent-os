import { describe, expect, it } from "vitest";
import { type AgentContext, parseAgentContext } from "../../iam/ids.js";
import { type ReceiveOutcome, StructuredIntent, receiveText } from "./index.js";

// A valid zero-skill caller identity. The Personal surface user is a single human; the
// AgentContext is supplied by the host, not typed by the user.
const ctx: AgentContext = parseAgentContext({
  actorId: "user-1",
  tenantId: "personal",
  projectId: "home",
  taskId: "task-1",
  requestId: "req-1",
});

// Secret-shaped canary assembled at runtime — NEVER a source literal, so scan_secrets.sh
// does not flag this file (design §1 invariant 4: canary is an in-memory sentinel).
const SK = `sk-${"a".repeat(32)}`;

describe("IntentGateway.receiveText — text-first intent contract", () => {
  it("clean complete text + ctx → status:intent, parseable StructuredIntent", () => {
    const out = receiveText("backup my photos folder", ctx);
    expect(out.status).toBe("intent");
    if (out.status !== "intent") throw new Error("expected intent");
    // The returned intent must round-trip through the strict schema.
    expect(() => StructuredIntent.parse(out.intent)).not.toThrow();
    expect(out.intent.action).toBe("backup");
    expect(out.intent.targets).toContain("photos");
  });

  it("missing required field (no action target) → needs-clarification listing the field", () => {
    const out = receiveText("backup", ctx);
    expect(out.status).toBe("needs-clarification");
    if (out.status !== "needs-clarification") throw new Error("expected needs-clarification");
    expect(out.missing).toContain("targets");
  });

  it("deny-by-default: empty / unparseable text → status:denied (never an intent)", () => {
    for (const bad of ["", "   ", "\n\t"]) {
      const out = receiveText(bad, ctx);
      expect(out.status).toBe("denied");
      expect((out as { status: string }).status).not.toBe("intent");
    }
  });

  it("deny-by-default: malformed AgentContext → status:denied", () => {
    const out = receiveText("backup my photos", { actorId: "" } as unknown as AgentContext);
    expect(out.status).toBe("denied");
  });

  it("credential non-leak (adversarial): secret-like canary in text is redacted, never returned", () => {
    const out = receiveText(`backup my secrets using ${SK}`, ctx);
    // Whatever the outcome, the raw secret must not survive anywhere in the result.
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(SK);
    expect(serialized).not.toContain("sk-aaaa");
    if (out.status === "intent") {
      expect(out.intent.rawText).not.toContain(SK);
      expect(out.intent.rawText).toContain("[REDACTED]");
    }
  });

  it("custom injected redactor is honoured (DI seam, low coupling)", () => {
    const redact = (s: string): string => s.replace(/photos/g, "XXX");
    const out = receiveText("backup my photos", ctx, { redact });
    if (out.status !== "intent") throw new Error("expected intent");
    expect(out.intent.rawText).not.toContain("photos");
    expect(out.intent.rawText).toContain("XXX");
  });

  it("StructuredIntent is .strict(): an extra field fails parse (fail-closed)", () => {
    const valid = {
      action: "backup",
      targets: ["photos"],
      context: ctx,
      rawText: "backup my photos folder",
    };
    expect(() => StructuredIntent.parse(valid)).not.toThrow();
    expect(() => StructuredIntent.parse({ ...valid, surprise: 1 })).toThrow();
  });

  it("ReceiveOutcome union is exhaustively typed", () => {
    const out: ReceiveOutcome = receiveText("backup my photos", ctx);
    expect(["intent", "needs-clarification", "denied"]).toContain(out.status);
  });
});
