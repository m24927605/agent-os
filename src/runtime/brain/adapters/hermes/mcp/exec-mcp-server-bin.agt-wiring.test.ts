/**
 * SLICE-R9b-2b — the bin's authorize closure WIRES the AGT advisory into the autonomous path (RED-first).
 *
 * Before this slice the bin folded advisory secondaries (SETUP1a) but NEVER attached a governance
 * projection to the request — so an AGT endpoint secondary had nothing to consume and (R9b-2b) abstains.
 * This slice makes `buildDeps.authorize`:
 *   - build the R9b-1 projection for an IN-SCOPE effectful tool (exec.run) via `buildProjectionForCall`
 *     over the bin's `seedBindings()` + `registry.lookup` + the AGT scope (default effectful);
 *   - attach it to `req.governanceProjection` ONLY when present (absent => req byte-identical);
 *   - fold the secondaries EXACTLY as before (combineDecisions(pdp, evaluateSecondaries(...)) + redact).
 *
 * Paired with the endpoint-secondary scope-skip: an AGT secondary CONSULTS the transport only when a
 * projection is present; for a read-only tool (no projection) it ABSTAINS (allow) WITHOUT a transport call.
 *
 * TEST POSTURE: a Fake substrate + a Fake AppendTransport (no real kernel) + a FAKE AgtDecisionTransport
 * (a `{ evaluate }` spy that counts calls — NO real grpc / sidecar). The endpoint secondary
 * (`createAgtEndpointSecondary`) is the REAL adapter over the fake transport, injected via the bin's
 * `BuildBinOpts.secondaries` test seam (the same seam SETUP1a uses).
 *
 * NON-VACUITY (asserted in-body):
 *   - SCOPE-SKIP: a read-only `exec.echo` consults the AGT transport ZERO times (it abstains). Make the
 *     secondary call the transport even with NO projection (drop the scope-skip) and this flips RED.
 *   - PARTICIPATES: an effectful `exec.run` + AGT-deny -> the authorize decision is DENY. Drop the
 *     projection attach (so AGT abstains on exec.run too) and this flips RED (it would be allow).
 *   - PDP-SOVEREIGN: an AGT allow can never relax a PDP deny (an unregistered tool stays denied).
 */
import { describe, expect, it } from "vitest";
import type { AppendTransport } from "../../../../../audit/index.js";
import type {
  AgtEvaluateRequest,
  AgtEvaluateResponse,
} from "../../../../agt/_generated/agt_decision.js";
import { type AgtDecisionTransport, createAgtEndpointSecondary } from "../../../../agt/index.js";
import { FakeSandboxAdapter } from "../../../../substrate/index.js";
import { buildBinDeps } from "./exec-mcp-server-bin.js";

/** A `sk-`-shaped canary assembled at RUNTIME (never a source literal — secret-scan stays clean). */
function skCanary(): string {
  return `${"sk"}-${"Q".repeat(24)}`;
}

/** A fake kernel transport that returns a well-formed monotonic receipt (commit-before-effect durable). */
function fakeKernelTransport(): AppendTransport {
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

/**
 * A FAKE AgtDecisionTransport that records every request it is handed (so a test can assert the call
 * COUNT — the scope-skip means a read-only tool never reaches here) and returns a fixed decision.
 */
function fakeAgtTransport(resp: Partial<AgtEvaluateResponse>): {
  transport: AgtDecisionTransport;
  calls: AgtEvaluateRequest[];
} {
  const calls: AgtEvaluateRequest[] = [];
  return {
    calls,
    transport: {
      async evaluate(r) {
        calls.push(r);
        return {
          allowed: resp.allowed ?? false,
          action: resp.action ?? "",
          matchedRule: resp.matchedRule ?? "",
          reason: resp.reason ?? "",
        };
      },
    },
  };
}

describe("R9b-2b bin wiring — effectful exec.run PARTICIPATES (AGT consulted, PDP-sovereign)", () => {
  it("exec.run + AGT-deny -> the authorize decision is DENY (advisory deny narrows the PDP allow)", async () => {
    const { transport, calls } = fakeAgtTransport({ allowed: false, action: "deny", reason: "no" });
    const { deps } = await buildBinDeps(false, {
      ingestTransport: fakeKernelTransport(),
      substrate: new FakeSandboxAdapter(),
      secondaries: [createAgtEndpointSecondary(transport)],
    });

    const decision = await deps.authorize({
      tool: "exec.run",
      context: deps.context,
      args: { argv: ["ls", "-la"] },
    });

    // The projection was attached -> the AGT secondary CONSULTED the transport (call count 1)…
    expect(calls.length).toBe(1);
    // …and the advisory deny narrowed the PDP allow to a DENY (any-deny-wins, advisory).
    // NON-VACUITY: drop the projection attach -> AGT abstains (allow) -> decision is allow -> RED.
    expect(decision.effect).toBe("deny");
  });

  it("exec.run + AGT-allow + PDP-allow -> allow (the projection reached the transport)", async () => {
    const { transport, calls } = fakeAgtTransport({ allowed: true, action: "allow" });
    const { deps } = await buildBinDeps(false, {
      ingestTransport: fakeKernelTransport(),
      substrate: new FakeSandboxAdapter(),
      secondaries: [createAgtEndpointSecondary(transport)],
    });

    const decision = await deps.authorize({
      tool: "exec.run",
      context: deps.context,
      args: { argv: ["echo", "hi"] },
    });
    expect(calls.length).toBe(1);
    expect(decision.effect).toBe("allow");
  });

  it("the projection that reaches the AGT transport is credential-blind (canary pre-redacted)", async () => {
    const canary = skCanary();
    const { transport, calls } = fakeAgtTransport({ allowed: true, action: "allow" });
    const { deps } = await buildBinDeps(false, {
      ingestTransport: fakeKernelTransport(),
      substrate: new FakeSandboxAdapter(),
      secondaries: [createAgtEndpointSecondary(transport)],
    });

    await deps.authorize({
      tool: "exec.run",
      context: deps.context,
      args: { argv: ["curl", canary, "https://api.example.com"] },
    });

    expect(calls.length).toBe(1);
    const sent = JSON.stringify(calls[0]);
    // ONLY the redacted projection reaches the transport — no raw canary, no raw `argv` array.
    expect(sent).not.toContain(canary);
    expect(sent).not.toContain('argv"'); // only `argvRedacted`, never a raw `argv`
    expect(sent).toContain("[REDACTED]");
  });
});

describe("R9b-2b bin wiring — read-only exec.echo ABSTAINS (no projection -> transport NOT called)", () => {
  it("exec.echo consults the AGT transport ZERO times and authorize stays allow", async () => {
    const { transport, calls } = fakeAgtTransport({ allowed: false, action: "deny", reason: "no" });
    const { deps } = await buildBinDeps(false, {
      ingestTransport: fakeKernelTransport(),
      substrate: new FakeSandboxAdapter(),
      secondaries: [createAgtEndpointSecondary(transport)],
    });

    const decision = await deps.authorize({
      tool: "exec.echo",
      context: deps.context,
      args: { text: "hello" },
    });

    // No projection attached for a read-only tool -> the AGT secondary ABSTAINED without a transport call.
    // NON-VACUITY: make the secondary call the transport even with NO projection (drop the scope-skip) and
    // calls.length would be 1 AND (AGT-deny) the decision would flip to deny -> RED.
    expect(calls.length).toBe(0);
    expect(decision.effect).toBe("allow");
  });
});

describe("R9b-2b bin wiring — PDP sovereign (an AGT allow cannot grant an unregistered tool)", () => {
  it("an UNREGISTERED tool stays DENY even when AGT would allow", async () => {
    const { transport } = fakeAgtTransport({ allowed: true, action: "allow" });
    const { deps } = await buildBinDeps(false, {
      ingestTransport: fakeKernelTransport(),
      substrate: new FakeSandboxAdapter(),
      secondaries: [createAgtEndpointSecondary(transport)],
    });

    const decision = await deps.authorize({
      tool: "exec.not-registered",
      context: deps.context,
      args: { argv: ["ls"] },
    });
    // PDP deny-by-default for an unregistered tool; an AGT allow can NEVER relax it.
    expect(decision.effect).toBe("deny");
  });
});
