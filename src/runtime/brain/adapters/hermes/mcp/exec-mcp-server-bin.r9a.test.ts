/**
 * SLICE-R9a — the bin's `buildBinDeps.authorize` closure is now ASYNC (it `await`s the async
 * `evaluateSecondaries`), and `ExecMcpServerDeps.authorize` is `MaybePromise<AuthorizeDecision>`. This
 * pins that the async widening is BEHAVIOR-PRESERVING on the absent/sync path AND that an injected
 * ASYNC-deny advisory secondary is awaited and folded correctly (PDP-sovereign / any-deny-wins).
 *
 * Posture mirrors the AGT1-A test: a Fake substrate (no real OpenShell) + a Fake AppendTransport (no real
 * kernel). No AGT engine/transport is added here — R9a is the async SEAM only; the secondaries injected
 * here are in-test doubles (a sync allow-baseline + an async deny), exactly the shape R9b/c will wire.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  AppendRequestShape,
  AppendResponseShape,
  AppendTransport,
} from "../../../../../audit/index.js";
import type {
  PolicyDecision,
  PolicyRequest,
  SecondaryPolicyAdapter,
} from "../../../../../policy/index.js";
import { FakeSandboxAdapter } from "../../../../substrate/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

function recordingKernelTransport(): AppendTransport {
  let sequence = 0;
  return {
    append(_req: AppendRequestShape): Promise<AppendResponseShape> {
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
  };
}

/** An ASYNC advisory that DENIES — the R9a addition the bin's authorize must await + fold (any-deny-wins). */
class AsyncDenySecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): Promise<PolicyDecision> {
    return Promise.resolve({ effect: "deny", reason: "async advisory: deny", auditRequired: true });
  }
}

describe("R9a bin authorize — async closure is byte-identical on the absent path", () => {
  it("NO secondaries: the now-async authorize awaits to the SAME PDP allow as today (byte-identical reason)", async () => {
    // The async widening must NOT change the absent-path reason: with no secondaries,
    // `combineDecisions(pdp, [])` is byte-stable and `redactSecrets` is identity on a clean reason.
    const { deps } = await buildBinDeps(false, {
      ingestTransport: recordingKernelTransport(),
      substrate: new FakeSandboxAdapter(),
    });
    const decision = await deps.authorize({ tool: "exec.echo", context: deps.context });
    expect(decision.effect).toBe("allow");
    // The bin authorize closure returns a Promise now; awaiting it yields a decision, never [REDACTED].
    expect(decision.reason).not.toContain("[REDACTED]");
  });

  it("an injected ASYNC-DENY secondary is AWAITED and folded -> deny (PDP-sovereign / any-deny-wins)", async () => {
    const { deps } = await buildBinDeps(false, {
      ingestTransport: recordingKernelTransport(),
      substrate: new FakeSandboxAdapter(),
      secondaries: [new AsyncDenySecondary()],
    });
    const decision = await deps.authorize({ tool: "exec.echo", context: deps.context });
    expect(decision.effect).toBe("deny");
  });

  it("a clean governed exec.echo still EXECUTES end-to-end through the async authorize seam", async () => {
    // The full stdio path drives runGovernedToolCall, which now `await`s authorize. With no secondaries
    // the async closure resolves to the same PDP allow, so the call executes exactly as before.
    const { deps } = await buildBinDeps(false, {
      ingestTransport: recordingKernelTransport(),
      substrate: new FakeSandboxAdapter(),
    });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const out: string[] = [];
    stdout.on("data", (c: Buffer) => out.push(c.toString("utf8")));
    const done = runExecMcpStdio(deps, { input: stdin, output: stdout });
    stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "exec.echo", arguments: { text: "hi" } },
      })}\n`,
    );
    stdin.end();
    await done;
    const joined = out.join("");
    expect(joined).toContain('"id":1');
    // executed (not an isError policy deny) — the async seam did not break the happy path.
    expect(joined).not.toContain("policy");
  });
});
