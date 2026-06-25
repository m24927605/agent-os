/**
 * SLICE-IT1b — the CONFIG-DRIVEN composition root for SpendGuard (+ the AGT advisory injection point).
 *
 * This is the "operator sets config => integrations on" seam. IT1a made the three surfaces injectable
 * (`createPersonalShell`/`createDeveloperKit` take `costGate?`/`secondaries?`; `createEnterpriseFleet`
 * takes `costGateFor?`/`secondaries?`; ABSENT => byte-identical InMemoryCostGate fallback). This module
 * READS env and CONSTRUCTS those injection opts, so a real deployment turns SpendGuard on by setting
 * SPENDGUARD_* — no core rewrite.
 *
 * WHY THIS LIVES IN src/runtime/spendguard/ (NOT in src/personal|enterprise|developer): it IMPORTS the
 * SpendGuard vendor (SpendGuardCostGate + the gRPC decision transport). The `no-vendor-in-core`
 * dep-cruiser rule forbids the vendor-neutral surfaces from naming a vendor; the runtime/<vendor> zone
 * is the carve-out where vendor wiring lives. The surfaces consume only the vendor-neutral opts this
 * module returns (`{ costGate?: CostGate; secondaries? }`) — they never import this module.
 *
 * FAIL-CLOSED (AGENTS.md deny-by-default; the central safety property of this slice): a PARTIAL /
 * malformed SpendGuard config (UDS path set but a budget-topology field missing/empty) THROWS a clear
 * startup error. It NEVER silently falls back to InMemoryCostGate / no-governance. The danger being
 * defended is the worst SpendGuard failure mode: an operator believing SpendGuard is enforcing the
 * budget when it is not. Fail loud at startup, never quiet at runtime.
 *
 * CREDENTIAL-BLIND (verified): the config carries ONLY non-secret identifiers — a socket path, a
 * budget id, a unit id, a window-instance id, and a tenant assertion. None is a credential; the gate
 * the helper builds holds only an injected transport (the transport itself adds no secret — see
 * decision-transport.ts CREDENTIAL-BLIND). This module reads no secret-shaped env and logs nothing.
 *
 * HONEST BOUNDARY: this is config WIRING only. The REAL SpendGuard path (a live sidecar over the UDS)
 * is proven by the gated `pnpm run e2e:live-spendguard`, not here — grpc-js's Client is LAZY, so
 * constructing the gate connects to nothing (the first reserve does). `release()` is still unwired
 * (deny-by-default), and `budgetClaim` absent => a reserve fails CLOSED. The AGT engine is NOT bundled;
 * `secondaries` is a pass-through injection point for a user-supplied SecondaryPolicyAdapter (env alone
 * cannot carry a code object).
 */
import { SpendGuardCostGate } from "../../cost/adapters/spendguard/index.js";
import type { CostGate } from "../../cost/index.js";
import type { SecondaryPolicyAdapter } from "../../policy/index.js";
import { createAgtDecisionTransport, createAgtEndpointSecondary } from "../agt/index.js";
import { createDecisionLedgerTransport } from "./decision-transport.js";

/** Env keys read by this composition root. All are NON-SECRET identifiers (credential-blind). */
const ENV_UDS_PATH = "SPENDGUARD_UDS_PATH";
const ENV_BUDGET_ID = "SPENDGUARD_BUDGET_ID";
const ENV_UNIT_ID = "SPENDGUARD_UNIT_ID";
const ENV_WINDOW_INSTANCE_ID = "SPENDGUARD_WINDOW_INSTANCE_ID";
const ENV_TENANT_ASSERTION = "SPENDGUARD_TENANT_ASSERTION";

/** SLICE-R9b-2b — AGT advisory env keys (NON-SECRET: a socket path + a scope word + a timeout number). */
const ENV_AGT_UDS_PATH = "AGT_UDS_PATH";
const ENV_AGT_SCOPE = "AGT_SCOPE";
const ENV_AGT_TIMEOUT_MS = "AGT_TIMEOUT_MS";

/** The valid `AGT_SCOPE` values; anything else is a misconfiguration (fail-closed). */
const VALID_AGT_SCOPES: ReadonlySet<string> = new Set(["effectful", "all"]);

/** The vendor-neutral integration opts this root feeds to a surface's `create*` (IT1a injection seam). */
export interface Integrations {
  /** Present iff SpendGuard is configured (SPENDGUARD_UDS_PATH set + valid topology); else absent. */
  readonly costGate?: CostGate;
  /** Pass-through user-supplied advisory adapters (the AGT injection point); absent => surface uses []. */
  readonly secondaries?: readonly SecondaryPolicyAdapter[];
  /**
   * SLICE-R9b-2b — the AGT consult scope the authorize closures use to decide which tools get a
   * governance projection (`buildProjectionForCall`). Present iff AGT is configured (AGT_UDS_PATH set);
   * defaults to "effectful". Absent (AGT unconfigured) => the closure builds NO projection => no AGT
   * round-trip => byte-identical.
   */
  readonly agtScope?: "effectful" | "all";
}

/** Optional, code-carried injections that env alone cannot express (a SecondaryPolicyAdapter is code). */
export interface IntegrationsExtra {
  /**
   * User-supplied advisory `SecondaryPolicyAdapter`s (the AGT injection point). The repo bundles NO AGT
   * engine — a deployment that wants AGT advisory supplies its own adapter here. Threaded through
   * VERBATIM to the surface (which folds them via `combineDecisions`: advisory, any-deny-wins, PDP
   * sovereign). Env cannot carry a code object, so this is the honest seam for it.
   */
  readonly secondaries?: readonly SecondaryPolicyAdapter[];
}

/** Read a trimmed env value; treat whitespace-only as ABSENT (an empty/blank id is never valid config). */
function read(env: Record<string, string | undefined>, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The validated, NON-SECRET SpendGuard budget topology (the route->budget mapping lives in the adapter,
 * never in the vendor-neutral port). `udsPath` + `budgetClaim` + the optional `tenantIdAssertion` are
 * exactly the credential-blind shape `createDecisionLedgerTransport` consumes.
 */
interface SpendGuardConfig {
  readonly udsPath: string;
  readonly budgetClaim: {
    readonly budgetId: string;
    readonly unitId: string;
    readonly windowInstanceId: string;
  };
  readonly tenantIdAssertion?: string;
}

/**
 * Parse + VALIDATE SpendGuard config from env. Returns:
 *   - `undefined` when SPENDGUARD_UDS_PATH is ABSENT (SpendGuard is simply not configured — the surface
 *     falls back to InMemoryCostGate; this is the legitimate "off" state, not an error).
 *   - a fully-validated {@link SpendGuardConfig} when UDS + the full budget topology are present.
 * THROWS (fail-closed) when UDS is present but ANY required budget-topology field is missing/empty —
 * never returns a partial config and never lets the caller silently fall back to no-governance.
 */
function parseSpendGuardConfig(
  env: Record<string, string | undefined>,
): SpendGuardConfig | undefined {
  // Distinguish "key ABSENT" (legitimate off) from "key PRESENT but blank" (misconfiguration). If the
  // operator never set SPENDGUARD_UDS_PATH at all, SpendGuard is simply not configured. But if they
  // DEFINED it and left it blank/whitespace, they intended SpendGuard and mis-set it — fail CLOSED
  // rather than silently revert to a no-governance in-memory gate.
  if (!(ENV_UDS_PATH in env) || env[ENV_UDS_PATH] === undefined) return undefined; // not configured.
  const udsPath = read(env, ENV_UDS_PATH);
  if (udsPath === undefined) {
    // Fail CLOSED: a blank UDS path is a mis-set key, not "off". One template literal (no concat) so
    // the lint `useTemplate` rule stays happy; only the non-secret KEY name is interpolated.
    throw new Error(
      `${ENV_UDS_PATH} is set but empty/blank — refusing to build a SpendGuard gate from a bogus socket path (fail-closed, deny-by-default). Set a real UDS path or unset the key to use the in-memory gate.`,
    );
  }

  // UDS is set => the operator INTENDS SpendGuard. Any missing topology field is a misconfiguration we
  // MUST surface loudly (deny-by-default), never paper over by reverting to an in-memory budget gate.
  const budgetId = read(env, ENV_BUDGET_ID);
  const unitId = read(env, ENV_UNIT_ID);
  const windowInstanceId = read(env, ENV_WINDOW_INSTANCE_ID);
  const missing = [
    budgetId === undefined ? ENV_BUDGET_ID : undefined,
    unitId === undefined ? ENV_UNIT_ID : undefined,
    windowInstanceId === undefined ? ENV_WINDOW_INSTANCE_ID : undefined,
  ].filter((k): k is string => k !== undefined);
  if (budgetId === undefined || unitId === undefined || windowInstanceId === undefined) {
    // Fail CLOSED: clear startup error naming the missing keys. The `||` guard (vs `missing.length`)
    // also NARROWS the three bindings to `string` below — the type system tracks that the throw escapes.
    // No secret is interpolated: only the KEY names + the joined missing-KEY list, never a value. One
    // template literal (no concat) to satisfy lint `useTemplate`.
    throw new Error(
      `${ENV_UDS_PATH} is set, so SpendGuard is enabled, but required budget-topology config is missing or empty: ${missing.join(", ")}. Refusing to fall back to a no-governance in-memory gate (fail-closed, deny-by-default). Set the missing key(s) or unset ${ENV_UDS_PATH} to use the in-memory budget gate.`,
    );
  }

  const tenantIdAssertion = read(env, ENV_TENANT_ASSERTION);
  return {
    udsPath,
    budgetClaim: { budgetId, unitId, windowInstanceId },
    ...(tenantIdAssertion !== undefined ? { tenantIdAssertion } : {}),
  };
}

/**
 * Build a SpendGuardCostGate from validated config, asserting the given tenant. grpc-js's Client is
 * LAZY — this constructs the channel object but does NOT connect (the connection happens on the first
 * reserve). So the gate is constructible + unit-testable WITHOUT a real UDS.
 */
function buildGate(
  config: SpendGuardConfig,
  tenantIdAssertion: string | undefined,
): SpendGuardCostGate {
  return new SpendGuardCostGate(
    createDecisionLedgerTransport({
      udsPath: config.udsPath,
      budgetClaim: config.budgetClaim,
      ...(tenantIdAssertion !== undefined ? { tenantIdAssertion } : {}),
    }),
  );
}

/**
 * SLICE-R9b-2b — the validated, NON-SECRET AGT advisory config. `udsPath` is the sidecar UDS; `scope`
 * is the consult scope (consumed by the closures' `buildProjectionForCall`, not the transport); `deadlineMs`
 * is the optional per-call timeout. The endpoint secondary built here is the autonomous path's AGT advisor.
 */
interface AgtConfig {
  readonly udsPath: string;
  readonly scope: "effectful" | "all";
  readonly deadlineMs?: number;
}

/**
 * Parse + VALIDATE the AGT advisory config from env (mirrors {@link parseSpendGuardConfig}):
 *   - `undefined` when AGT_UDS_PATH is ABSENT (AGT advisory simply not configured — the legitimate "off"
 *     state, NOT an error; the surface gets no AGT secondary => byte-identical).
 *   - a fully-validated {@link AgtConfig} when AGT_UDS_PATH is present (+ a valid AGT_SCOPE / AGT_TIMEOUT_MS).
 * THROWS (fail-closed) when AGT_UDS_PATH is present-but-blank, AGT_SCOPE is set to an invalid value, or
 * AGT_TIMEOUT_MS is set to a non-numeric / non-positive value — never silently drops the AGT advisory.
 */
function parseAgtConfig(env: Record<string, string | undefined>): AgtConfig | undefined {
  // ABSENT key => not configured. Present-but-blank => a mis-set key => fail CLOSED (mirror SpendGuard).
  if (!(ENV_AGT_UDS_PATH in env) || env[ENV_AGT_UDS_PATH] === undefined) return undefined;
  const udsPath = read(env, ENV_AGT_UDS_PATH);
  if (udsPath === undefined) {
    throw new Error(
      `${ENV_AGT_UDS_PATH} is set but empty/blank — refusing to build an AGT advisory from a bogus socket path (fail-closed, deny-by-default). Set a real UDS path or unset the key to disable the AGT advisory.`,
    );
  }

  // AGT_SCOPE: default "effectful"; an explicit-but-invalid value is a misconfiguration (fail-closed).
  const rawScope = read(env, ENV_AGT_SCOPE);
  if (rawScope !== undefined && !VALID_AGT_SCOPES.has(rawScope)) {
    throw new Error(
      `${ENV_AGT_SCOPE} is set to an invalid value "${rawScope}" — expected "effectful" or "all" (fail-closed, deny-by-default). Set a valid scope or unset the key to use the default "effectful".`,
    );
  }
  const scope: "effectful" | "all" = rawScope === "all" ? "all" : "effectful";

  // AGT_TIMEOUT_MS: optional; an explicit-but-non-numeric / non-positive value is a misconfiguration.
  const rawTimeout = read(env, ENV_AGT_TIMEOUT_MS);
  let deadlineMs: number | undefined;
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(
        `${ENV_AGT_TIMEOUT_MS} is set to an invalid value "${rawTimeout}" — expected a positive number of milliseconds (fail-closed, deny-by-default). Set a valid timeout or unset the key to use the default.`,
      );
    }
    deadlineMs = n;
  }

  return { udsPath, scope, ...(deadlineMs !== undefined ? { deadlineMs } : {}) };
}

/**
 * Build the autonomous-path AGT advisory `SecondaryPolicyAdapter` from validated config: a lazy grpc-js
 * UDS transport (constructing it connects to NOTHING — the first evaluate would) wrapped by the
 * endpoint secondary (R9b-2a). The secondary's scope-skip means a request with NO projection abstains.
 */
function buildAgtSecondary(config: AgtConfig): SecondaryPolicyAdapter {
  const transport = createAgtDecisionTransport({
    udsPath: config.udsPath,
    ...(config.deadlineMs !== undefined ? { deadlineMs: config.deadlineMs } : {}),
  });
  return createAgtEndpointSecondary(transport);
}

/**
 * Build the vendor-neutral integration opts for the SINGLE-TENANT surfaces (Personal / Developer) from
 * env. Feed the result straight into `createPersonalShell(integrationsFromEnv())` /
 * `createDeveloperKit(integrationsFromEnv())`.
 *
 *   - `SPENDGUARD_UDS_PATH` set (+ a valid budget topology) => `costGate` = a SpendGuardCostGate backed
 *     by the gRPC decision transport (asserting `SPENDGUARD_TENANT_ASSERTION` if set). Constructing it
 *     does NOT connect (lazy).
 *   - `SPENDGUARD_UDS_PATH` unset => no `costGate` (the surface falls back to `new InMemoryCostGate`).
 *   - partial/malformed SpendGuard config => THROW (fail-closed; see {@link parseSpendGuardConfig}).
 *   - `extra.secondaries` => threaded through VERBATIM (the AGT injection point; env can't carry code).
 *
 * Pure aside from reading `env` (defaults to `process.env`); reads only non-secret keys; logs nothing.
 */
export function integrationsFromEnv(
  env: Record<string, string | undefined> = process.env,
  extra?: IntegrationsExtra,
): Integrations {
  const config = parseSpendGuardConfig(env); // throws on partial/malformed (fail-closed)
  const costGate = config === undefined ? undefined : buildGate(config, config.tenantIdAssertion);

  // SLICE-R9b-2b — register the AGT advisory secondary FROM ENV (AGT_UDS_PATH). parseAgtConfig throws
  // fail-closed on a partial/invalid AGT config (blank UDS / invalid scope / bogus timeout). When AGT is
  // configured, the AGT secondary is APPENDED after any pass-through advisors (a NEW merged array). When
  // AGT is UNCONFIGURED, `secondaries` is the EXACT `extra.secondaries` reference returned VERBATIM (no
  // new allocation) — so the IT1b pass-through invariant (`integrations.secondaries === extra.secondaries`)
  // is byte-identical.
  const agtConfig = parseAgtConfig(env); // throws on partial/invalid (fail-closed)
  const agtSecondary = agtConfig === undefined ? undefined : buildAgtSecondary(agtConfig);
  const secondaries: readonly SecondaryPolicyAdapter[] | undefined =
    agtSecondary === undefined
      ? extra?.secondaries // VERBATIM pass-through (or undefined) — byte-identical when AGT is off.
      : [...(extra?.secondaries ?? []), agtSecondary]; // merge: pass-through advisors + the AGT advisor.

  return {
    ...(costGate !== undefined ? { costGate } : {}),
    ...(secondaries !== undefined ? { secondaries } : {}),
    // The scope is surfaced ONLY when AGT is configured, so an unconfigured deployment carries no scope
    // and the closures build no projection (byte-identical).
    ...(agtConfig !== undefined ? { agtScope: agtConfig.scope } : {}),
  };
}

/**
 * Build the ENTERPRISE per-tenant CostGate FACTORY from env. Feed the result into
 * `createEnterpriseFleet({ costGateFor: costGateForFromEnv(env), secondaries })`.
 *
 *   - `SPENDGUARD_UDS_PATH` set (+ a valid budget topology) => a factory `(tenantId) =>
 *     SpendGuardCostGate`. The tenantId becomes the per-call `tenantIdAssertion`, so each tenant gets
 *     its OWN gate scoped to its OWN tenant assertion — A's SpendGuard gate is NEVER B's (per-tenant
 *     isolation preserved; the fleet keys one independent gate per tenant). Each call builds a FRESH
 *     gate; nothing is shared/memoized across tenants.
 *   - `SPENDGUARD_UDS_PATH` unset => `undefined` (the fleet falls back to per-tenant InMemoryCostGate).
 *   - partial/malformed SpendGuard config => THROW (fail-closed; validated once, eagerly, at startup —
 *     not deferred to first-tenant-provision).
 *
 * Note: `SPENDGUARD_TENANT_ASSERTION` is IGNORED here — the per-tenant assertion is the fleet's
 * tenantId, which is the correct isolation key for a multi-tenant fleet.
 */
export function costGateForFromEnv(
  env: Record<string, string | undefined> = process.env,
): ((tenantId: string) => CostGate) | undefined {
  const config = parseSpendGuardConfig(env); // throws NOW on partial/malformed (fail-closed at startup)
  if (config === undefined) return undefined;
  // Per-tenant: the tenantId IS the assertion, so each tenant's gate is scoped to its own tenant and
  // a fresh instance is built per call (independent gates => cross-tenant isolation).
  return (tenantId: string): CostGate => buildGate(config, tenantId);
}
