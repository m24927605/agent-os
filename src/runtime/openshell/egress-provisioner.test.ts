/**
 * SLICE-CAP6e — PURE core of the auto-egress provisioner: config parse + network_policies materialization +
 * MERGE (preserve baked) + readback check. No I/O; the shell-out + buildBinDeps wiring are tested separately.
 */
import { describe, expect, it } from "vitest";
import {
  buildEgressNetworkPolicies,
  mergeEgressIntoPolicy,
  missingNetFetchHosts,
  parseEgressHosts,
  provisionEgressPolicy,
} from "./egress-provisioner.js";

/**
 * In-memory `openshell` double: `get` returns the stored inner policy under `.policy`; `set` adopts the
 * last-written payload as the new stored policy (simulating the real round-trip). `dropOnSet` models a set
 * that silently fails to land the policy (=> readback miss => fail-closed).
 */
function fakeOpenShell(opts: { dropOnSet?: boolean; noPolicy?: boolean } = {}) {
  let stored: Record<string, unknown> | undefined = opts.noPolicy
    ? undefined // a freshly-created sandbox: `policy get` errors "no active policy configured" until a set
    : {
        version: 1,
        filesystem_policy: { include_workdir: true, read_only: ["/usr"] },
        process: { run_as_user: "sandbox" },
        network_policies: {
          claude: { name: "claude", endpoints: [{ host: "api.anthropic.com", port: 443 }] },
        },
      };
  let lastWritten = "";
  const calls: string[][] = [];
  return {
    calls,
    get stored() {
      return stored;
    },
    get lastWritten() {
      return lastWritten;
    },
    writeTmp: (content: string): string => {
      lastWritten = content;
      return "/tmp/agentos-egress.json";
    },
    exec: (args: readonly string[]): string => {
      calls.push([...args]);
      if (args[0] === "policy" && args[1] === "get") {
        if (stored === undefined) throw new Error("no active policy configured for sandbox");
        return JSON.stringify({ policy: stored, hash: "h", active_version: 1 });
      }
      if (args[0] === "policy" && args[1] === "set") {
        if (!opts.dropOnSet) stored = JSON.parse(lastWritten) as Record<string, unknown>;
        return "Policy loaded";
      }
      throw new Error(`unexpected exec: ${args.join(" ")}`);
    },
  };
}

describe("provisionEgressPolicy — read -> merge -> set -> readback, fail-closed", () => {
  it("HAPPY: merges net.fetch hosts in, PRESERVES baked claude, set payload carries both, readback OK", async () => {
    const os = fakeOpenShell();
    await provisionEgressPolicy({
      sandboxName: "harmonic-towhee",
      netFetchHosts: ["api.github.com"],
      gitPushHosts: [],
      exec: os.exec,
      writeTmp: os.writeTmp,
    });
    // exec sequence: get -> set -> get (readback).
    expect(os.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "policy get",
      "policy set",
      "policy get",
    ]);
    const setPayload = JSON.parse(os.lastWritten) as { network_policies: Record<string, unknown> };
    expect(setPayload.network_policies.claude).toBeDefined(); // baked PRESERVED
    expect(setPayload.network_policies.agentos_net_fetch).toBeDefined(); // ours ADDED
  });

  it("FRESH sandbox (no active policy => `policy get` throws): uses the canonical base + sets + readback OK", async () => {
    const os = fakeOpenShell({ noPolicy: true });
    await provisionEgressPolicy({
      sandboxName: "benevolent-buck",
      netFetchHosts: ["api.github.com"],
      gitPushHosts: [],
      exec: os.exec,
      writeTmp: os.writeTmp,
    });
    const setPayload = JSON.parse(os.lastWritten) as {
      filesystem_policy?: unknown;
      network_policies: Record<string, unknown>;
    };
    expect(setPayload.filesystem_policy).toBeDefined(); // canonical base filesystem posture applied
    expect(setPayload.network_policies.agentos_net_fetch).toBeDefined(); // our egress added
    // first get threw (no policy) -> still set + readback (get) succeeds: get, set, get.
    expect(os.calls.map((c) => `${c[0]} ${c[1]}`)).toEqual([
      "policy get",
      "policy set",
      "policy get",
    ]);
  });

  it("NO-OP when both allowlists empty (deny-all stays; openshell is never invoked)", async () => {
    const os = fakeOpenShell();
    await provisionEgressPolicy({
      sandboxName: "sb",
      netFetchHosts: [],
      gitPushHosts: [],
      exec: os.exec,
      writeTmp: os.writeTmp,
    });
    expect(os.calls.length).toBe(0);
  });

  it("FAIL-CLOSED: readback missing the host (set silently dropped it) => THROWS", async () => {
    const os = fakeOpenShell({ dropOnSet: true });
    await expect(
      provisionEgressPolicy({
        sandboxName: "sb",
        netFetchHosts: ["api.github.com"],
        gitPushHosts: [],
        exec: os.exec,
        writeTmp: os.writeTmp,
      }),
    ).rejects.toThrow(/readback missing/i);
  });

  it("FAIL-CLOSED: an empty sandbox name => THROWS (no name resolved)", async () => {
    const os = fakeOpenShell();
    await expect(
      provisionEgressPolicy({
        sandboxName: "",
        netFetchHosts: ["api.github.com"],
        gitPushHosts: [],
        exec: os.exec,
        writeTmp: os.writeTmp,
      }),
    ).rejects.toThrow(/no OpenShell sandbox name/i);
  });
});

describe("parseEgressHosts — comma-separated plain-DNS allowlist, HTTPS-only, fail-closed", () => {
  it("parses + de-dupes a comma list; unset/empty => []", () => {
    expect(parseEgressHosts(undefined)).toEqual([]);
    expect(parseEgressHosts("")).toEqual([]);
    expect(parseEgressHosts("  ")).toEqual([]);
    expect(parseEgressHosts("api.github.com")).toEqual(["api.github.com"]);
    expect(parseEgressHosts("api.github.com, raw.githubusercontent.com")).toEqual([
      "api.github.com",
      "raw.githubusercontent.com",
    ]);
    expect(parseEgressHosts("a.example, a.example, b.example")).toEqual(["a.example", "b.example"]);
  });

  it("THROWS on a non-plain-DNS host (scheme / port / IP-literal / glob / userinfo) — fail-closed", () => {
    for (const bad of [
      "https://api.github.com", // scheme
      "api.github.com:443", // port
      "127.0.0.1", // IP literal
      "2130706433", // integer IP
      "*.github.com", // glob
      "user@host.example", // userinfo
      "a b.example", // whitespace
      "host/path", // path
    ]) {
      expect(() => parseEgressHosts(bad)).toThrow();
      expect(() => parseEgressHosts(`ok.example, ${bad}`)).toThrow(); // one bad entry fails the whole list
    }
  });
});

describe("buildEgressNetworkPolicies — curl read-only + git full, HTTPS 443, binary-identity gated", () => {
  it("net.fetch block: curl, read-only, port 443, one endpoint per host", () => {
    const np = buildEgressNetworkPolicies(["api.github.com", "raw.githubusercontent.com"], []) as {
      agentos_net_fetch: {
        endpoints: {
          host: string;
          port: number;
          protocol: string;
          enforcement: string;
          access: string;
        }[];
        binaries: { path: string }[];
      };
      agentos_git_push?: unknown;
    };
    expect(np.agentos_net_fetch.binaries).toEqual([{ path: "/usr/bin/curl" }]);
    expect(np.agentos_net_fetch.endpoints).toEqual([
      {
        host: "api.github.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        access: "read-only",
      },
      {
        host: "raw.githubusercontent.com",
        port: 443,
        protocol: "rest",
        enforcement: "enforce",
        access: "read-only",
      },
    ]);
    expect(np.agentos_git_push).toBeUndefined(); // no git hosts => no git block (deny-by-default)
  });

  it("git.push block: git, write-capable (access full), separate from net.fetch", () => {
    const np = buildEgressNetworkPolicies(["api.github.com"], ["github.com"]) as {
      agentos_net_fetch: { binaries: { path: string }[] };
      agentos_git_push: {
        endpoints: { host: string; access: string }[];
        binaries: { path: string }[];
      };
    };
    expect(np.agentos_git_push.binaries).toEqual([{ path: "/usr/bin/git" }]);
    expect(np.agentos_git_push.endpoints[0]).toMatchObject({ host: "github.com", access: "full" });
    expect(np.agentos_net_fetch.binaries).toEqual([{ path: "/usr/bin/curl" }]); // unaffected
  });

  it("empty allowlists => empty block (nothing opened)", () => {
    expect(buildEgressNetworkPolicies([], [])).toEqual({});
  });
});

describe("mergeEgressIntoPolicy — PRESERVE baked fs/process/other network_policies, replace only agentos_*", () => {
  const baked = {
    version: 1,
    filesystem_policy: { include_workdir: true, read_only: ["/usr"], read_write: ["/sandbox"] },
    process: { run_as_user: "sandbox", run_as_group: "sandbox" },
    landlock: { compatibility: "best_effort" },
    network_policies: {
      // an image/operator-defined policy (e.g. openclaw's Claude egress) — MUST survive the merge.
      claude: { name: "claude", endpoints: [{ host: "api.anthropic.com", port: 443 }] },
    },
  };

  it("preserves filesystem_policy / process / landlock / version AND the baked claude network policy", () => {
    const merged = mergeEgressIntoPolicy(baked, ["api.github.com"], []) as typeof baked & {
      network_policies: Record<string, unknown>;
    };
    expect(merged.filesystem_policy).toEqual(baked.filesystem_policy);
    expect(merged.process).toEqual(baked.process);
    expect(merged.landlock).toEqual(baked.landlock);
    expect(merged.version).toBe(1);
    expect(merged.network_policies.claude).toEqual(baked.network_policies.claude); // baked allow PRESERVED
    expect(merged.network_policies.agentos_net_fetch).toBeDefined(); // ours ADDED
  });

  it("does NOT mutate the input policy", () => {
    const snapshot = JSON.stringify(baked);
    mergeEgressIntoPolicy(baked, ["api.github.com"], ["github.com"]);
    expect(JSON.stringify(baked)).toBe(snapshot);
  });

  it("idempotent: re-merging REPLACES the prior agentos_* (no accumulation), keeps baked", () => {
    const once = mergeEgressIntoPolicy(baked, ["a.example"], []);
    const twice = mergeEgressIntoPolicy(once, ["b.example"], []) as {
      network_policies: { agentos_net_fetch: { endpoints: { host: string }[] }; claude: unknown };
    };
    expect(twice.network_policies.agentos_net_fetch.endpoints.map((e) => e.host)).toEqual([
      "b.example",
    ]);
    expect(twice.network_policies.claude).toEqual(baked.network_policies.claude);
  });

  it("a policy with NO network_policies merges cleanly (fresh openclaw: empty user-layer network_policies)", () => {
    const fresh = { version: 1, filesystem_policy: { include_workdir: true } };
    const merged = mergeEgressIntoPolicy(fresh, ["api.github.com"], []) as {
      network_policies: Record<string, unknown>;
      filesystem_policy: unknown;
    };
    expect(merged.network_policies.agentos_net_fetch).toBeDefined();
    expect(merged.filesystem_policy).toEqual(fresh.filesystem_policy);
  });
});

describe("missingNetFetchHosts — readback fail-closed check", () => {
  it("returns [] when every expected host is present in agentos_net_fetch", () => {
    const merged = mergeEgressIntoPolicy(
      { version: 1 },
      ["api.github.com", "raw.githubusercontent.com"],
      [],
    );
    expect(missingNetFetchHosts(merged, ["api.github.com", "raw.githubusercontent.com"])).toEqual(
      [],
    );
  });

  it("returns the MISSING hosts when the set silently dropped one (=> provisioner fails closed)", () => {
    const merged = mergeEgressIntoPolicy({ version: 1 }, ["api.github.com"], []);
    expect(missingNetFetchHosts(merged, ["api.github.com", "absent.example"])).toEqual([
      "absent.example",
    ]);
  });

  it("returns ALL expected when there is no agentos_net_fetch block at all", () => {
    expect(missingNetFetchHosts({ version: 1 }, ["api.github.com"])).toEqual(["api.github.com"]);
  });
});
