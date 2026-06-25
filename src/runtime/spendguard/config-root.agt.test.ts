/**
 * SLICE-R9b-2b — `integrationsFromEnv` registers the AGT advisory secondary from env (RED-first).
 *
 * The "operator sets AGT_UDS_PATH => the AGT advisory is on" seam, mirroring the SpendGuard config path.
 * When `AGT_UDS_PATH` is set, `integrationsFromEnv` builds `createAgtDecisionTransport({udsPath,...})` +
 * `createAgtEndpointSecondary(transport)` and MERGES it into `secondaries` (alongside any pass-through
 * `extra.secondaries`). grpc-js's Client is LAZY — constructing the transport connects to NOTHING (the
 * first evaluate would), so this is provable WITHOUT a real Python AGT sidecar.
 *
 * FAIL-CLOSED (mirrors the SpendGuard partial-config guard): an INVALID `AGT_SCOPE` (not effectful|all)
 * or a non-numeric `AGT_TIMEOUT_MS` THROWS a clear startup error — never silently drops the AGT advisory.
 *
 * BYTE-IDENTICAL: `AGT_UDS_PATH` absent => no AGT secondary added => the returned `secondaries` is
 * exactly the pass-through `extra.secondaries` (or absent) — today's behaviour unchanged.
 *
 * NON-VACUITY: silently accepting an invalid AGT_SCOPE / AGT_TIMEOUT_MS (no throw) flips the fail-closed
 * tests RED.
 */
import { describe, expect, it } from "vitest";
import type { PolicyDecision, PolicyRequest, SecondaryPolicyAdapter } from "../../policy/index.js";
import { integrationsFromEnv } from "./config-root.js";

/** A trivial pass-through secondary so the merge-with-extra case is observable. */
class PassThroughSecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "allow", reason: "pass", auditRequired: true };
  }
}

describe("integrationsFromEnv — AGT registration from AGT_UDS_PATH", () => {
  it("AGT_UDS_PATH set => secondaries includes an AGT secondary (lazy; no connect)", () => {
    const integ = integrationsFromEnv({ AGT_UDS_PATH: "/var/run/agt/decision.sock" });
    expect(integ.secondaries).toBeDefined();
    expect(integ.secondaries?.length).toBe(1);
    // It is a SecondaryPolicyAdapter (has an `evaluate` method).
    expect(typeof integ.secondaries?.[0]?.evaluate).toBe("function");
  });

  it("AGT_UDS_PATH set + extra.secondaries => MERGED (pass-through kept, AGT appended)", () => {
    const integ = integrationsFromEnv(
      { AGT_UDS_PATH: "/var/run/agt/decision.sock" },
      { secondaries: [new PassThroughSecondary()] },
    );
    expect(integ.secondaries?.length).toBe(2);
  });

  it("AGT_UDS_PATH set with explicit AGT_SCOPE=all + numeric AGT_TIMEOUT_MS => builds (no throw)", () => {
    const integ = integrationsFromEnv({
      AGT_UDS_PATH: "/var/run/agt/decision.sock",
      AGT_SCOPE: "all",
      AGT_TIMEOUT_MS: "500",
    });
    expect(integ.secondaries?.length).toBe(1);
  });

  it("AGT_UDS_PATH absent => no AGT secondary (byte-identical: secondaries is the pass-through only)", () => {
    const none = integrationsFromEnv({});
    expect(none.secondaries).toBeUndefined();

    const passthrough = integrationsFromEnv({}, { secondaries: [new PassThroughSecondary()] });
    expect(passthrough.secondaries?.length).toBe(1);
  });
});

describe("integrationsFromEnv — AGT fail-closed on partial/invalid config", () => {
  it("AGT_UDS_PATH set but BLANK => throws (fail-closed, mirrors SpendGuard blank-UDS guard)", () => {
    expect(() => integrationsFromEnv({ AGT_UDS_PATH: "   " })).toThrow();
  });

  it("invalid AGT_SCOPE (not effectful|all) => throws (fail-closed)", () => {
    // NON-VACUITY: silently defaulting an invalid scope (no throw) flips this RED.
    expect(() =>
      integrationsFromEnv({ AGT_UDS_PATH: "/var/run/agt/decision.sock", AGT_SCOPE: "everything" }),
    ).toThrow();
  });

  it("non-numeric AGT_TIMEOUT_MS => throws (fail-closed)", () => {
    // NON-VACUITY: silently ignoring a bogus timeout (no throw) flips this RED.
    expect(() =>
      integrationsFromEnv({ AGT_UDS_PATH: "/var/run/agt/decision.sock", AGT_TIMEOUT_MS: "soon" }),
    ).toThrow();
  });
});
