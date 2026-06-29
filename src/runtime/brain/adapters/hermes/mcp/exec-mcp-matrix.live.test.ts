// REAL approve/deny matrix for the governed exec MCP tools (composition-root-real). Drives
// createExecMcpServer(buildBinDeps(false, …)).handle(tools/call) DIRECTLY (no LLM, no credits) against a
// REAL OpenShell sandbox + a REAL Go kernel WORM partition ('tenant-bin'). Each (tool × scenario) is one
// deterministic governed edge: APPROVE => isError:false + onEffect fired; DENY => isError:true +
// "DENIED: <stage> — <reason>" + onEffect NEVER fired. A final readback verifies the kernel chain is
// append-only/hash-chained and credential-blind. Gated: needs AGENTOS_LIVE_OPENSHELL=1 + a real kernel
// (AGENTOS_LIVE_KERNEL_ENDPOINT). Honest boundary: attester≠actor holds to the PROCESS boundary (TR1).
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

const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: "2.0" as const,
  id: 1,
  method: "tools/call",
  params: { name, arguments: args },
});

// Parse the McpToolResult out of a handle() response.
function outcome(resp: { result?: unknown }): { isError: boolean; text: string } {
  const r = resp.result as { isError?: boolean; content?: { text?: string }[] } | undefined;
  return {
    isError: r?.isError === true,
    text: r?.content?.map((c) => c.text ?? "").join("\n") ?? "",
  };
}

const ONE_SANDBOX_MS = 60_000;

d("exec MCP tools — REAL approve/deny matrix (OpenShell + Go kernel WORM)", () => {
  const sandboxes: { substrate: ExecCapableSandboxAdapter; id: string }[] = [];
  let approveCount = 0; // # of executed effects we expect in the WORM partition

  afterAll(async () => {
    for (const s of sandboxes) {
      try {
        await s.substrate.destroySandbox({}, s.id);
      } catch {
        /* best-effort cleanup */
      }
    }
  });

  // makeKit builds ONE composition (one real sandbox + real kernel appender) with the given policy seams.
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
      effects: () => effects,
      resetEffects: () => {
        effects = 0;
      },
      async drive(name: string, args: Record<string, unknown>) {
        effects = 0;
        const resp = await server.handle(call(name, args));
        return { ...outcome(resp), effects };
      },
    };
  }

  it(
    "APPROVE: in-sandbox exec/git tools execute (real OpenShell, exit 0) and fire the effect after commit",
    async () => {
      const kit = await makeKit({ egressAllow: ["example.com"] }); // allow one real egress host for net.fetch
      // Readiness warmup: a freshly-created sandbox may not accept the FIRST exec immediately (the live
      // capstone got readiness "for free" via the LLM's latency). Retry a benign exec until the stream is
      // ready. These warmup calls append to the SAME (primary) kit, so sequence numbering stays monotonic.
      for (let i = 0; i < 12; i++) {
        const w = await kit.drive("exec.echo", { text: "warmup" });
        if (!w.isError) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      // read-only + seed
      for (const [name, args] of [
        ["exec.pwd", {}],
        ["exec.echo", { text: "hello-worm" }],
        ["exec.write_file", { path: "seed.txt", content: "hello\nworld\n" }],
        ["exec.cat", { path: "seed.txt" }],
        ["exec.head", { path: "seed.txt" }],
        ["exec.wc", { path: "seed.txt" }],
        ["exec.grep", { pattern: "hello", path: "seed.txt" }],
        ["exec.ls", { path: "." }],
        ["exec.run", { argv: ["echo", "from-run"] }],
      ] as const) {
        const o = await kit.drive(name, args as Record<string, unknown>);
        expect(o.isError, `${name} should be executed: ${o.text}`).toBe(false);
        expect(o.effects, `${name} effect must fire after commit`).toBe(1);
        approveCount += 1;
      }
      // net.fetch: a REAL fetch from INSIDE the sandbox to an allowlisted host (real network egress).
      const nf = await kit.drive("net.fetch", { url: "https://example.com/" });
      expect(nf.isError, `net.fetch should execute a real fetch: ${nf.text}`).toBe(false);
      approveCount += 1;
      // git: init a work-tree in the sandbox, then exercise the git.* read/mutation tools
      await kit.drive("exec.run", { argv: ["git", "init"] });
      await kit.drive("exec.run", { argv: ["git", "config", "user.email", "t@t"] });
      await kit.drive("exec.run", { argv: ["git", "config", "user.name", "t"] });
      approveCount += 3;
      for (const [name, args] of [
        ["git.status", {}],
        ["git.add", { path: "seed.txt" }],
        ["git.commit", { message: "seed commit" }],
        ["git.diff", {}],
        ["git.log", {}],
      ] as const) {
        const o = await kit.drive(name, args as Record<string, unknown>);
        expect(o.isError, `${name} should be executed: ${o.text}`).toBe(false);
        approveCount += 1;
      }
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@screen: a secret-shaped exec arg is refused before any effect (credential-blind)",
    async () => {
      const kit = await makeKit();
      const o = await kit.drive("exec.echo", { text: SECRET_CANARY });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: screen");
      expect(o.text).toContain("credential-blind");
      expect(o.effects, "no effect on a screen deny").toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@cost: a fail-closed cost gate denies at reserve, before commit/effect",
    async () => {
      const kit = await makeKit({ costGate: new NullCostGate() });
      const o = await kit.drive("exec.echo", { text: "hello" });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: cost");
      expect(o.effects, "no effect on a cost deny").toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@egress: net.fetch to a non-allowlisted host is denied at policy (count-only, host not leaked)",
    async () => {
      const kit = await makeKit({ egressAllow: [] }); // deny-all egress
      const o = await kit.drive("net.fetch", { url: "https://evil.example/x" });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: policy");
      expect(o.text).toContain("egress-allowlist");
      expect(o.text).not.toContain("evil.example"); // host must NOT be leaked
      expect(o.effects).toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@approval: git.push (requiresApproval) is denied when the approver refuses",
    async () => {
      const kit = await makeKit({
        egressAllow: ["github.com"],
        approve: () => ({ status: "denied", reason: "test: approver refused" }),
      });
      const o = await kit.drive("git.push", { url: "https://github.com/x/y.git", branch: "main" });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: approval");
      expect(o.effects).toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  it(
    "DENY@policy (deny-by-default): an unadvertised action tool is rejected as unregistered",
    async () => {
      const kit = await makeKit(); // actionAdvertise off (default) => gmail.send unregistered
      const o = await kit.drive("gmail.send", { to: "a@b.com", subject: "s", body: "b" });
      expect(o.isError).toBe(true);
      expect(o.text).toContain("DENIED: policy");
      expect(o.effects).toBe(0);
    },
    ONE_SANDBOX_MS,
  );

  it(
    "KERNEL READBACK: the WORM partition is append-only, hash-chained, and credential-blind",
    async () => {
      const readback = await createSignedChainReader({
        endpoint: KERNEL as string,
        partitionId: PARTITION,
      });
      const entries = readback.chain.entries;
      expect(entries.length, "at least the approved effects are recorded").toBeGreaterThanOrEqual(
        approveCount,
      );
      // hash-chain links: each entry's prevHash == the previous entry's entryHash
      for (let i = 1; i < entries.length; i++) {
        const cur = entries[i];
        const prev = entries[i - 1];
        if (!cur || !prev) continue;
        expect(cur.prevHash).toBe(prev.entryHash);
      }
      // credential-blindness: no secret-shaped bytes anywhere in the appended events
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
