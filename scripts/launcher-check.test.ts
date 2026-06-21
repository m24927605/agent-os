import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/launcher-check.test.ts -> repo root is one level up.
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const script = join(repoRoot, "scripts", "launcher-check.mjs");

/** Run the launcher linter against `composePath`; return its exit code (0 == pass). */
function runLint(composePath: string): number {
  try {
    execFileSync("node", [script, composePath], { stdio: "pipe" });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-os-launcher-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

// A compliant compose: localhost-only binds, every secret sourced from ${ENV} / mount.
const COMPLIANT = `services:
  shell:
    image: agent-os/personal-shell
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      - SHELL_API_KEY=\${SHELL_API_KEY}
    volumes:
      - \${HOME}/.agent-os/secrets:/run/secrets:ro
`;

describe("launcher-check — localhost-only + secrets-as-mount invariants (RED-first)", () => {
  it("rejects a compose with a 0.0.0.0 bind (network deny-by-default)", () => {
    const f = fixture(
      "bind.yml",
      `services:
  shell:
    image: agent-os/personal-shell
    ports:
      - "0.0.0.0:8080:8080"
`,
    );
    expect(runLint(f)).not.toBe(0);
  });

  it("rejects a compose containing a plaintext secret-like literal (canary assembled at runtime)", () => {
    // The canary is built at runtime and written ONLY to a tmpdir fixture — never committed,
    // so the repo's secret-scan stays clean. Shape: sk- + 32 hex-ish chars.
    const canary = `sk-${"a1b2c3d4".repeat(4)}`;
    const f = fixture(
      "secret.yml",
      `services:
  shell:
    image: agent-os/personal-shell
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      - SHELL_API_KEY=${canary}
`,
    );
    expect(runLint(f)).not.toBe(0);
  });

  it("passes a compliant compose (127.0.0.1 binds + \\${ENV}/mount secrets)", () => {
    const f = fixture("ok.yml", COMPLIANT);
    expect(runLint(f)).toBe(0);
  });

  it("fails closed on a missing compose file (deny, not fail-open)", () => {
    expect(runLint(join(dir, "does-not-exist.yml"))).not.toBe(0);
  });

  it("fails closed on malformed YAML (deny, not fail-open)", () => {
    const f = fixture("bad.yml", "services:\n  shell:\n  - this: [is: broken\n");
    expect(runLint(f)).not.toBe(0);
  });

  it("checks the real Personal compose by default and is wired into verify", () => {
    // Default target (no arg) is deploy/personal/docker-compose.yml and must pass.
    expect(runLint(join(repoRoot, "deploy", "personal", "docker-compose.yml"))).toBe(0);
    const pkg = JSON.parse(
      execFileSync("cat", [join(repoRoot, "package.json")], { encoding: "utf8" }),
    );
    expect(pkg.scripts["launcher:check"]).toBeDefined();
    expect(pkg.scripts.verify).toContain("launcher:check");
  });
});
