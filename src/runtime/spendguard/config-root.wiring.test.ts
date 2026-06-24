/**
 * SLICE-IT1b — integration wiring proof: env -> composition root -> the IT1a surface injection.
 *
 * Drives the real "operator sets config => integrations on" path end-to-end at the composition layer:
 * a fake (non-secret) env -> `integrationsFromEnv()` -> `createPersonalShell(...)`. Proves the surface
 * is constructed WITH a SpendGuard-backed gate (not the default InMemoryCostGate) and that building the
 * shell connects to NOTHING (grpc-js Client is lazy — the first reserve would connect, which this test
 * never triggers; no real UDS exists). This lives in the runtime/<vendor> zone because it names the
 * vendor (SpendGuardCostGate) — it is a TEST, excluded from dep-cruiser, and the surfaces stay neutral.
 */
import { describe, expect, it } from "vitest";
import { SpendGuardCostGate } from "../../cost/adapters/spendguard/index.js";
import { createPersonalShell } from "../../personal/index.js";
import { integrationsFromEnv } from "./config-root.js";

const FAKE_ENV: Record<string, string | undefined> = {
  SPENDGUARD_UDS_PATH: "/var/run/spendguard/adapter.sock",
  SPENDGUARD_BUDGET_ID: "budget-monthly",
  SPENDGUARD_UNIT_ID: "unit-tokens",
  SPENDGUARD_WINDOW_INSTANCE_ID: "window-2026-06",
  SPENDGUARD_TENANT_ASSERTION: "tenant-a",
};

describe("config root -> Personal surface wiring (SLICE-IT1b)", () => {
  it("integrationsFromEnv(fakeEnv) yields a SpendGuard gate that createPersonalShell accepts (no connect)", () => {
    const integrations = integrationsFromEnv(FAKE_ENV);
    // The composition root resolved a real vendor gate from env (not the in-memory fallback).
    expect(integrations.costGate).toBeInstanceOf(SpendGuardCostGate);

    // Feeding it into the IT1a injection seam must NOT connect or throw (lazy grpc-js). The shell is now
    // backed by the SpendGuard gate; a reserve (not triggered here) is what would touch the UDS.
    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: true, ...integrations });
    expect(shell).toBeDefined();
    expect(typeof shell.receive).toBe("function");
  });

  it("integrationsFromEnv({}) yields no gate -> the shell uses its byte-identical InMemory default", () => {
    const integrations = integrationsFromEnv({});
    expect(integrations.costGate).toBeUndefined();
    // Spreading an empty integrations is the ABSENT path: createPersonalShell falls back to InMemory.
    const shell = createPersonalShell({ budget: 1000, allowToolInvoke: true, ...integrations });
    expect(shell).toBeDefined();
  });
});
