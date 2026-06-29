/**
 * SLICE-CAP6e — auto-provision the OpenShell egress network-policy at sandbox creation (Option B:
 * MERGE-AWARE). The proxy-pin (Option D) makes net.fetch/git.push ROUTE through the OpenShell egress proxy,
 * but that proxy is DENY-BY-DEFAULT — so in production every fetch 403s until an operator manually
 * `openshell policy set`s the host (unusable for ephemeral Hermes sandboxes). This module materializes the
 * operator allowlist (`AGENTOS_EGRESS_ALLOW` for net.fetch, `AGENTOS_GIT_EGRESS_ALLOW` for git.push) into the
 * sandbox's OpenShell network-policy at create time, MERGED on top of the sandbox's existing policy so the
 * image's baked allows (e.g. openclaw's Claude egress) + filesystem/process blocks are PRESERVED.
 *
 * This file holds the PURE core (config parse + policy materialization + merge + readback check); the impure
 * shell-out (`openshell policy get/set`) + the buildBinDeps wiring live alongside it (CAP6e-2). v1 is
 * HTTPS-only (port 443) and keys credential injection per-host (path-scoping is a later hardening).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A plain DNS hostname (or `localhost`): the SAME contract net.fetch's `isAllowedFetchUrl` admits — dotted
 * `[A-Za-z0-9-]` labels with a letter-bearing TLD, NO scheme / port / path / userinfo / IP-literal. So the
 * host an operator allowlists is byte-identical to the host the OpenShell endpoint gates and curl connects to.
 */
const PLAIN_DNS_HOST = /^(?:localhost|(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]*[A-Za-z][A-Za-z0-9-]*)$/;

/** The net.fetch egress allowlist (comma-separated hosts) — Agent OS control-plane config. */
export const AGENTOS_EGRESS_ALLOW_ENV = "AGENTOS_EGRESS_ALLOW";
/** The git.push egress allowlist (SEPARATE, higher-bar: git.push is destructive + approval-gated). */
export const AGENTOS_GIT_EGRESS_ALLOW_ENV = "AGENTOS_GIT_EGRESS_ALLOW";

/**
 * The canonical base policy for a FRESHLY-created sandbox that has NO active policy yet (`openshell policy
 * get` errors with "no active policy configured"). This is the standard openclaw-compatible filesystem /
 * process / landlock posture (proven live: a sandbox set with it functions + curl reaches an allowlisted
 * host). Used ONLY as the merge base when there is no current policy to read; a sandbox that already HAS a
 * policy is merged into IT (preserving its fields). `policy set` then replaces the (empty) user-layer policy.
 */
const CANONICAL_BASE_POLICY: Record<string, unknown> = {
  version: 1,
  filesystem_policy: {
    include_workdir: true,
    read_only: ["/usr", "/lib", "/proc", "/dev/urandom", "/app", "/etc", "/var/log"],
    read_write: ["/sandbox", "/tmp", "/dev/null"],
  },
  landlock: { compatibility: "best_effort" },
  process: { run_as_user: "sandbox", run_as_group: "sandbox" },
};

/**
 * Parse a comma-separated host allowlist. Each entry MUST be a plain DNS host (HTTPS-only egress) — a
 * malformed entry THROWS (fail-closed: a bad allowlist must never silently widen or narrow egress, and a
 * scheme/port/IP-literal/glob must never reach the OpenShell policy). Empty / unset => `[]`. De-duped, order
 * preserved. Pure over its argument.
 */
export function parseEgressHosts(raw: string | undefined): string[] {
  const items = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const h of items) {
    if (!PLAIN_DNS_HOST.test(h)) {
      throw new Error(
        `AGENTOS egress allowlist: invalid host (not a plain DNS host, HTTPS-only): ${h}`,
      );
    }
  }
  return [...new Set(items)];
}

/** One OpenShell network endpoint (HTTPS, port 443) for a host, gated to a binary identity by the policy. */
function endpointFor(host: string, access: "read-only" | "full"): Record<string, unknown> {
  return { host, port: 443, protocol: "rest", enforcement: "enforce", access };
}

/**
 * Build the Agent-OS network_policies block: `agentos_net_fetch` (curl, read-only GET) + `agentos_git_push`
 * (git, write-capable). Each host is HTTPS-only (443) and BINARY-IDENTITY gated (OpenShell resolves the
 * calling binary by `/proc/<pid>/exe`, not argv) so only the named binary may use the allow. A block is
 * omitted when its host list is empty (deny-by-default: nothing is opened for a tool with no allowlist). Pure.
 */
export function buildEgressNetworkPolicies(
  netFetchHosts: readonly string[],
  gitPushHosts: readonly string[],
): Record<string, unknown> {
  const np: Record<string, unknown> = {};
  if (netFetchHosts.length > 0) {
    np.agentos_net_fetch = {
      name: "agentos-net-fetch",
      endpoints: netFetchHosts.map((h) => endpointFor(h, "read-only")),
      binaries: [{ path: "/usr/bin/curl" }],
    };
  }
  if (gitPushHosts.length > 0) {
    np.agentos_git_push = {
      name: "agentos-git-push",
      endpoints: gitPushHosts.map((h) => endpointFor(h, "full")),
      binaries: [{ path: "/usr/bin/git" }],
    };
  }
  return np;
}

/**
 * MERGE the Agent-OS egress network_policies INTO a sandbox's CURRENT policy object (the inner `.policy` from
 * `openshell policy get --full -o json`), PRESERVING every other field — `filesystem_policy`, `process`,
 * `landlock`, `version`, AND any operator/baked `network_policies` — and REPLACING only our own two
 * `agentos_*` keys (idempotent re-provision). Returns a NEW object suitable for `openshell policy set`. Pure;
 * never mutates `current`.
 */
export function mergeEgressIntoPolicy(
  current: Record<string, unknown>,
  netFetchHosts: readonly string[],
  gitPushHosts: readonly string[],
): Record<string, unknown> {
  const currentNp =
    current.network_policies && typeof current.network_policies === "object"
      ? (current.network_policies as Record<string, unknown>)
      : {};
  // Drop any prior agentos_* keys first (idempotent), then layer the freshly-built ones on top of whatever
  // the image/operator defined — never clobber a non-agentos policy key.
  const preserved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(currentNp)) {
    if (k !== "agentos_net_fetch" && k !== "agentos_git_push") preserved[k] = v;
  }
  return {
    ...current,
    network_policies: { ...preserved, ...buildEgressNetworkPolicies(netFetchHosts, gitPushHosts) },
  };
}

/**
 * READBACK verification (pure): a freshly-set policy (the inner `.policy`) must contain, for EVERY expected
 * net.fetch host, an `agentos_net_fetch` endpoint with that host — else the set silently no-op'd / was
 * rejected and the provisioner must FAIL CLOSED. Returns the set of expected hosts NOT found (empty => ok).
 */
export function missingNetFetchHosts(
  policy: Record<string, unknown>,
  expectedHosts: readonly string[],
): string[] {
  const np = (policy.network_policies ?? {}) as Record<string, unknown>;
  const block = (np.agentos_net_fetch ?? {}) as { endpoints?: { host?: string }[] };
  const present = new Set(
    (block.endpoints ?? []).map((e) => e.host).filter((h): h is string => !!h),
  );
  return expectedHosts.filter((h) => !present.has(h));
}

/** Run `openshell <args…>` and return stdout (throws on a non-zero exit). Injected for testability. */
export type PolicyExec = (args: readonly string[]) => string;
/** Write `content` to a fresh temp file and return its path. Injected for testability. */
export type WriteTmp = (content: string) => string;

/** Extract the inner policy object from an `openshell policy get --full -o json` payload (`.policy`). */
function innerPolicy(getStdout: string): Record<string, unknown> {
  const parsed = JSON.parse(getStdout) as { policy?: Record<string, unknown> };
  return parsed.policy && typeof parsed.policy === "object" ? parsed.policy : {};
}

/**
 * AUTO-PROVISION the sandbox's OpenShell egress policy from the Agent-OS allowlists (CAP6e, Option B). Reads
 * the sandbox's CURRENT full policy, MERGES in the `agentos_net_fetch`/`agentos_git_push` network_policies
 * (preserving every baked/operator field), SETS the merged policy, then READS BACK and verifies every net.fetch
 * host landed — else THROWS (fail-closed: the caller destroys the sandbox + does not serve). A no-op when both
 * allowlists are empty (deny-by-default stays; no egress is opened). Impure ONLY via the injected `exec` /
 * `writeTmp` (real = `openshell` CLI + a tmp file; tests = in-memory doubles).
 */
export async function provisionEgressPolicy(opts: {
  readonly sandboxName: string;
  readonly netFetchHosts: readonly string[];
  readonly gitPushHosts: readonly string[];
  readonly exec: PolicyExec;
  readonly writeTmp: WriteTmp;
}): Promise<void> {
  const { sandboxName, netFetchHosts, gitPushHosts, exec, writeTmp } = opts;
  if (netFetchHosts.length === 0 && gitPushHosts.length === 0) return; // nothing to open — deny-all stays
  if (sandboxName.length === 0) {
    throw new Error("provisionEgressPolicy: no OpenShell sandbox name resolved (fail-closed)");
  }
  // Read the sandbox's CURRENT policy to merge into. A freshly-created sandbox has NO active policy yet
  // (`policy get` errors), so fall back to the canonical base; the set + readback below stay the fail-closed
  // gates, so a genuine gateway failure (vs "no active policy") still surfaces (set/readback throw).
  let current: Record<string, unknown>;
  try {
    current = innerPolicy(exec(["policy", "get", sandboxName, "--full", "-o", "json"]));
  } catch {
    current = {};
  }
  if (Object.keys(current).length === 0) current = { ...CANONICAL_BASE_POLICY };
  const merged = mergeEgressIntoPolicy(current, netFetchHosts, gitPushHosts);
  const path = writeTmp(JSON.stringify(merged)); // JSON is valid YAML, which `openshell policy set` parses
  exec(["policy", "set", sandboxName, "--policy", path, "--yes"]);
  const back = innerPolicy(exec(["policy", "get", sandboxName, "--full", "-o", "json"]));
  const missing = missingNetFetchHosts(back, netFetchHosts);
  if (missing.length > 0) {
    throw new Error(
      `provisionEgressPolicy: readback missing net.fetch host(s) after set (fail-closed): ${missing.join(", ")}`,
    );
  }
}

/**
 * PROD `PolicyExec`: run the `openshell` CLI (the policy get/set the gateway exposes; the gRPC adapter has no
 * policy RPC in its pinned subset — a gRPC seam is a future hardening). 60s cap. Throws on a non-zero exit.
 */
export const realPolicyExec: PolicyExec = (args) =>
  execFileSync("openshell", [...args], { encoding: "utf8", timeout: 60_000 });

/** PROD `WriteTmp`: a fresh 0700 temp dir + a JSON policy file (the merged policy `openshell policy set` reads). */
export function realWriteTmp(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "agentos-egress-")), "policy.json");
  writeFileSync(path, content);
  return path;
}
