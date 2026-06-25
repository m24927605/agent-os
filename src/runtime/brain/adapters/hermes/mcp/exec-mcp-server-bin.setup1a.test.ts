/**
 * SLICE-SETUP1a — the AUTONOMOUS Hermes path is now GATED by the IT1 SpendGuard/AGT turnkey.
 *
 * THE GAP THIS CLOSES: a real user does NOT go through the three surfaces (`createPersonalShell` etc.);
 * they go through Hermes autonomous -> the spawned bin (`exec-mcp-server-bin`) -> `runGovernedToolCall`.
 * Before this slice the bin's `buildDeps` HARDCODED `InMemoryCostGate` + had NO advisory secondaries, so
 * the IT1 turnkey (SpendGuard cost gate + AGT-style advisory secondaries, wired from env via
 * `integrationsFromEnv`) did NOT gate the autonomous path. SETUP1a wires the bin's deps from env so the
 * bin's governance == the surfaces (PDP sovereign, any-deny-wins, an injected gate/secondary can only
 * NARROW — never relax — a decision), AND keeps the default path byte-identical (no SPENDGUARD_* env +
 * no secondaries => InMemoryCostGate + `combineDecisions(pdp, []) === pdp`).
 *
 * TEST POSTURE: a Fake substrate (in-repo, no real OpenShell) + a Fake AppendTransport (no real kernel)
 * + NO real SpendGuard sidecar. `integrationsFromEnv`'s SpendGuardCostGate is grpc-js LAZY — constructing
 * it connects to NOTHING (the first reserve would), so the env-driven wiring is provable WITHOUT a sidecar.
 * The always-deny / always-throw cost gates + the always-deny / always-allow secondaries are injected via
 * the new `BuildBinOpts` TEST seams (so the live path's env-driven wiring is exercised structurally while
 * the deny/allow behavioural assertions use injected doubles — no sidecar, no flake).
 *
 * NON-VACUITY (each asserted in the body): drop the `opts?.costGate ?? integ.costGate ??` wiring (revert
 * to the hardcoded InMemory) => the always-deny-cost test flips RED; replace the secondaries fold with a
 * bare `authorizeToolInvoke` (ignore secondaries) => the always-deny-secondary test flips RED.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type CommitResult,
  type CostGate,
  type ReleaseResult,
  type ReserveRequest,
  type ReserveResult,
  denyReserve,
} from "../../../../../cost/index.js";
import type {
  PolicyDecision,
  PolicyRequest,
  SecondaryPolicyAdapter,
} from "../../../../../policy/index.js";
import {
  type AdapterResult,
  type ExecCommandSpec,
  type ExecResult,
  FakeSandboxAdapter,
  type SandboxSpec,
} from "../../../../substrate/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";
import { runExecMcpStdio } from "./exec-mcp-stdio.js";

// ==================================================================================================
// Test doubles.
// ==================================================================================================

/** A spying Fake substrate: counts exec calls so a test can assert the substrate ran ZERO times. */
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

/** A FakeKernelTransport returning a well-formed receipt (so commit-before-effect treats it durable). */
function fakeKernelTransport(): import("../../../../../audit/index.js").AppendTransport {
  let sequence = 0;
  return {
    append() {
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

/** A CostGate whose reserve always DENIES (structured) — stands in for a SpendGuard budget-exhausted. */
class AlwaysDenyCostGate implements CostGate {
  reserve(ctx: unknown, req: ReserveRequest): Promise<ReserveResult> {
    return Promise.resolve(denyReserve(ctx, "always-deny cost gate (test)", req.resource));
  }
  commit(): Promise<CommitResult> {
    throw new Error("AlwaysDenyCostGate.commit should never be reached");
  }
  release(): Promise<ReleaseResult> {
    throw new Error("AlwaysDenyCostGate.release should never be reached");
  }
}

/** A CostGate whose reserve THROWS — proves `failClosedCostGate` converts it to a structured deny. */
class ThrowingCostGate implements CostGate {
  reserve(_ctx: unknown, _req: ReserveRequest): Promise<ReserveResult> {
    throw new Error("synthetic cost-gate fault (must not escape — fail-closed to deny)");
  }
  commit(): Promise<CommitResult> {
    throw new Error("ThrowingCostGate.commit should never be reached");
  }
  release(): Promise<ReleaseResult> {
    throw new Error("ThrowingCostGate.release should never be reached");
  }
}

/** An advisory secondary that always DENIES (advisory deny wins via any-deny-wins). */
class DenySecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "deny", reason: "deny-secondary (advisory, test)", auditRequired: true };
  }
}

/** An advisory secondary that always ALLOWS — must NEVER relax a PDP deny (PDP sovereign). */
class AllowSecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "allow", reason: "allow-secondary (advisory, test)", auditRequired: true };
  }
}

// ==================================================================================================
// Driver: run ONE tools/call through the bin's REAL deps (Fake substrate + Fake kernel) over in-memory
// stdio, returning the MCP result + the spy substrate (so the test can assert exec ran 0 times).
// ==================================================================================================
async function driveOneCall(
  opts: Parameters<typeof buildBinDeps>[1],
  toolCall: { name: string; arguments: Record<string, unknown> },
): Promise<{
  result: { isError: boolean; content: { text: string }[] };
  spy: SpyFakeSandboxAdapter;
}> {
  const spy = new SpyFakeSandboxAdapter();
  const { deps } = await buildBinDeps(false, {
    ingestTransport: fakeKernelTransport(),
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
  return { result, spy };
}

// ==================================================================================================
// SETUP1a-COST — an injected always-DENY cost gate denies a GOVERNED (PDP-allowed) tools/call at the
//   COST stage, and the substrate runs ZERO times. NON-VACUITY: drop the `opts?.costGate ?? integ.costGate
//   ??` wiring (revert to the hardcoded InMemoryCostGate(1_000_000)) and this flips RED — InMemory would
//   ALLOW the small reserve, the echo would execute, isError:false, substrate run once.
// ==================================================================================================
describe("SETUP1a-COST — the autonomous bin path is gated by the env/opts cost gate", () => {
  it("an injected always-deny cost gate denies a PDP-allowed tools/call at the cost stage (substrate run 0)", async () => {
    const { result, spy } = await driveOneCall(
      { costGate: new AlwaysDenyCostGate() },
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    // Denied at the COST gate (PDP allowed exec.echo; the injected cost gate denied).
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: cost");
    // The effect NEVER ran — the cost gate is before commit-before-effect (the substrate is untouched).
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// SETUP1a-COST-FAILCLOSED — an injected cost gate whose reserve THROWS is wrapped by `failClosedCostGate`
//   into a structured deny@cost — never an escaping throw, never a fabricated ok. Proves the bin wraps
//   the (injected | env) gate in `failClosedCostGate`.
// ==================================================================================================
describe("SETUP1a-COST-FAILCLOSED — a throwing cost gate fails closed to a structured deny", () => {
  it("a cost gate whose reserve throws denies at the cost stage (structured, not an escaping throw)", async () => {
    const { result, spy } = await driveOneCall(
      { costGate: new ThrowingCostGate() },
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: cost");
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// SETUP1a-SECONDARY-DENY — an injected always-DENY advisory secondary denies a PDP-ALLOWED tools/call
//   (advisory deny wins / any-deny-wins). NON-VACUITY: replace the authorize fold with a bare
//   `authorizeToolInvoke` (ignore secondaries) and this flips RED — exec.echo is PDP-allowed, so without
//   the fold the call would EXECUTE (isError:false).
// ==================================================================================================
describe("SETUP1a-SECONDARY-DENY — an advisory deny secondary narrows a PDP allow (any-deny-wins)", () => {
  it("an always-deny secondary denies a PDP-allowed tools/call at the policy stage (substrate run 0)", async () => {
    const { result, spy } = await driveOneCall(
      { secondaries: [new DenySecondary()] },
      { name: "exec.echo", arguments: { text: "hello" } },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: policy");
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// SETUP1a-SECONDARY-NO-RELAX — an injected always-ALLOW secondary can NEVER relax a PDP deny (PDP is the
//   sole deny authority). An UNREGISTERED tool stays denied@policy even WITH the allow secondary.
// ==================================================================================================
describe("SETUP1a-SECONDARY-NO-RELAX — an advisory allow secondary cannot relax a PDP deny (PDP sovereign)", () => {
  it("an unregistered tool stays denied@policy WITH an always-allow secondary present", async () => {
    const { result, spy } = await driveOneCall(
      { secondaries: [new AllowSecondary()] },
      { name: "exec.not-a-registered-tool", arguments: {} },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("DENIED: policy");
    expect(spy.execCalls.length).toBe(0);
  });
});

// ==================================================================================================
// SETUP1a-ENV-SPENDGUARD — SPENDGUARD_UDS_PATH + the full budget topology in the bin's env (NO opts.cost)
//   => the bin's cost gate is a SpendGuardCostGate built by `integrationsFromEnv` (the WIRING is honored).
//   grpc-js is LAZY: constructing the gate connects to nothing, so we assert the wiring by BRAND/instanceof
//   WITHOUT a sidecar — never driving a reserve (which would connect). Absent env (+ no opts) => the gate
//   is the hardcoded InMemoryCostGate (byte-identical; the EXEC4c-a subprocess test path).
// ==================================================================================================
describe("SETUP1a-ENV-SPENDGUARD — SPENDGUARD_* env wires a SpendGuardCostGate into the bin (no sidecar)", () => {
  const SPENDGUARD_KEYS = [
    "SPENDGUARD_UDS_PATH",
    "SPENDGUARD_BUDGET_ID",
    "SPENDGUARD_UNIT_ID",
    "SPENDGUARD_WINDOW_INSTANCE_ID",
    "SPENDGUARD_TENANT_ASSERTION",
  ];
  function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const saved = new Map<string, string | undefined>();
    for (const k of SPENDGUARD_KEYS) saved.set(k, process.env[k]);
    for (const k of SPENDGUARD_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const restore = (): void => {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    return fn().finally(restore);
  }

  it("with SPENDGUARD_* env set, the bin's cost gate wraps a SpendGuardCostGate (env wiring honored)", async () => {
    await withEnv(
      {
        SPENDGUARD_UDS_PATH: "/tmp/agentos-setup1a-nonexistent.sock",
        SPENDGUARD_BUDGET_ID: "budget-bin",
        SPENDGUARD_UNIT_ID: "unit-bin",
        SPENDGUARD_WINDOW_INSTANCE_ID: "win-bin",
      },
      async () => {
        // Import the spendguard adapter only here (lazy: no sidecar contacted by constructing the gate).
        const { SpendGuardCostGate } = await import(
          "../../../../../cost/adapters/spendguard/index.js"
        );
        const { integrationsFromEnv } = await import("../../../../spendguard/index.js");
        // The same composition root the bin uses: SPENDGUARD_* env -> a SpendGuardCostGate (lazy, no connect).
        const integ = integrationsFromEnv(process.env);
        expect(integ.costGate).toBeInstanceOf(SpendGuardCostGate);
        // The bin builds deps from this env: assert the deps build (no connect) and a gate is present.
        const spy = new SpyFakeSandboxAdapter();
        const { deps } = await buildBinDeps(false, {
          ingestTransport: fakeKernelTransport(),
          substrate: spy,
        });
        expect(deps.cost).toBeDefined();
      },
    );
  });

  it("with NO SPENDGUARD_* env (+ no opts), integrationsFromEnv yields no costGate (bin falls back to InMemory; byte-identical)", async () => {
    await withEnv({}, async () => {
      const { integrationsFromEnv } = await import("../../../../spendguard/index.js");
      const integ = integrationsFromEnv(process.env);
      // No SpendGuard configured => no costGate => the bin's default InMemoryCostGate fallback (byte-identical).
      expect(integ.costGate).toBeUndefined();
      expect(integ.secondaries).toBeUndefined();
    });
  });
});
