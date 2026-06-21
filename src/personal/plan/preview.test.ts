import { describe, expect, it } from "vitest";
import { parseAgentContext } from "../../iam/ids.js";
import { StructuredIntent } from "../intent/index.js";
import { renderPlanPreview } from "./index.js";

// A valid zero-skill caller identity (same shape as the S1/S2 tests).
const ctx = parseAgentContext({
  actorId: "user-1",
  tenantId: "personal",
  projectId: "home",
  taskId: "task-1",
  requestId: "req-1",
});

// Build a StructuredIntent through its own validator so the test exercises the real shape S3
// consumes (never a hand-rolled object that could drift from the schema).
function intentOf(action: string, targets: string[], rawText: string): StructuredIntent {
  return StructuredIntent.parse({ action, targets, context: ctx, rawText });
}

describe("renderPlanPreview — plain-language projection of a StructuredIntent", () => {
  it("lists one step per target and surfaces every target as an affected resource", () => {
    const intent = intentOf("backup", ["photos", "docs", "music"], "backup photos docs music");
    const preview = renderPlanPreview(intent);

    expect(preview.steps).toHaveLength(intent.targets.length);
    for (const step of preview.steps) {
      expect(typeof step).toBe("string");
      expect(step.length).toBeGreaterThan(0);
    }
    expect(preview.affectedResources).toEqual(intent.targets);
    expect(preview.title.length).toBeGreaterThan(0);
    expect(preview.summary.length).toBeGreaterThan(0);
  });

  it("is deterministic — same intent yields a deeply-equal preview", () => {
    const intent = intentOf("move", ["a", "b"], "move a b");
    expect(renderPlanPreview(intent)).toEqual(renderPlanPreview(intent));
  });

  it("produces a non-empty friendly title and summary for a minimal single-target intent", () => {
    const intent = intentOf("open", ["readme"], "open readme");
    const preview = renderPlanPreview(intent);

    expect(preview.title.length).toBeGreaterThan(0);
    expect(preview.summary.length).toBeGreaterThan(0);
    expect(preview.steps).toHaveLength(1);
    expect(preview.affectedResources).toEqual(["readme"]);
  });

  it("redacts a secret-shaped canary so no preview field leaks it (adversarial exit redaction)", () => {
    // Secret-shaped canary assembled at runtime — NEVER a source literal, so scan_secrets.sh
    // does not flag this file (design §1 invariant 4: canary is an in-memory sentinel).
    const canary = `sk-${"a".repeat(32)}`;

    // A mis-wired upstream could smuggle the canary into a target. The preview MUST scrub it on the
    // way out (exit redaction), regardless of where it landed.
    const intent: StructuredIntent = {
      action: "share",
      targets: [`report-${canary}`],
      context: ctx,
      rawText: "share report",
    };
    const preview = renderPlanPreview(intent);

    const allText = [
      preview.title,
      preview.summary,
      ...preview.steps,
      ...preview.affectedResources,
    ].join("\n");
    expect(allText).not.toContain(canary);
  });

  it("honors an injected redactor (default is the audit barrel redactor)", () => {
    const intent = intentOf("copy", ["secretfile"], "copy secretfile");
    const preview = renderPlanPreview(intent, { redact: (s) => s.replaceAll("secretfile", "X") });

    const allText = [
      preview.title,
      preview.summary,
      ...preview.steps,
      ...preview.affectedResources,
    ].join("\n");
    expect(allText).not.toContain("secretfile");
    expect(preview.affectedResources).toEqual(["X"]);
  });
});
