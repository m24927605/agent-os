/**
 * SLICE-P2R-R9-S2 — TS SDK author barrel: tests.
 *
 * The sdk barrel is a CONVERGENT author-facing surface: it re-exports ONLY what a third-party tool
 * author needs (R3 ToolManifest contract; the four vendor-neutral Port fakes/types; nothing else) and
 * deliberately does NOT leak core governance internals. These tests pin BOTH invariants by command:
 *   (1) author-facing symbols are present and are the REAL R3 schema (not a copy);
 *   (2) named core-internal symbols are absent (anti-leak);
 *   (3) the barrel only consumes other modules via their public `index.ts` barrels — proven by running
 *       the real `not-to-internal` dependency-cruiser gate over `src` (exit 0) and over a deliberate
 *       deep-import fixture (exit != 0), so the boundary is enforced by command, not by eye.
 */
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import * as sdk from "./index.js";

// src/sdk/index.test.ts -> repo root is two levels up.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const bin = join(repoRoot, "node_modules/.bin/depcruise");

type DepCruiseViolation = { rule?: { name?: string } };

/** Violations as JSON (`--output-type json` exits 0 regardless; caller inspects). */
function violatedRules(targetRelPath: string): string[] {
  const args = [targetRelPath, "--config", ".dependency-cruiser.cjs", "--output-type", "json"];
  let stdout: string;
  try {
    stdout = execFileSync(bin, args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
  } catch (err) {
    const e = err as { stdout?: string | Buffer };
    if (e.stdout === undefined) throw err;
    stdout = e.stdout.toString();
  }
  const report = JSON.parse(stdout) as { summary?: { violations?: DepCruiseViolation[] } };
  return (report.summary?.violations ?? []).map((v) => v.rule?.name ?? "").filter(Boolean);
}

/** Exit code EXACTLY as `deps:check` runs it (default output type DOES exit non-zero on error). */
function gateExitCode(targetRelPath: string): number {
  const args = [targetRelPath, "--config", ".dependency-cruiser.cjs"];
  try {
    execFileSync(bin, args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe("sdk barrel — exposes the author-facing surface", () => {
  it("re-exports the R3 ToolManifest contract (parse fn + zod schema + side-effect type)", () => {
    expect(typeof sdk.parseToolManifest).toBe("function");
    // ToolManifest is a zod schema at runtime (has .parse); ToolSideEffect is type-only (no runtime).
    expect(typeof sdk.ToolManifest?.parse).toBe("function");
  });

  it("re-exports a constructible Fake for each of the four author-facing Ports", () => {
    // Brain (Scripted/Echo fakes), Substrate (Fake), Cost (InMemory), Hosting (InMemory).
    expect(typeof sdk.ScriptedBrain).toBe("function");
    expect(typeof sdk.EchoBrain).toBe("function");
    expect(typeof sdk.FakeSandboxAdapter).toBe("function");
    expect(typeof sdk.InMemoryCostGate).toBe("function");
    expect(typeof sdk.InMemoryAgentHosting).toBe("function");
    // Each is actually constructible (author can stand one up locally).
    expect(new sdk.EchoBrain()).toBeInstanceOf(sdk.EchoBrain);
    expect(new sdk.FakeSandboxAdapter()).toBeInstanceOf(sdk.FakeSandboxAdapter);
  });

  it("re-exports the REAL R3 schema: a valid 9-field manifest parses; an unknown field throws", () => {
    const valid = {
      name: "demo.read",
      version: "1.0.0",
      description: "reads a thing",
      action: "read",
      resourcePattern: "res://*",
      sideEffect: "read",
      idempotent: true,
      requiresApproval: false,
      bundleRefOnly: true,
    };
    expect(sdk.parseToolManifest(valid)).toMatchObject({ name: "demo.read", sideEffect: "read" });
    // `.strict()` schema => unknown field is a parse failure (fail-closed), proving this is R3's
    // real schema and not a hand-rolled copy on the barrel.
    expect(() => sdk.parseToolManifest({ ...valid, attacker: "x" })).toThrow();
  });
});

describe("sdk barrel — anti-leak: core governance internals are NOT re-exported", () => {
  it("does NOT expose policy evaluator / dedup internals", () => {
    const leaked = sdk as Record<string, unknown>;
    expect(leaked.evaluatePolicy).toBeUndefined();
    expect(leaked.matchResource).toBeUndefined();
    expect(leaked.matchDenyResource).toBeUndefined();
  });

  it("does NOT expose audit kernel internals", () => {
    const leaked = sdk as Record<string, unknown>;
    expect(leaked.verifyChain).toBeUndefined();
  });
});

describe("sdk barrel — boundary is enforced by command (no deep import, no cycle)", () => {
  // `not-to-internal` is anchored to the repo-root `^src/`, so the violation must live inside the
  // REAL src tree to be exercised. We write a throwaway probe file under src/sdk/, run the gate
  // EXACTLY as `deps:check` does, then delete it. This proves — by command — that a deep import into
  // another module's internal file (not its index barrel) makes the gate go red.
  const probe = join(repoRoot, "src/sdk/__deepimport_probe__.ts");
  afterEach(() => {
    rmSync(probe, { force: true });
  });

  it("the real `src` tree has NO not-to-internal or no-circular violation (deps:check exit 0)", () => {
    const violations = violatedRules("src");
    expect(violations).not.toContain("not-to-internal");
    expect(violations).not.toContain("no-circular");
    expect(gateExitCode("src")).toBe(0);
  });

  it("FIRES not-to-internal when sdk deep-imports a module INTERNAL file (probe, exit != 0)", () => {
    // Deep import of ../tools/manifest.ts — a NON-barrel internal file. Must trip not-to-internal.
    writeFileSync(
      probe,
      'import { parseToolManifest } from "../tools/manifest.js";\nexport const x = parseToolManifest;\n',
    );
    expect(violatedRules("src")).toContain("not-to-internal");
    expect(gateExitCode("src")).not.toBe(0);
  });

  it("does NOT fire when sdk consumes a module via its public barrel (probe, exit 0)", () => {
    // Same symbol, but via the public ../tools/index.js barrel — the legal cross-module entry.
    writeFileSync(
      probe,
      'import { parseToolManifest } from "../tools/index.js";\nexport const x = parseToolManifest;\n',
    );
    expect(violatedRules("src")).not.toContain("not-to-internal");
    expect(gateExitCode("src")).toBe(0);
  });
});
