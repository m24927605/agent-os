/**
 * agt:proto:check — OUR AGT AgtDecision contract drift gate (RED-first). Mirrors
 * src/runtime/spendguard/proto/spendguard-proto-check.test.ts.
 *
 * Pins three facts by command, not by eye:
 *   - the gate is wired into `pnpm run verify`;
 *   - it passes (exit 0) for the committed, pinned proto + generated TS stub;
 *   - it fails closed (exit != 0) when the proto / manifest is absent (AGT_PROTO_DIR override).
 *
 * The drift mutation (edit the .proto without re-pinning -> exit != 0) is exercised here too: we
 * append a comment to a TEMP COPY of the proto, point AGT_PROTO_DIR at it (with the OLD manifest), and
 * assert the gate goes RED — proving the pin actually guards the contract.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/runtime/agt/proto/agt-proto-check.test.ts -> repo root is four levels up.
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const protoDir = join(repoRoot, "src", "runtime", "agt", "proto");

function runScript(env: Record<string, string> = {}): number {
  try {
    execFileSync("bash", [join(repoRoot, "scripts", "agt-proto-check.sh")], {
      env: { ...process.env, ...env },
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe("agt:proto:check — pinned AGT AgtDecision contract drift gate", () => {
  it("wires agt:proto:check into pnpm run verify", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["agt:proto:check"]).toBeDefined();
    expect(pkg.scripts["agt:proto:gen"]).toBeDefined();
    expect(pkg.scripts.verify).toContain("agt:proto:check");
  });

  it("passes (exit 0) for the committed, pinned proto + generated TS stub", () => {
    expect(runScript()).toBe(0);
  });

  it("fails closed (exit != 0) when the AGT proto is missing", () => {
    const empty = mkdtempSync(join(tmpdir(), "agent-os-agt-proto-absent-"));
    try {
      expect(runScript({ AGT_PROTO_DIR: empty })).not.toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("fails closed (exit != 0) when the proto is mutated without re-pinning (drift gate works)", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-os-agt-proto-drift-"));
    try {
      // Copy the OLD manifest unchanged, but a MUTATED proto -> the pin must no longer match.
      copyFileSync(
        join(protoDir, "agt_decision.subset.sha256"),
        join(dir, "agt_decision.subset.sha256"),
      );
      const proto = readFileSync(join(protoDir, "agt_decision.subset.proto"), "utf8");
      writeFileSync(
        join(dir, "agt_decision.subset.proto"),
        `${proto}\n// drift: an unpinned edit must fail the gate\n`,
      );
      expect(runScript({ AGT_PROTO_DIR: dir })).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
