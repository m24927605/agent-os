/**
 * SLICE-P2R-R9-S3 — CLI `agentos`: tests.
 *
 * The CLI is a THIN relay layer: `manifest lint` delegates to R3 `parseToolManifest` (via the SDK
 * barrel) and maps valid/invalid to exit 0/1; `verify` spawns the standalone verifier binary and
 * relays its exit code (0=intact, 1=broken, 2=bad input). These tests pin the behaviour BY COMMAND
 * through the testable entrypoint `runCli(argv): Promise<number>`:
 *   (1) a well-formed 9-field manifest lints to 0; an invalid one (unknown / missing field) to 1;
 *   (2) fail-closed parsing: unknown subcommand / missing <file> / missing --pubkey => non-zero
 *       (never a silent exit 0);
 *   (3) verify fail-closed when the verifier binary is absent (AGENTOS_VERIFIER_BIN -> nonexistent);
 *   (4) verify RELAYS a non-zero exit (a mock verifier that exits 1 makes runCli return 1) — the relay
 *       never swallows "broken" into "intact".
 *
 * The relay test uses a tiny throwaway mock binary (a shell script that exits with a chosen code) per
 * the slice spec (§3 Out-of-scope: the real verifier binary is S5; this slice only spawn+relays, and
 * the spec permits a mock path to prove relay). No dependency on Go / S5.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "./main.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agentos-cli-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const validManifest = {
  name: "fs.read",
  version: "1.0.0",
  description: "Read a file",
  action: "tool:invoke",
  resourcePattern: "fs://**",
  sideEffect: "read",
  idempotent: true,
  requiresApproval: false,
  bundleRefOnly: false,
};

function writeJson(name: string, value: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(value));
  return p;
}

/** Write an executable shell-script "verifier" that just exits with `code`. */
function writeMockVerifier(code: number): string {
  const p = join(tmp, "mock-verifier.sh");
  writeFileSync(p, `#!/bin/sh\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return p;
}

describe("agentos manifest lint", () => {
  it("returns 0 for a well-formed 9-field manifest", async () => {
    const file = writeJson("ok.json", validManifest);
    expect(await runCli(["manifest", "lint", file])).toBe(0);
  });

  it("returns 1 for a manifest with an unknown field (fail-closed)", async () => {
    const file = writeJson("evil.json", { ...validManifest, evil: "x" });
    expect(await runCli(["manifest", "lint", file])).toBe(1);
  });

  it("returns 1 for a manifest missing a required field (fail-closed)", async () => {
    const { version: _omit, ...missing } = validManifest;
    const file = writeJson("missing.json", missing);
    expect(await runCli(["manifest", "lint", file])).toBe(1);
  });

  it("returns non-zero when <file> is missing entirely (fail-closed)", async () => {
    expect(await runCli(["manifest", "lint"])).not.toBe(0);
  });

  it("returns non-zero when the manifest file does not exist (fail-closed)", async () => {
    expect(await runCli(["manifest", "lint", join(tmp, "nope.json")])).not.toBe(0);
  });
});

describe("agentos verify — relay + fail-closed", () => {
  it("returns non-zero when the verifier binary is absent (fail-closed, not faked intact)", async () => {
    const chain = writeJson("chain.json", { entries: [] });
    const pub = join(tmp, "pub.pem");
    writeFileSync(pub, "-----BEGIN PUBLIC KEY-----\nXX\n-----END PUBLIC KEY-----\n");
    const env = { ...process.env, AGENTOS_VERIFIER_BIN: join(tmp, "does-not-exist") };
    expect(await runCli(["verify", "--chain", chain, "--pubkey", pub], env)).not.toBe(0);
  });

  it("RELAYS exit 1 from the verifier (broken is never swallowed into intact)", async () => {
    const chain = writeJson("chain.json", { entries: [] });
    const pub = join(tmp, "pub.pem");
    writeFileSync(pub, "stub");
    const env = { ...process.env, AGENTOS_VERIFIER_BIN: writeMockVerifier(1) };
    expect(await runCli(["verify", "--chain", chain, "--pubkey", pub], env)).toBe(1);
  });

  it("RELAYS exit 0 from the verifier (intact)", async () => {
    const chain = writeJson("chain.json", { entries: [] });
    const pub = join(tmp, "pub.pem");
    writeFileSync(pub, "stub");
    const env = { ...process.env, AGENTOS_VERIFIER_BIN: writeMockVerifier(0) };
    expect(await runCli(["verify", "--chain", chain, "--pubkey", pub], env)).toBe(0);
  });

  it("returns non-zero when --pubkey is missing (fail-closed)", async () => {
    const chain = writeJson("chain.json", { entries: [] });
    expect(await runCli(["verify", "--chain", chain])).not.toBe(0);
  });
});

describe("agentos — fail-closed dispatch", () => {
  it("returns non-zero for an unknown subcommand (no silent exit 0)", async () => {
    expect(await runCli(["frobnicate"])).not.toBe(0);
  });

  it("returns non-zero for no subcommand at all", async () => {
    expect(await runCli([])).not.toBe(0);
  });

  it("returns non-zero for `manifest` with an unknown action", async () => {
    expect(await runCli(["manifest", "bogus", "x"])).not.toBe(0);
  });
});
