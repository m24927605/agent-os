import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/build/no-vendor-in-core.test.ts -> repo root is two levels up.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(import.meta.url);

// The five committed default-adapter vendors. Pluggability HARD CONSTRAINT (AGENTS.md
// "Pluggable components — NO forced vendor combination"): NONE may be named/imported by the core.
const VENDOR_TOKENS = ["hermes", "nemoclaw", "openshell", "agt", "spendguard"] as const;

type DepCruiseViolation = { rule?: { name?: string; severity?: string } };

const bin = join(repoRoot, "node_modules/.bin/depcruise");

/** Violations as JSON. `--output-type json` deliberately exits 0 (caller decides), so just parse. */
function violatedRules(fixtureRelPath: string): string[] {
  const args = [fixtureRelPath, "--config", ".dependency-cruiser.cjs", "--output-type", "json"];
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

/**
 * Exit code of the gate EXACTLY as `deps:check` runs it (default output type — which DOES exit
 * non-zero on an error-severity violation). This is the real "verify goes red" guarantee.
 */
function gateExitCode(fixtureRelPath: string): number {
  const args = [fixtureRelPath, "--config", ".dependency-cruiser.cjs"];
  try {
    execFileSync(bin, args, { cwd: repoRoot, encoding: "utf8", stdio: "pipe" });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

function vendorMatcher(): RegExp {
  const config = require(join(repoRoot, ".dependency-cruiser.cjs")) as {
    forbidden: { name: string; to: { path: string } }[];
  };
  const rule = config.forbidden.find((r) => r.name === "no-vendor-in-core");
  if (!rule) throw new Error("no-vendor-in-core rule missing");
  return new RegExp(rule.to.path);
}

describe("no-vendor-in-core — pluggability HARD CONSTRAINT is command-verifiable", () => {
  it("the rule is wired in .dependency-cruiser.cjs at error severity, naming all five vendors", () => {
    const config = require(join(repoRoot, ".dependency-cruiser.cjs")) as {
      forbidden: { name: string; severity: string; from: unknown; to: unknown }[];
    };
    const rule = config.forbidden.find((r) => r.name === "no-vendor-in-core");
    expect(rule, "forbidden rule 'no-vendor-in-core' must exist").toBeDefined();
    expect(rule?.severity).toBe("error");

    const toMatcher = JSON.stringify(rule?.to);
    for (const token of VENDOR_TOKENS) {
      expect(toMatcher, `vendor token '${token}' must be forbidden`).toContain(token);
    }
    const fromMatcher = JSON.stringify(rule?.from);
    expect(fromMatcher).toContain("policy");
    expect(fromMatcher).toContain("iam");
    expect(fromMatcher).toContain("adapters");
  });

  it("FIRES when a core module imports a vendor adapter (bad fixture)", () => {
    expect(violatedRules("test/fixtures/pluggability/bad")).toContain("no-vendor-in-core");
  });

  it("makes depcruise EXIT NON-ZERO on a violation (the real 'verify fails' guarantee, not just a JSON entry)", () => {
    expect(gateExitCode("test/fixtures/pluggability/bad")).not.toBe(0);
    expect(gateExitCode("test/fixtures/pluggability/clean")).toBe(0);
  });

  it("the vendor matcher catches scoped (@vendor/) and suffixed (vendor-sdk) package names, not just bare tokens", () => {
    const re = vendorMatcher();
    for (const danger of [
      "src/runtime/openshell/adapter.ts",
      "../runtime/openshell-sdk/client.js",
      "node_modules/hermes-agent/index.js",
      "@hermes/agent",
      "@agt/core",
      "openshell-sdk",
      "spendguard-sdk",
      "nemoclaw.ts",
    ]) {
      expect(re.test(danger), `must flag vendor form: ${danger}`).toBe(true);
    }
    for (const benign of [
      "magtools/index.ts",
      "fragment.ts",
      "src/policy/evaluate.ts",
      "src/iam/agent-context.ts",
    ]) {
      expect(re.test(benign), `must NOT flag benign path: ${benign}`).toBe(false);
    }
  });

  it("does NOT fire when a core module imports another core module (clean fixture)", () => {
    expect(violatedRules("test/fixtures/pluggability/clean")).not.toContain("no-vendor-in-core");
  });

  it("the real src tree has no vendor-in-core violation", () => {
    expect(violatedRules("src")).not.toContain("no-vendor-in-core");
  });
});
