import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/build/verify-cascade.test.ts -> repo root is two levels up.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function runScript(script: string, env: Record<string, string> = {}): number {
  try {
    execFileSync("bash", [join(repoRoot, "scripts", script)], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe("verify polyglot cascade — wired + fail-closed", () => {
  it("wires verify:go and verify:py into pnpm run verify", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts.verify).toContain("verify:go");
    expect(pkg.scripts.verify).toContain("verify:py");
    expect(pkg.scripts["verify:go"]).toBeDefined();
    expect(pkg.scripts["verify:py"]).toBeDefined();
  });

  it("skips cleanly (exit 0) when a language plane is absent", () => {
    const absent = join(tmpdir(), "agent-os-absent-plane-do-not-create");
    expect(runScript("verify-go.sh", { VERIFY_GO_PLANE: absent })).toBe(0);
    expect(runScript("verify-py.sh", { VERIFY_PY_PLANE: absent })).toBe(0);
  });

  it("fails closed (exit != 0) when a language plane is present but its gate is unconfigured", () => {
    const goPlane = mkdtempSync(join(tmpdir(), "agent-os-go-plane-"));
    const pyPlane = mkdtempSync(join(tmpdir(), "agent-os-py-plane-"));
    try {
      expect(runScript("verify-go.sh", { VERIFY_GO_PLANE: goPlane })).not.toBe(0);
      expect(runScript("verify-py.sh", { VERIFY_PY_PLANE: pyPlane })).not.toBe(0);
    } finally {
      rmSync(goPlane, { recursive: true, force: true });
      rmSync(pyPlane, { recursive: true, force: true });
    }
  });
});
