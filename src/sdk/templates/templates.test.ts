/**
 * SLICE-P2R-R9-S4 — ToolManifest authoring template: tests (RED-first).
 *
 * This slice adds NO schema logic (schema is R3). It delivers an author-copyable template plus the
 * authoring docs, and these tests prove — by command — that the template is a CONSUMER of R3's
 * `parseToolManifest` and is bound by R3's two consistency guardrails:
 *   Guardrail A: sideEffect "none"        => idempotent: true
 *   Guardrail B: sideEffect "destructive" => requiresApproval: true
 *
 * What is pinned here:
 *   (1) the in-tree `exampleToolManifest` object parses successfully (legal 9-field, guardrails met);
 *   (2) the ON-DISK `tool-manifest.example.json` — the exact file `agentos manifest lint` consumes —
 *       parses successfully and is byte-equivalent to the in-tree object (no drift between docs/CLI
 *       artifact and the programmatic export);
 *   (3) a deliberate violating fixture (destructive + requiresApproval:false) is REJECTED by parse
 *       (the adversarial mutation in the spec §6 — proves the template is held to R3's guardrails);
 *   (4) the template carries no secret-shaped values; `bundleRefOnly` examples use only a bundleRef
 *       reference string (e.g. "github:PAT:prod"), never a literal credential.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseToolManifest } from "../../tools/index.js";
import { exampleToolManifest, loadExampleToolManifest } from "./index.js";

const jsonPath = fileURLToPath(new URL("./tool-manifest.example.json", import.meta.url));

describe("ToolManifest authoring template (R9-S4)", () => {
  it("the in-tree exampleToolManifest parses via R3 parseToolManifest (legal 9-field, guardrails met)", () => {
    const m = parseToolManifest(exampleToolManifest);
    // All nine declared fields survive parse.
    expect(Object.keys(m).sort()).toEqual(
      [
        "action",
        "bundleRefOnly",
        "description",
        "idempotent",
        "name",
        "requiresApproval",
        "resourcePattern",
        "sideEffect",
        "version",
      ].sort(),
    );
  });

  it("loadExampleToolManifest() returns the parsed manifest", () => {
    expect(loadExampleToolManifest()).toEqual(parseToolManifest(exampleToolManifest));
  });

  it("the on-disk tool-manifest.example.json (what `manifest lint` reads) parses and matches the export", () => {
    const onDisk = JSON.parse(readFileSync(jsonPath, "utf8")) as unknown;
    // The CLI-consumed artifact must itself be legal...
    expect(() => parseToolManifest(onDisk)).not.toThrow();
    // ...and must not drift from the programmatic export.
    expect(onDisk).toEqual(exampleToolManifest);
  });

  it("rejects the documented violating fixture (destructive + requiresApproval:false) — guardrail B holds", () => {
    const violating = { ...(exampleToolManifest as Record<string, unknown>) };
    violating.sideEffect = "destructive";
    violating.requiresApproval = false;
    expect(() => parseToolManifest(violating)).toThrow();
  });

  it("carries no secret-shaped values; bundleRef example is a reference string only", () => {
    const raw = readFileSync(jsonPath, "utf8");
    // High-signal credential shapes that must never appear in an author template.
    const secretShapes = [
      /sk-[A-Za-z0-9]{16,}/,
      /gh[pousr]_[A-Za-z0-9]{20,}/,
      /AKIA[0-9A-Z]{16}/,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    ];
    for (const re of secretShapes) {
      expect(raw).not.toMatch(re);
    }
    // bundleRefOnly is declared true: the manifest references credentials by reference, never inline.
    expect(exampleToolManifest).toMatchObject({ bundleRefOnly: true });
  });
});
