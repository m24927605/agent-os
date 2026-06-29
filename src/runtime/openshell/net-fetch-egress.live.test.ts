/**
 * SLICE-CAP6d (LIVE, gated) — net.fetch's pinned-proxy curl REALLY egresses through the OpenShell proxy.
 *
 * The committed regression guard for Option D: the prior `--noproxy *` could never egress; the proxy pin
 * (`-x <AGENTOS_OPENSHELL_EGRESS_PROXY>`, default the per-netns CONNECT proxy) routes curl through OpenShell's
 * deny-by-default L7 proxy. This proves, against a REAL gateway:
 *   (1) deny-by-default — with NO sandbox network-policy, the pinned curl gets CONNECT 403 (exit != 0); then
 *   (2) operator-authorized — after `openshell policy set` allows api.github.com + /usr/bin/curl + GET, the
 *       SAME pinned argv reaches it -> HTTP 200, exit 0.
 *
 * Gated on AGENTOS_LIVE_OPENSHELL=1 (real sandbox + real network egress); skips offline so `pnpm run verify`
 * stays green. Uses the gRPC adapter (the CLI `sandbox exec` hangs in some local gateways) + the CLI for
 * `policy set` (keyed on the gateway NAME discovered via `sandbox list -o json`, NOT the adapter sandboxId).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenShellSandboxAdapter, createOpenShellGrpcTransport } from "./index.js";

const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const d = ON ? describe : describe.skip;
const CTX = {
  actorId: "agent:net-fetch-egress-live",
  tenantId: "tenant-live",
  projectId: "proj-live",
  taskId: "task-live",
  requestId: "req-nf-egress-1",
};
const SANDBOX_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550";
const mtls = join(homedir(), ".config/openshell/gateways/openshell/mtls");
// The resolved Agent-OS egress proxy (default = the OpenShell per-netns CONNECT proxy convention). The test
// argv MIRRORS net.fetch's pinned prefix (buildNetFetchArgvPrefix) + an `-o/-w` http-code probe.
const PROXY = process.env.AGENTOS_OPENSHELL_EGRESS_PROXY || "http://10.200.0.1:3128";
const NETFETCH = [
  "curl",
  "-q",
  "--globoff",
  "-x",
  PROXY,
  "-sS",
  "-o",
  "/dev/null",
  "-w",
  "HTTP=%{http_code}",
  "--",
  "https://api.github.com/",
];

function newestSandboxName(): string {
  const out = execFileSync("openshell", ["sandbox", "list", "-o", "json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  const parsed = JSON.parse(out) as unknown;
  const items = (
    Array.isArray(parsed) ? parsed : ((parsed as Record<string, unknown>).sandboxes ?? [])
  ) as { name: string; created_at?: string }[];
  if (items.length === 0) throw new Error("no sandboxes listed");
  items.sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  return items[0]?.name ?? "";
}

d(
  "LIVE — net.fetch pinned-proxy curl egresses through the OpenShell proxy (deny-by-default -> authorized)",
  () => {
    let adapter: OpenShellSandboxAdapter;
    let sandboxId: string;
    let tmp: string;
    beforeAll(async () => {
      tmp = mkdtempSync(join(tmpdir(), "nf-egress-"));
      const transport = createOpenShellGrpcTransport({
        endpoint: "127.0.0.1:17670",
        caCertPath: join(mtls, "ca.crt"),
        clientCertPath: join(mtls, "tls.crt"),
        clientKeyPath: join(mtls, "tls.key"),
        deadlineMs: 15_000,
      });
      adapter = new OpenShellSandboxAdapter(transport);
      const created = await adapter.createSandbox(CTX, { image: SANDBOX_IMAGE });
      if (created.status !== "ok") throw new Error(`create denied: ${created.reason}`);
      sandboxId = created.sandboxId;
      const deadline = Date.now() + 120_000;
      for (;;) {
        const v = await adapter.awaitReady(CTX, sandboxId, { deadlineMs: 2_000 });
        if (v.status === "ok") break;
        if (Date.now() >= deadline) throw new Error("sandbox not READY (fail-closed)");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }, 180_000);
    afterAll(async () => {
      if (sandboxId !== undefined) await adapter.destroySandbox(CTX, sandboxId).catch(() => {});
      if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    }, 60_000);

    it("deny-by-default CONNECT 403 -> operator policy -> HTTP 200 (same pinned argv)", async () => {
      const decode = (u: Uint8Array) => new TextDecoder().decode(u);

      // (1) BEFORE any policy: deny-by-default — the OpenShell proxy 403s the CONNECT (no allowlist match).
      const before = await adapter.execSandbox(CTX, sandboxId, NETFETCH, { deadlineMs: 20_000 });
      expect(before.status).toBe("ok"); // the exec RAN; curl itself returns non-zero on the 403
      if (before.status === "ok") expect(before.result.exitCode).not.toBe(0);

      // (2) operator authorizes egress: openshell policy set <gateway-name> --policy gh.yaml (canonical schema).
      const yaml = join(tmp, "gh.yaml");
      writeFileSync(
        yaml,
        [
          "version: 1",
          "filesystem_policy:",
          "  include_workdir: true",
          "  read_only: [/usr, /lib, /proc, /dev/urandom, /app, /etc, /var/log]",
          "  read_write: [/sandbox, /tmp, /dev/null]",
          "landlock:",
          "  compatibility: best_effort",
          "process:",
          "  run_as_user: sandbox",
          "  run_as_group: sandbox",
          "network_policies:",
          "  gh:",
          "    name: gh-readonly",
          "    endpoints:",
          "      - { host: api.github.com, port: 443, protocol: rest, enforcement: enforce, access: read-only }",
          "    binaries:",
          "      - { path: /usr/bin/curl }",
          "",
        ].join("\n"),
      );
      execFileSync(
        "openshell",
        ["policy", "set", newestSandboxName(), "--policy", yaml, "--wait"],
        {
          encoding: "utf8",
          timeout: 60_000,
        },
      );

      // (3) AFTER policy: the SAME pinned-proxy argv now reaches api.github.com -> HTTP 200, exit 0.
      const after = await adapter.execSandbox(CTX, sandboxId, NETFETCH, { deadlineMs: 20_000 });
      expect(after.status).toBe("ok");
      if (after.status === "ok") {
        expect(after.result.exitCode).toBe(0);
        expect(decode(after.result.stdout)).toContain("HTTP=200");
      }
    }, 120_000);
  },
);
