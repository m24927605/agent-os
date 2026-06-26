/**
 * SLICE-CAP7 (RED-first) — the bin wires the external-effect boundary ledger END-TO-END.
 *
 * The bin's authorize closure ALREADY reads `registry.lookup(tc.tool)?.containment` (for the CAP6
 * egress fold) and builds the redacted governance projection (for AGT/egress). CAP7 has it ALSO set
 * `external: containment ∈ {network-egress, host-fs-write}` + `projection: <the redacted projection>`
 * on the returned AuthorizeDecision, so the pipeline appends a DISTINCT post-effect boundary WORM
 * event for an EXTERNAL effect that EXECUTED — a stronger record than the commit-before-effect intent.
 *
 * E2E pins (over the bin's REAL deps; Fake substrate + a COUNTING kernel transport):
 *  - net.fetch (external, allowlisted host, executed) => 2 appends (intent + boundary);
 *  - exec.echo (in-sandbox, executed)                 => 1 append  (intent only, NO boundary);
 *  - net.fetch denied (non-allowlisted host)          => 0 appends (effect never ran => NO boundary).
 *
 * NON-VACUITY: a mutation where the bin closure does NOT set `external` makes net.fetch's executed
 * call append ONLY the intent (1) — the boundary disappears — flipping the net.fetch test RED. The
 * boundary action is asserted on the canonical bytes so the in-sandbox path cannot accidentally pass.
 *
 * FAKE substrate (records argv; NO real network). The boundary ledger is an in-repo AUDIT record that
 * an external-CLASSED effect EXECUTED; the real "bytes left to the world" (net.fetch's real network)
 * is a deploy/EXEC2-gated substrate observation (CAP6's honest boundary), not what CAP7 asserts.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AppendTransport } from "../../../../../audit/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

/** A spying Fake substrate (counts exec calls). */
class SpyFakeSandboxAdapter extends FakeSandboxAdapter {
  readonly execCalls: ExecCommandSpec[] = [];
  override createSandbox(ctx: unknown, spec: SandboxSpec): Promise<AdapterResult> {
    return super.createSandbox(ctx, spec);
  }
  override execSandbox(
    ctx: unknown,
    sandboxId: string,
    spec: ExecCommandSpec,
  ): Promise<ExecResult> {
    this.execCalls.push(spec);
    return super.execSandbox(ctx, sandboxId, spec);
  }
}

/**
 * A counting kernel transport: a well-formed receipt per append (so commit-before-effect treats it
 * durable) AND it captures the canonical bytes of EVERY append (the intent + any boundary), so a
 * test can count them and assert the boundary action string appears (or not) on the wire.
 */
function countingKernelTransport(): {
  transport: AppendTransport;
  appends: string[];
} {
  const appends: string[] = [];
  let sequence = 0;
  return {
    appends,
    transport: {
      append(req: { canonicalEvent: Uint8Array }) {
        appends.push(new TextDecoder().decode(req.canonicalEvent));
        sequence += 1;
        return Promise.resolve({
          receipt: {
            sequence,
            contentHash: `content-${sequence}`,
            prevHash: sequence === 1 ? "GENESIS" : `content-${sequence - 1}`,
            entryHash: `entry-${sequence}`,
          },
        });
      },
    },
  };
}

/** Drive ONE tools/call through the bin's REAL deps over in-memory stdio; return the append log + spy. */
async function driveOneCall(
  opts: Parameters<typeof buildBinDeps>[1],
  toolCall: { name: string; arguments: Record<string, unknown> },
): Promise<{
  result: { isError: boolean; content: { text: string }[] };
  appends: string[];
  spy: SpyFakeSandboxAdapter;
}> {
  const spy = new SpyFakeSandboxAdapter();
  const { transport, appends } = countingKernelTransport();
  const { deps } = await buildBinDeps(false, {
    ingestTransport: transport,
    substrate: spy,
    ...opts,
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
  const done = runExecMcpStdio(deps, { input, output });
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: toolCall })}\n`,
  );
  input.end();
  await done;
  const responses = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const result = responses[0]?.result as { isError: boolean; content: { text: string }[] };
  return { result, appends, spy };
}

/** How many of the recorded appends carry the boundary action (`effect.boundary-crossed`)? */
function boundaryCount(appends: string[]): number {
  return appends.filter((a) => a.includes("effect.boundary-crossed")).length;
}

describe("CAP7 e2e — net.fetch (external, allowlisted, executed) => intent + boundary (2 appends)", () => {
  it("net.fetch to an allowlisted host appends 2 events: the intent AND a boundary event", async () => {
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "net.fetch", arguments: { url: "https://api.allowed.example/x" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1); // the effect ran once.
    // Two WORM appends: the commit-before-effect intent + the post-effect boundary.
    expect(appends.length).toBe(2);
    expect(boundaryCount(appends)).toBe(1);
  });
});

describe("CAP7 e2e — exec.echo (in-sandbox, executed) => intent only (1 append, NO boundary)", () => {
  it("an in-sandbox tool appends ONLY the intent; no boundary event", async () => {
    const { result, appends, spy } = await driveOneCall(
      {},
      { name: "exec.echo", arguments: { text: "hi" } },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1);
    // ONE WORM append (the intent); the in-sandbox effect did NOT cross the seal => NO boundary.
    expect(appends.length).toBe(1);
    expect(boundaryCount(appends)).toBe(0);
  });
});

describe("CAP7 e2e — net.fetch DENIED (non-allowlisted) => 0 appends, NO boundary (effect never ran)", () => {
  it("a denied external call appends nothing (no intent, no boundary)", async () => {
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      { name: "net.fetch", arguments: { url: "https://evil.com/x" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("policy");
    expect(spy.execCalls.length).toBe(0); // denied at the policy stage, BEFORE commit-before-effect.
    // No intent (denied before commit), so no boundary either — NEVER boundary-without-effect.
    expect(appends.length).toBe(0);
    expect(boundaryCount(appends)).toBe(0);
  });
});

describe("CAP7 e2e — credential-blind WORM: a URL-query token in an admitted net.fetch URL NEVER reaches the WORM", () => {
  it("net.fetch '...?access_token=<canary>' (allowlisted host) executes, but the canary is in NO append byte", async () => {
    // THE REAL EXPLOIT: `isAllowedFetchUrl` validates protocol/userinfo/host but NOT the path/query, so a
    // `?access_token=<token>` URL is ADMITTED + executed; net.fetch's projector puts the WHOLE URL into
    // argvRedacted (a non-shape token survives `redactSecrets`). The boundary WORM event must record ONLY
    // the safe summary (host/operationClass), so the token must NOT appear in ANY recorded append byte.
    // The canary is built at RUNTIME so the secret scanner stays clean.
    const canary = ["CANARY", "qtok", Math.random().toString(36).slice(2)].join("_");
    const { result, appends, spy } = await driveOneCall(
      { egressAllow: ["api.allowed.example"] },
      {
        name: "net.fetch",
        arguments: { url: `https://api.allowed.example/data?access_token=${canary}` },
      },
    );
    expect(result.isError).toBe(false);
    expect(spy.execCalls.length).toBe(1); // the effect ran (the URL was admitted + executed).
    // intent + boundary both appended...
    expect(appends.length).toBe(2);
    expect(boundaryCount(appends)).toBe(1);
    // ...but the URL-query token leaks into NEITHER the intent NOR the boundary WORM bytes.
    for (const a of appends) {
      expect(a).not.toContain(canary);
      expect(a).not.toContain("access_token");
    }
  });
});
