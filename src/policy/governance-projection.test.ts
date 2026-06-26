/**
 * SLICE-R9b-1 — credential-blind `exec.run` governance projection (RED-first).
 *
 * These tests pin the Credential-Blind invariant DEAD: no env / stdin / file contents / raw
 * un-redacted token / userinfo can appear in ANY field of the projection. The load-bearing test is
 * the CREDENTIAL CANARY: runtime-built `sk-` canaries (never a source literal, so secret-scan stays
 * clean) must NOT appear anywhere in the projection, and `networkHosts` must strip the `user:pass@`
 * userinfo before keeping the host.
 *
 * Non-vacuity is asserted by spec mutations (documented next to each test): remove the per-token
 * redactSecrets -> canary appears in argvRedacted -> RED; remove the userinfo strip -> canary appears
 * in networkHosts -> RED; remove the slice bound -> truncated/length checks flip RED.
 */
import { describe, expect, it } from "vitest";
import { type GovernanceProjection, buildExecRunProjection } from "./governance-projection.js";

/**
 * Build a `sk-`-shaped canary at RUNTIME so the literal never appears in this source file (otherwise
 * `scripts/scan_secrets.sh` would flag it). 20 alphanumeric chars after `sk-` satisfies the audit
 * SECRET_VALUE regex (`sk-[A-Za-z0-9]{16,}`), so redactSecrets WILL match and scrub it.
 */
function skCanary(fill: string): string {
  return `${"sk"}-${fill.repeat(20)}`;
}

describe("buildExecRunProjection — normal", () => {
  it("projects a plain argv with no secrets, network, or shell", () => {
    const p = buildExecRunProjection({ argv: ["npm", "test"] });
    expect(p.version).toBe(1);
    expect(p.argv0).toBe("npm");
    expect(p.argc).toBe(2);
    expect(p.argvRedacted).toEqual(["npm", "test"]);
    expect(p.operationClass).toBe("process");
    expect(p.truncated).toBe(false);
    expect(p.usesShellInterpreter).toBe(false);
    expect(p.networkHosts).toEqual([]);
    expect(p.destructiveFlags).toEqual([]);
  });
});

describe("buildExecRunProjection — CREDENTIAL CANARY (load-bearing)", () => {
  it("never lets a runtime sk- canary or userinfo reach ANY field", () => {
    const sk1 = skCanary("A");
    const sk2 = skCanary("B");
    const argv = ["curl", `https://user:${sk1}@api.example.com/p`, "-H", `Authorization: ${sk2}`];
    const p = buildExecRunProjection({ argv });

    // Stringify the WHOLE projection: neither canary substring may appear anywhere.
    // Mutation: remove the per-token redactSecrets -> sk1 surfaces in argvRedacted -> this flips RED.
    const blob = JSON.stringify(p);
    expect(blob).not.toContain(sk1);
    expect(blob).not.toContain(sk2);

    // networkHosts keeps the bare host, NOT the userinfo / canary.
    // Mutation: remove the userinfo strip -> "user:" + canary surfaces in networkHosts -> RED.
    expect(p.networkHosts).toContain("api.example.com");
    expect(p.networkHosts).not.toContain("user:");
    for (const host of p.networkHosts) {
      expect(host).not.toContain("user:");
      expect(host).not.toContain(sk1);
      expect(host).not.toContain(sk2);
    }

    // operationClass derives from argv0 basename only (curl -> network) — never leaks an arg.
    expect(p.operationClass).toBe("network");
  });
});

describe("buildExecRunProjection — BOUNDED", () => {
  it("caps argvRedacted at MAX_TOKENS, sets truncated, keeps original argc", () => {
    const MAX = 64;
    const argv = Array.from({ length: MAX + 10 }, (_, i) => `t${i}`);
    const p = buildExecRunProjection({ argv });

    // Mutation: remove the .slice bound -> argvRedacted.length === MAX+10 -> this flips RED.
    expect(p.argvRedacted.length).toBe(MAX);
    expect(p.truncated).toBe(true);
    // argc is the ORIGINAL token count (not the truncated length) — truncation is explicit, not silent.
    expect(p.argc).toBe(MAX + 10);
  });

  it("does not truncate at exactly MAX_TOKENS", () => {
    const MAX = 64;
    const argv = Array.from({ length: MAX }, (_, i) => `t${i}`);
    const p = buildExecRunProjection({ argv });
    expect(p.argvRedacted.length).toBe(MAX);
    expect(p.truncated).toBe(false);
    expect(p.argc).toBe(MAX);
  });
});

describe("buildExecRunProjection — usesShellInterpreter", () => {
  it("is true for a shell basename followed by -c", () => {
    const p = buildExecRunProjection({ argv: ["bash", "-c", "echo hi"] });
    expect(p.usesShellInterpreter).toBe(true);
    expect(p.operationClass).toBe("shell");
  });

  it("is false when argv0 is not a shell, even if -c is present", () => {
    // `ls -c` — ls is NOT a shell basename, so shell-interpreter is false despite the -c token.
    const p = buildExecRunProjection({ argv: ["ls", "-c"] });
    expect(p.usesShellInterpreter).toBe(false);
    expect(p.operationClass).toBe("filesystem");
  });

  it("is false for a shell with no -c token", () => {
    const p = buildExecRunProjection({ argv: ["bash", "script.sh"] });
    expect(p.usesShellInterpreter).toBe(false);
  });

  it("matches a shell at an absolute path basename", () => {
    const p = buildExecRunProjection({ argv: ["/usr/bin/bash", "-c", "echo hi"] });
    expect(p.usesShellInterpreter).toBe(true);
    expect(p.argv0).toBe("/usr/bin/bash");
    expect(p.operationClass).toBe("shell");
  });
});

describe("buildExecRunProjection — destructiveFlags", () => {
  it("picks up -rf from rm -rf /", () => {
    const p = buildExecRunProjection({ argv: ["rm", "-rf", "/"] });
    expect(p.destructiveFlags).toContain("-rf");
    expect(p.operationClass).toBe("filesystem");
  });

  it("picks up --force and --no-preserve-root", () => {
    const p = buildExecRunProjection({ argv: ["rm", "--force", "--no-preserve-root", "x"] });
    expect(p.destructiveFlags).toContain("--force");
    expect(p.destructiveFlags).toContain("--no-preserve-root");
  });

  it("is empty when no known destructive flag is present", () => {
    const p = buildExecRunProjection({ argv: ["cp", "a", "b"] });
    expect(p.destructiveFlags).toEqual([]);
  });
});

describe("buildExecRunProjection — networkHosts extraction", () => {
  it("extracts host[:port] from a URL and a bare host:port, de-duped", () => {
    const p = buildExecRunProjection({
      argv: ["wget", "https://a.example.com:8443/x", "a.example.com:8443", "--quiet"],
    });
    // De-dup: the URL host:port and the bare host:port collapse to one entry.
    expect(p.networkHosts).toEqual(["a.example.com:8443"]);
    expect(p.operationClass).toBe("network");
  });

  it("does not misclassify flags or plain words as hosts", () => {
    const p = buildExecRunProjection({ argv: ["echo", "-n", "hello", "key:value-not-a-host"] });
    expect(p.networkHosts).toEqual([]);
  });
});

describe("buildExecRunProjection — defensive (purity, never throws on edge input)", () => {
  it("returns a safe projection for empty argv without throwing", () => {
    // exec.run schema enforces .min(1), so this should never happen — projector is fail-safe anyway.
    const p: GovernanceProjection = buildExecRunProjection({ argv: [] });
    expect(p.version).toBe(1);
    expect(p.argv0).toBe("");
    expect(p.argc).toBe(0);
    expect(p.argvRedacted).toEqual([]);
    expect(p.truncated).toBe(false);
    expect(p.usesShellInterpreter).toBe(false);
    expect(p.operationClass).toBe("unknown");
    expect(p.networkHosts).toEqual([]);
    expect(p.destructiveFlags).toEqual([]);
    expect(p.writeTargets).toEqual([]);
  });
});

describe("buildExecRunProjection — writeTargets (SLICE-CAP9, parallel to networkHosts)", () => {
  // CAP9 adds `writeTargets` to the projection (the host-write target paths a host-fs-write tool's
  // custom projector sets, parallel to net.fetch's networkHosts override). The general `exec.run`
  // projector has NO host-write target classifier (no real host-write tool exists), so it defaults to
  // `[]` for EVERY existing tool — they stay BYTE-IDENTICAL. Only a future host-fs-write tool's custom
  // projector sets it (proven by the synthetic bin test).
  it("defaults writeTargets to [] for a plain command (existing tools unchanged)", () => {
    expect(buildExecRunProjection({ argv: ["npm", "test"] }).writeTargets).toEqual([]);
    expect(buildExecRunProjection({ argv: ["rm", "-rf", "/tmp/x"] }).writeTargets).toEqual([]);
    expect(
      buildExecRunProjection({ argv: ["curl", "https://a.example.com/x"] }).writeTargets,
    ).toEqual([]);
  });

  it("the empty-argv defensive projection also carries writeTargets: []", () => {
    expect(buildExecRunProjection({ argv: [] }).writeTargets).toEqual([]);
  });
});
