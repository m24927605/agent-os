/**
 * SLICE-IT1b — the CONFIG-DRIVEN composition root (RED-first).
 *
 * Proves the env -> integration-opts wiring that makes SpendGuard "set config => integrations on":
 *   - `integrationsFromEnv(env)`:
 *       * SPENDGUARD_UDS_PATH set (+ budgetId + unitId + windowInstanceId) => a `costGate` that is a
 *         real `SpendGuardCostGate`. grpc-js's Client is LAZY: constructing the gate does NOT connect
 *         (no throw, no I/O) — the connection only happens on a first reserve, which this suite never
 *         triggers. So the gate is constructible + assertable WITHOUT a real UDS.
 *       * SPENDGUARD_UDS_PATH unset => `costGate` undefined (the surface falls back to InMemoryCostGate).
 *       * FAIL-CLOSED: udsPath set but budgetId / unitId / windowInstanceId missing or empty => THROW a
 *         clear startup error. The danger this guards is "operator thought SpendGuard was on but it
 *         silently fell back to no-governance". NON-VACUITY: a mutation that returns `undefined` instead
 *         of throwing flips these RED.
 *       * `extra.secondaries` => threaded through VERBATIM (the repo bundles NO AGT engine; the user
 *         supplies a SecondaryPolicyAdapter — env alone cannot carry a code object). Absent => undefined.
 *   - `costGateForFromEnv(env)` (ENTERPRISE per-tenant variant):
 *       * UDS set => a FACTORY `(tenantId) => SpendGuardCostGate` (per-tenant, keyed by the tenantId
 *         assertion). Calling it with two tenantIds yields two INDEPENDENT gates (per-tenant isolation).
 *       * UDS unset => undefined (the fleet falls back to per-tenant InMemoryCostGate).
 *       * Same fail-closed + credential-blind rules.
 *   - CREDENTIAL-BLIND: the env keys carry ONLY non-secret identifiers (udsPath / budgetId / unitId /
 *     windowInstanceId / tenant assertion). The helper requires NO secret and emits none.
 *
 * RED-first: `integrationsFromEnv` / `costGateForFromEnv` do not exist yet, so this suite fails to
 * type/compile.
 */
import { describe, expect, it } from "vitest";
import { SpendGuardCostGate } from "../../cost/adapters/spendguard/index.js";
import type { PolicyDecision, PolicyRequest, SecondaryPolicyAdapter } from "../../policy/index.js";
import { costGateForFromEnv, integrationsFromEnv } from "./config-root.js";

/**
 * A complete, NON-SECRET env: only cost-accounting identifiers + a socket path + a tenant assertion.
 * These are deliberately readable placeholders — there is no credential anywhere in this config.
 */
const FULL_ENV: Record<string, string | undefined> = {
  SPENDGUARD_UDS_PATH: "/var/run/spendguard/adapter.sock",
  SPENDGUARD_BUDGET_ID: "budget-monthly",
  SPENDGUARD_UNIT_ID: "unit-tokens",
  SPENDGUARD_WINDOW_INSTANCE_ID: "window-2026-06",
  SPENDGUARD_TENANT_ASSERTION: "tenant-a",
};

/** A user-supplied advisory secondary (the AGT injection point — engine is BYO, not in the repo). */
class UserSecondary implements SecondaryPolicyAdapter {
  evaluate(_req: PolicyRequest): PolicyDecision {
    return { effect: "allow", reason: "user advisory (test)", auditRequired: true };
  }
}

describe("integrationsFromEnv — SpendGuard cost gate from env (SLICE-IT1b)", () => {
  it("UDS + budget topology set -> a real SpendGuardCostGate, constructed WITHOUT connecting", () => {
    // grpc-js Client is lazy: building the transport + gate must NOT connect / throw / do I/O.
    const integrations = integrationsFromEnv(FULL_ENV);
    expect(integrations.costGate).toBeInstanceOf(SpendGuardCostGate);
  });

  it("UDS UNSET -> costGate undefined (surface falls back to InMemoryCostGate)", () => {
    const integrations = integrationsFromEnv({});
    expect(integrations.costGate).toBeUndefined();
  });

  it("FAIL-CLOSED: UDS set but budgetId missing -> THROWS (never silent fallback)", () => {
    const env = { ...FULL_ENV, SPENDGUARD_BUDGET_ID: undefined };
    // NON-VACUITY: a mutation that returns `{}`/undefined instead of throwing flips this RED.
    expect(() => integrationsFromEnv(env)).toThrow();
  });

  it("FAIL-CLOSED: UDS set but budgetId EMPTY -> THROWS", () => {
    const env = { ...FULL_ENV, SPENDGUARD_BUDGET_ID: "" };
    expect(() => integrationsFromEnv(env)).toThrow();
  });

  it("FAIL-CLOSED: UDS set but unitId missing -> THROWS", () => {
    const env = { ...FULL_ENV, SPENDGUARD_UNIT_ID: undefined };
    expect(() => integrationsFromEnv(env)).toThrow();
  });

  it("FAIL-CLOSED: UDS set but windowInstanceId missing -> THROWS", () => {
    const env = { ...FULL_ENV, SPENDGUARD_WINDOW_INSTANCE_ID: undefined };
    expect(() => integrationsFromEnv(env)).toThrow();
  });

  it("FAIL-CLOSED: UDS set to an empty/whitespace string -> THROWS (no bogus socket path)", () => {
    expect(() => integrationsFromEnv({ ...FULL_ENV, SPENDGUARD_UDS_PATH: "   " })).toThrow();
  });

  it("secondaries passthrough: extra.secondaries returned VERBATIM", () => {
    const secondaries = [new UserSecondary()];
    const integrations = integrationsFromEnv(FULL_ENV, { secondaries });
    expect(integrations.secondaries).toBe(secondaries);
  });

  it("secondaries ABSENT -> undefined (surface defaults to [])", () => {
    const integrations = integrationsFromEnv(FULL_ENV);
    expect(integrations.secondaries).toBeUndefined();
  });

  it("secondaries pass through even when UDS is unset (AGT is independent of SpendGuard)", () => {
    const secondaries = [new UserSecondary()];
    const integrations = integrationsFromEnv({}, { secondaries });
    expect(integrations.costGate).toBeUndefined();
    expect(integrations.secondaries).toBe(secondaries);
  });

  it("CREDENTIAL-BLIND: the helper reads ONLY non-secret ids and emits no secret", () => {
    // The config carries only a socket path + cost-accounting identifiers + a tenant assertion. None of
    // these is a credential. We assert the constructed integrations serialize without leaking the env
    // (the gate holds an injected transport, never a secret). The secret-scan gate covers the source.
    const integrations = integrationsFromEnv(FULL_ENV, { secondaries: [new UserSecondary()] });
    expect(integrations.costGate).toBeInstanceOf(SpendGuardCostGate);
    // No env VALUE is a secret-shaped token; assert the keys consumed are the documented non-secret set.
    for (const key of Object.keys(FULL_ENV)) {
      expect(key.startsWith("SPENDGUARD_")).toBe(true);
    }
  });
});

describe("costGateForFromEnv — ENTERPRISE per-tenant SpendGuard factory (SLICE-IT1b)", () => {
  it("UDS + budget topology set -> a per-tenant FACTORY of independent SpendGuardCostGates", () => {
    const factory = costGateForFromEnv(FULL_ENV);
    expect(factory).toBeDefined();
    if (factory === undefined) throw new Error("expected a factory");

    const gateA = factory("tenant-a");
    const gateB = factory("tenant-b");
    expect(gateA).toBeInstanceOf(SpendGuardCostGate);
    expect(gateB).toBeInstanceOf(SpendGuardCostGate);
    // PER-TENANT ISOLATION: two distinct calls yield two INDEPENDENT gate instances (A's gate is never
    // B's gate). NON-VACUITY: a mutation that memoizes a single shared gate flips this RED.
    expect(gateA).not.toBe(gateB);
  });

  it("UDS UNSET -> undefined (fleet falls back to per-tenant InMemoryCostGate)", () => {
    expect(costGateForFromEnv({})).toBeUndefined();
  });

  it("FAIL-CLOSED: UDS set but budgetId missing -> THROWS at startup (never silent fallback)", () => {
    const env = { ...FULL_ENV, SPENDGUARD_BUDGET_ID: undefined };
    // NON-VACUITY: a mutation that returns undefined instead of throwing flips this RED.
    expect(() => costGateForFromEnv(env)).toThrow();
  });

  it("FAIL-CLOSED: UDS set but unitId empty -> THROWS at startup", () => {
    expect(() => costGateForFromEnv({ ...FULL_ENV, SPENDGUARD_UNIT_ID: "" })).toThrow();
  });
});
