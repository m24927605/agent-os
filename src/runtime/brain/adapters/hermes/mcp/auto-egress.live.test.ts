/**
 * SLICE-CAP6e (LIVE, gated) — buildBinDeps AUTO-PROVISIONS the egress policy at sandbox creation, so
 * net.fetch reaches an allowlisted host WITHOUT a manual `openshell policy set`. The committed regression
 * guard for Option B: with `AGENTOS_EGRESS_ALLOW` set, the bin's REAL OpenShell path materializes the
 * operator allowlist into the sandbox's OpenShell network-policy (merge-aware) before serving — so net.fetch
 * to an allowlisted host succeeds end-to-end (exit 0) with no per-sandbox operator step.
 *
 * Gated on AGENTOS_LIVE_OPENSHELL=1 (real sandbox + real network egress); skips offline. REAL OpenShell
 * substrate + a FAKE kernel (the WORM appender is orthogonal to the egress proof).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppendTransport } from "../../../../../audit/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { createExecMcpServer } from "./exec-mcp-server.js";

const ON = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const d = ON ? describe : describe.skip;

function fakeKernel(): AppendTransport {
  let seq = 0;
  return {
    append() {
      seq += 1;
      return Promise.resolve({
        receipt: {
          sequence: seq,
          contentHash: `c-${seq}`,
          prevHash: seq === 1 ? "GENESIS" : `c-${seq - 1}`,
          entryHash: `e-${seq}`,
        },
      });
    },
  };
}

d(
  "LIVE — buildBinDeps AUTO-provisions egress; net.fetch reaches an allowlisted host with NO manual policy",
  () => {
    let kit: Awaited<ReturnType<typeof buildBinDeps>>;
    beforeAll(async () => {
      process.env.AGENTOS_OPENSHELL_ENDPOINT =
        process.env.AGENTOS_OPENSHELL_ENDPOINT ?? "127.0.0.1:17670";
      process.env.AGENTOS_OPENSHELL_MTLS =
        process.env.AGENTOS_OPENSHELL_MTLS ??
        join(homedir(), ".config/openshell/gateways/openshell/mtls");
      // REAL OpenShell substrate + FAKE kernel; egressAllow => the bin auto-provisions the OpenShell policy.
      kit = await buildBinDeps(false, {
        ingestTransport: fakeKernel(),
        egressAllow: ["api.github.com"],
      });
    }, 200_000);
    afterAll(async () => {
      if (kit !== undefined) await kit.substrate.destroySandbox({}, kit.sandboxId).catch(() => {});
    }, 60_000);

    it("net.fetch https://api.github.com/ => effect runs + exit=0 (auto-provisioned, no manual policy set)", async () => {
      const server = createExecMcpServer(kit.deps);
      const textOf = (r: unknown): string =>
        ((r as { result?: { content?: { text?: string }[] } }).result?.content ?? [])
          .map((c) => c.text ?? "")
          .join("\n");
      // Readiness warmup: a freshly-created sandbox may reject the FIRST exec ("exec stream error before
      // exit"); retry a benign no-arg exec.pwd until it succeeds (the live capstone got this for free via LLM
      // latency). This is orthogonal to the egress proof — the policy was already auto-provisioned at create.
      for (let i = 0; i < 30; i++) {
        const w = await server.handle({
          jsonrpc: "2.0",
          id: 0,
          method: "tools/call",
          params: { name: "exec.pwd", arguments: {} },
        });
        if (/exit=0/.test(textOf(w))) break;
        await new Promise((r) => setTimeout(r, 1_500));
      }
      const res = await server.handle({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "net.fetch", arguments: { url: "https://api.github.com/" } },
      });
      const text = textOf(res);
      expect(text).not.toContain("DENIED:"); // governance allowed it to the effect
      expect(text).toMatch(/exit=0/); // the auto-provisioned policy let curl REACH api.github.com (HTTP 200)
    }, 120_000);
  },
);
