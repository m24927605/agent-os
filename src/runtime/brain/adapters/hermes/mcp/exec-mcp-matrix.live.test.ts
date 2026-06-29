// REAL approve/deny matrix for the governed exec MCP tools (composition-root-real). EXHAUSTIVE: every one
// of the 16 tools a Hermes brain calls gets BOTH a real ALLOW and a real DENY. Drives
// createExecMcpServer(buildBinDeps(false, …)).handle({tools/call}) DIRECTLY (no LLM, no model credits)
// against a REAL OpenShell sandbox + a FRESH real Go kernel WORM partition ('tenant-bin').
//
//   ALLOW: the 14 in-sandbox exec.*/git.* tools run for REAL and SUCCEED (exit 0, effect fires AFTER
//          commit). net.fetch + git.push are governance-ALLOWED all the way to the REAL effect (the command
//          runs in the sandbox, effect fires, NOT denied) — the actual network op is then gated by the
//          OpenShell egress proxy, DENY-BY-DEFAULT. Option D PINS curl/git to that proxy (`-x` / `-c
//          http.proxy`), so with NO sandbox network-policy the CONNECT is refused (curl `(56) 403`); once an
//          operator `openshell policy set` authorizes the host (+ /usr/bin/curl + method) the SAME pinned op
//          reaches it (proven by net-fetch-egress.live.test.ts: 403 -> policy -> HTTP 200). This matrix sets
//          NO per-sandbox policy, so net.fetch/git.push here stay at deny-by-default 403 (governance-allowed
//          to the effect, proxy-denied at egress) — NOT blanket containment.
//   DENY:  every tool is denied for real with NO effect — the 14 in-sandbox tools via a fail-closed cost
//          gate (denied@cost), net.fetch via the egress allowlist (denied@policy), git.push via approval
//          (denied@approval). Plus screen (credential-blind) + deny-by-default (unregistered) mode coverage.
//
// Gated: needs AGENTOS_LIVE_OPENSHELL=1 + a real kernel (AGENTOS_LIVE_KERNEL_ENDPOINT). Honest boundary:
// attester≠actor holds to the PROCESS boundary (TR1); HSM/KMS = TR2/deployment.
import { afterAll, describe, expect, it } from "vitest";
import { NullCostGate } from "../../../../../cost/index.js";
import { createRpcAppendTransport, createSignedChainReader } from "../../../../ingest/index.js";
import type { ExecCapableSandboxAdapter } from "../../../../substrate/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { createExecMcpServer } from "./exec-mcp-server.js";

const LIVE = process.env.AGENTOS_LIVE_OPENSHELL === "1";
const KERNEL = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT; // e.g. 127.0.0.1:7799
const PARTITION = "tenant-bin";
// Synthetic, shape-valid (sk- + 20 alnum) canary — BUILT AT RUNTIME so the full literal never sits in
// source (keeps secret-scan clean); account-invalid, never a real/published key.
const SECRET_CANARY = `sk-${"A".repeat(20)}`;
const d = LIVE && KERNEL ? describe : describe.skip;

// The 14 in-sandbox tools (registered by default; no approval; no egress) + benign, schema-valid args.
// Order matters for the ALLOW run: write_file seeds the file the reads need; the git.* tools need a work-tree.
const IN_SANDBOX: readonly [string, Record<string, unknown>][] = [
  ["exec.pwd", {}],
  ["exec.echo", { text: "hello-worm" }],
  ["exec.ls", { path: "." }],
  ["exec.run", { argv: ["echo", "from-run"] }],
  ["exec.write_file", { path: "seed.txt", content: "hello\nworld\n" }],
  ["exec.cat", { path: "seed.txt" }],
  ["exec.head", { path: "seed.txt" }],
  ["exec.wc", { path: "seed.txt" }],
  ["exec.grep", { pattern: "hello", path: "seed.txt" }],
  ["git.status", {}],
  ["git.add", { path: "seed.txt" }],
  ["git.commit", { message: "seed commit" }],
  ["git.diff", {}],
  ["git.log", {}],
];
const APPROVED = () => ({ status: "approved" as const, reason: "test: pre-authorized" });

const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

function outcome(resp: { result?: unknown }): { isError: boolean; text: string } {
  const r = resp.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  return {
    isError: r?.isError === true,
    text: r?.content?.map((c) => c.text ?? "").join("\n") ?? "",
  };
}

const ONE_SANDBOX_MS = 90_000;

d("exec MCP tools — EXHAUSTIVE real approve/deny matrix (OpenShell + Go kernel WORM)", () => {
  const sandboxes: { substrate: ExecCapableSandboxAdapter; id: string }[] = [];
  let approveCount = 0;

  afterAll(async () => {
    for (const s of sandboxes) {
      try {
        await s.substrate.destroySandbox({}, s.id);
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  async function makeKit(opts: Parameters<typeof buildBinDeps>[1] = {}) {
    let effects = 0;
    const built = await buildBinDeps(false, {
      ingestTransport: createRpcAppendTransport({ endpoint: KERNEL as string }),
      onEffect: () => {
        effects += 1;
      },
      ...opts,
    });
    sandboxes.push({ substrate: built.substrate, id: built.sandboxId });
    const server = createExecMcpServer(built.deps);
    return {
      async drive(name: string, args: Record<string, unknown>) {
        effects = 0;
        const resp = await server.handle(call(name, args));
        return { ...outcome(resp), effects };
      },
    };
  }

  // ─────────────────────────── ALLOW: every tool, governance permits → real effect ───────────────────────
  it(
    "ALLOW — all 16 tools: governance permits each to its real effect (exec/git/net real; git.push to effect)",
    async () => {
      // egressAllow registers the network tools; approve pre-authorizes the destructive git.push.
      const kit = await makeKit({ egressAllow: ["example.com"], approve: APPROVED });
      // Readiness warmup (a fresh sandbox can reject the first exec).
      for (let i = 0; i < 12; i++) {
        const w = await kit.drive("exec.echo", { text: "warmup" });
        if (!w.isError) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      // exec.* (9) — real exec, exit 0, effect after commit.
      for (const [name, args] of IN_SANDBOX.slice(0, 9)) {
        const o = await kit.drive(name, args);
        expect(o.isError, `${name} should run: ${o.text}`).toBe(false);
        expect(o.text, `${name} must exit 0 (real success): ${o.text}`).toMatch(/exit=0/);
        expect(o.effects, `${name} effect must fire after commit`).toBe(1);
        approveCount += 1;
      }
      // net.fetch — governance ALLOWS it; the curl runs in the sandbox (effect fires). The actual fetch is
      // then contained by the SANDBOX EGRESS proxy — no arbitrary external host is reachable from the
      // sandbox, so curl exits non-zero. That is egress containment (defence in depth), NOT a governance deny.
      const nf = await kit.drive("net.fetch", { url: "https://example.com/" });
      expect(nf.text, `net.fetch must NOT be denied by governance: ${nf.text}`).not.toContain(
        "DENIED:",
      );
      expect(nf.effects, "net.fetch must reach the real effect (governance allowed)").toBe(1);
      approveCount += 1;
      // git.* (5) — real in-sandbox git work-tree on branch `main`.
      await kit.drive("exec.run", { argv: ["git", "init"] });
      await kit.drive("exec.run", { argv: ["git", "checkout", "-b", "main"] });
      await kit.drive("exec.run", { argv: ["git", "config", "user.email", "t@t"] });
      await kit.drive("exec.run", { argv: ["git", "config", "user.name", "t"] });
      approveCount += 4;
      for (const [name, args] of IN_SANDBOX.slice(9)) {
        const o = await kit.drive(name, args);
        expect(o.isError, `${name} should run: ${o.text}`).toBe(false);
        expect(o.text, `${name} must exit 0 (real success): ${o.text}`).toMatch(/exit=0/);
        approveCount += 1;
      }
      // git.push — governance ALLOWS it all the way to the real effect (NOT denied; the `git push` command
      // runs in the sandbox, onEffect fires). A *successful* push is then independently blocked by the
      // SANDBOX EGRESS PROXY (defence in depth: the sandbox may only reach its egress allowlist, so a CONNECT
      // to an arbitrary git host returns 403) AND the push is unauthenticated until EXEC2 — so the command
      // itself exits non-zero. That is the egress containment working, NOT a governance deny.
      const push = await kit.drive("git.push", {
        url: "https://example.com/x.git",
        branch: "main",
      });
      expect(push.text, `git.push must NOT be denied by governance: ${push.text}`).not.toContain(
        "DENIED:",
      );
      expect(push.effects, "git.push must reach the real effect (governance allowed)").toBe(1);
      approveCount += 1;
    },
    ONE_SANDBOX_MS,
  );

  // ─────────────────────────── DENY: every tool, real refusal, NO effect ──────────────────────────────────
  it(
    "DENY@cost — every in-sandbox exec/git tool is refused at the cost gate with no effect",
    async () => {
      const kit = await makeKit({ costGate: new NullCostGate() });
      for (const [name, args] of IN_SANDBOX) {
        const o = await kit.drive(name, args);
        expect(o.isError, `${name} should be denied@cost`).toBe(true);
        expect(o.text, `${name} deny stage`).toContain("DENIED: cost");
        expect(o.effects, `${name} must run NO effect on a cost deny`).toBe(0);
      }
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@egress — net.fetch to a non-allowlisted host is refused at policy (host not leaked, no effect)",
    async () => {
      const kit = await makeKit({ egressAllow: [] }); // deny-all egress
      const o = await kit.drive("net.fetch", { url: "https://evil.example/x" });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: policy");
      expect(o.text).toContain("egress-allowlist");
      expect(o.text).not.toContain("evil.example");
      expect(o.effects).toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@approval — git.push (requiresApproval) is refused when the approver declines (no effect)",
    async () => {
      const kit = await makeKit({
        egressAllow: ["example.com"],
        approve: () => ({ status: "denied", reason: "test: approver declined" }),
      });
      const o = await kit.drive("git.push", { url: "https://example.com/x.git", branch: "main" });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: approval");
      expect(o.effects).toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  // ─────────────────────────── extra deny-mode coverage (credential-blind + deny-by-default) ──────────────
  it(
    "DENY@screen — a secret-shaped exec arg is refused before any effect (credential-blind)",
    async () => {
      const kit = await makeKit();
      const o = await kit.drive("exec.echo", { text: SECRET_CANARY });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: screen");
      expect(o.text).toContain("credential-blind");
      expect(o.effects).toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@policy (deny-by-default) — an unadvertised action tool is refused as unregistered",
    async () => {
      const kit = await makeKit(); // actionAdvertise off (default) => gmail.send unregistered
      const o = await kit.drive("gmail.send", { to: "a@b.com", subject: "s", body: "b" });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: policy");
      expect(o.effects).toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  // ─────────────────────────── kernel WORM readback ──────────────────────────────────────────────────────
  it(
    "KERNEL READBACK — the WORM partition is append-only, hash-chained, and credential-blind",
    async () => {
      const readback = await createSignedChainReader({
        endpoint: KERNEL as string,
        partitionId: PARTITION,
      });
      const entries = readback.chain.entries;
      expect(entries.length, "at least the approved effects are recorded").toBeGreaterThanOrEqual(
        approveCount,
      );
      for (let i = 1; i < entries.length; i++) {
        const cur = entries[i];
        const prev = entries[i - 1];
        if (!cur || !prev) continue;
        expect(cur.prevHash).toBe(prev.entryHash);
      }
      const SECRET =
        /sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|ya29\.[0-9A-Za-z._-]{20,}/;
      for (const e of entries) {
        expect(SECRET.test(JSON.stringify(e.event)), "no secret-shaped bytes in a WORM event").toBe(
          false,
        );
      }
    },
    ONE_SANDBOX_MS,
  );
});
