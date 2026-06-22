import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/runtime/spendguard/proto/spendguard-proto-check.test.ts -> repo root is four levels up.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

function runScript(env: Record<string, string> = {}): number {
  try {
    execFileSync("bash", [join(repoRoot, "scripts", "spendguard-proto-check.sh")], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe("spendguard:proto:check — pinned SidecarAdapter contract drift gate", () => {
  it("wires spendguard:proto:check into pnpm run verify", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["spendguard:proto:check"]).toBeDefined();
    expect(pkg.scripts.verify).toContain("spendguard:proto:check");
  });

  it("passes (exit 0) for the committed, pinned vendored subset + generated TS stub", () => {
    expect(runScript()).toBe(0);
  });

  it("fails closed (exit != 0) when the vendored proto subset is missing", () => {
    // Point the gate at an empty dir: no vendored proto, no manifest, no stub.
    const empty = mkdtempSync(join(tmpdir(), "agent-os-spendguard-proto-absent-"));
    try {
      expect(runScript({ SPENDGUARD_PROTO_DIR: empty })).not.toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
