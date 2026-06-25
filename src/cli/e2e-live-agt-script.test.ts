/**
 * SLICE-R9c — `e2e:live-agt` gated-live script: hermetic gating test (RED-first).
 *
 * The live AGT end-to-end runs the autonomous path against a REAL Python AGT sidecar. That requires
 * the operator's sidecar (out of scope for this repo), so the script is GATED on `AGENTOS_LIVE_AGT`
 * (+ `AGT_UDS_PATH`). Absent the gate env it must print a clear SKIPPED line and exit 0 — never
 * fake-green, never block `pnpm run verify`.
 *
 * Pins three facts BY COMMAND (not by eye), all hermetic (no real sidecar):
 *   - `e2e:live-agt` is wired as a package.json script (mirrors `e2e:live-spendguard`);
 *   - it is NOT in `pnpm run verify` (gated-live scripts never gate the universal feedback loop);
 *   - running `bash scripts/e2e-live-agt.sh` with NO gate env prints SKIPPED + exits 0.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// src/cli/e2e-live-agt-script.test.ts -> repo root is two levels up.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Run the script with a SCRUBBED env (no AGENTOS_LIVE_AGT / AGT_UDS_PATH) -> exit code + stdout. */
function runUngated(): { code: number; out: string } {
  // Strip the gate env so the test is deterministic regardless of the operator's shell — build a fresh
  // env that omits the two gate keys (no `delete`, biome-clean).
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "AGENTOS_LIVE_AGT" || k === "AGT_UDS_PATH") continue;
    env[k] = v;
  }
  try {
    const out = execFileSync("bash", [join(repoRoot, "scripts", "e2e-live-agt.sh")], {
      env,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string };
    return { code: e.status ?? 1, out: String(e.stdout ?? "") };
  }
}

describe("e2e:live-agt — gated-live AGT script (skip-by-default, not in verify)", () => {
  it("is wired as a package.json script but is NOT part of `pnpm run verify`", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    expect(pkg.scripts["e2e:live-agt"]).toBeDefined();
    expect(pkg.scripts["e2e:live-agt"]).toContain("scripts/e2e-live-agt.sh");
    // Gated-live scripts must never gate the universal feedback loop.
    expect(pkg.scripts.verify).not.toContain("e2e:live-agt");
  });

  it("prints SKIPPED and exits 0 when the gate env (AGENTOS_LIVE_AGT) is absent — no real sidecar", () => {
    const { code, out } = runUngated();
    expect(code).toBe(0);
    expect(out).toContain("SKIPPED");
    expect(out).toContain("AGENTOS_LIVE_AGT");
  });
});
