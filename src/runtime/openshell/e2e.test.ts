/**
 * OPT-IN, DEFAULT-SKIP real OpenShell gateway smoke test (slice P2R-R1-S6).
 *
 * There is NO live OpenShell server in CI / the default dev env (design §7.4). So this integration
 * test is gated behind an env flag and is `describe.skip` unless it is set — mirroring the
 * `scripts/proto-check.sh` "toolchain absent => clean skip" philosophy. It NEVER touches the network
 * in the default `pnpm run verify` run, so it cannot flip the red/green verdict. The default contract
 * proof lives in `src/test-contracts/sandbox-adapter.test.ts` (injected transport double).
 *
 * To run it against a real, already-deployed gateway:
 *   OPENSHELL_E2E_BASE_URL=https://<gateway> pnpm test src/runtime/openshell/e2e.test.ts
 *
 * SCOPE (honest): the connect-node client wires the `Health` RPC (S1); the lifecycle/exec RPCs over
 * real gRPC are not yet descriptor-bound (see `createGrpcOpenShellTransport`, client.ts). So this
 * smoke verifies the ONE real RPC the client speaks today — `Health` — i.e. the gateway is reachable
 * and reports healthy. The full create => READY => exec => delete round-trip against a live gateway
 * lands when the lifecycle descriptors are wired (R7/R8 composition); until then asserting it here
 * would be a lie. The base URL is read from the env at runtime ONLY — never hard-coded, logged, or
 * committed (credentials never on disk).
 */
import { describe, expect, it } from "vitest";
import { createOpenShellClient } from "./client.js";

const baseUrl = process.env.OPENSHELL_E2E_BASE_URL;
const RUN = typeof baseUrl === "string" && baseUrl.length > 0;

// Default: skipped. Only when an operator points it at a real gateway does it connect.
const maybe = RUN ? describe : describe.skip;

maybe("OpenShell live gateway smoke (opt-in)", () => {
  it("Health reports the gateway is reachable", async () => {
    // `RUN` is true here by construction of `maybe`; narrow for the type checker.
    if (!RUN) throw new Error("unreachable: skipped unless OPENSHELL_E2E_BASE_URL is set");
    const transport = createOpenShellClient({ baseUrl, deadlineMs: 10_000 });
    const health = await transport.health();
    expect(health.ok).toBe(true);
  });
});
