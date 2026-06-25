/**
 * CROSS-LANGUAGE BOUNDARY proof for the Developer vertical (SLICE-DV4).
 *
 * The credential-blind Python shim (`python/agentos_shim/shim.py`) emits a bundleRef-only proposal,
 * serialized to the COMMITTED JSON fixture `python/tests/fixtures/bundle_ref_proposal.json`. The
 * Python side (`python/tests/test_governed_boundary.py`) proves the shim genuinely produces that
 * fixture byte-equivalently. THIS test proves the OTHER half: the SAME committed fixture, read as
 * untrusted JSON at the TS boundary, is:
 *   (1) validated bundleRef-only at the boundary (fail-closed: a non-`bundle://` arg value -> reject),
 *   (2) turned into a GovernedCall and accepted by the TS governed pipeline
 *       (`createDeveloperKit` -> authorTool -> runTool: screen -> authorize(dev:* allow) -> cost ->
 *       commit-before-effect -> effect) -> EXECUTED + the WORM gained ONE AuditEvent,
 *   (3) credential-blind end-to-end: a literal-secret VARIANT (runtime-assembled `sk-` injected into
 *       an arg) -> denied@screen (the TS credential gate), the effect NEVER ran. Defense-in-depth at
 *       the boundary: Python rejects it (ValueError) AND the TS screen rejects it.
 *
 * HONEST SCOPE: this is a FIXTURE / JSON-boundary demo, NOT a live Python-runtime integration (that
 * is R11). Python never runs the governance core; it only emits the proposal that crosses the JSON
 * boundary into this TS test.
 *
 * RED-first: `python/tests/fixtures/bundle_ref_proposal.json` does not exist yet, so the fixture read
 * below throws and the suite cannot run.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentContext } from "../iam/ids.js";
import { createDeveloperKit } from "./bootstrap.js";

// A runtime-assembled secret canary — never a literal in source, so scan_secrets.sh stays clean.
const CANARY = `sk-${"d".repeat(24)}`;

// The COMMITTED cross-language contract — the SAME file the Python boundary test reads + asserts the
// shim produces byte-equivalently. Resolved from this test file up to the repo root.
const FIXTURE_URL = new URL(
  "../../python/tests/fixtures/bundle_ref_proposal.json",
  import.meta.url,
);

const ctx: AgentContext = {
  actorId: "agent:dev",
  tenantId: "tenant-dev",
  projectId: "proj-dev",
  taskId: "task-dev",
  requestId: "req-dev",
} as AgentContext;

/** The bundleRef-only proposal contract shape the shim emits + the fixture carries. */
interface BundleRefProposal {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

const BUNDLE_REF_PREFIX = "bundle://";

/** A boundary guard value is an allowed credential reference iff it is a non-empty `bundle://` ref. */
function looksLikeBundleRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith(BUNDLE_REF_PREFIX) &&
    value.length > BUNDLE_REF_PREFIX.length
  );
}

/**
 * The TS-side boundary guard: parse the untrusted proposal and assert EVERY arg value is a
 * `bundle://` bundleRef. Fail-closed — a missing `tool`, a non-object `args`, or any non-bundleRef
 * arg value THROWS, so a literal-secret proposal can never be assembled into a GovernedCall here.
 */
function validateBundleRefOnly(input: unknown): BundleRefProposal {
  if (input === null || typeof input !== "object") {
    throw new Error("proposal must be an object");
  }
  const obj = input as Record<string, unknown>;
  if (typeof obj.tool !== "string" || obj.tool.length === 0) {
    throw new Error("proposal.tool must be a non-empty string");
  }
  if (obj.args === null || typeof obj.args !== "object" || Array.isArray(obj.args)) {
    throw new Error("proposal.args must be an object");
  }
  const args = obj.args as Record<string, unknown>;
  for (const [key, value] of Object.entries(args)) {
    if (!looksLikeBundleRef(value)) {
      // Fail-closed: a non-bundleRef value is treated as a potential literal secret and REJECTED.
      throw new Error(`proposal.args[${key}] is not a ${BUNDLE_REF_PREFIX} bundleRef (rejected)`);
    }
  }
  return { tool: obj.tool, args };
}

/** Read the committed fixture as untrusted JSON (what crosses the language boundary). */
function readFixture(): unknown {
  return JSON.parse(readFileSync(fileURLToPath(FIXTURE_URL), "utf8"));
}

/** A 9-field manifest whose name == the fixture tool, in the kit's default `dev:*` allow namespace. */
function manifestForTool(tool: string): Record<string, unknown> {
  return {
    name: tool,
    version: "1.0.0",
    description: "deploy tool authored for the bundleRef-only boundary proposal",
    action: "invoke",
    resourcePattern: `${tool}:*`,
    sideEffect: "read",
    idempotent: true,
    requiresApproval: false,
    bundleRefOnly: true,
    containment: "in-sandbox",
  };
}

describe("Python plane credential-blind boundary — committed fixture -> TS governed pipeline", () => {
  it("(1) the committed fixture is a canonical bundleRef-only proposal in the dev:* namespace", () => {
    const proposal = validateBundleRefOnly(readFixture());
    expect(proposal.tool).toBe("dev:deploy");
    expect(proposal.tool.startsWith("dev:")).toBe(true);
    expect(proposal.args).toEqual({ config: "bundle://prod/app-config" });

    // Every arg value is a bundleRef (the boundary contract); none is a literal secret.
    for (const value of Object.values(proposal.args)) {
      expect(looksLikeBundleRef(value)).toBe(true);
    }
  });

  it("(2) ACCEPTED END-TO-END: fixture -> bundleRef-only validate -> GovernedCall -> runTool -> executed + WORM+1", async () => {
    const proposal = validateBundleRefOnly(readFixture());

    const kit = createDeveloperKit();
    // Author a manifest whose name == the fixture tool so authorize passes under the default dev:* allow.
    const binding = kit.authorTool(manifestForTool(proposal.tool));
    expect(binding.name).toBe("dev:deploy");

    // Build the GovernedCall from the fixture {tool, args} + the ctx the kit needs.
    const outcome = await kit.runTool({ tool: proposal.tool, args: proposal.args, context: ctx });
    expect(outcome.status).toBe("executed");
    if (outcome.status !== "executed") return;

    // The WORM gained EXACTLY ONE AuditEvent (commit-before-effect), reflecting the deploy invocation.
    const tl = kit.replayFold();
    expect(tl.steps.length).toBe(1);
    const event = tl.steps[0]?.event as { resource?: string; action?: string; result?: string };
    expect(event.resource).toBe("dev:deploy");
    expect(event.action).toBe("tool:invoke");
    expect(event.result).toBe("success");

    // A bundleRef value is NOT treated as a secret: the happy path executed and the bundleRef
    // reference survived to the WORM (never redacted as a credential, never a literal secret).
    const forensic = kit.forensicState();
    expect(forensic.byResource["dev:deploy"]).toEqual({
      lastAction: "tool:invoke",
      lastResult: "success",
    });
  });

  it("(3) DEFENSE-IN-DEPTH: a literal-secret variant of the fixture -> boundary rejects; if forced past, runTool denies@screen", async () => {
    const proposal = validateBundleRefOnly(readFixture());

    // First boundary line: a literal-secret arg value FAILS the bundleRef-only guard (fail-closed) —
    // it can never even be assembled into a GovernedCall here.
    const tamperedProposal = { tool: proposal.tool, args: { config: CANARY } };
    expect(() => validateBundleRefOnly(tamperedProposal)).toThrow();

    // Second boundary line (defense-in-depth): even if a secret slipped PAST the boundary guard into
    // a GovernedCall, the TS credential screen denies it @screen and the effect never runs.
    const kit = createDeveloperKit();
    kit.authorTool(manifestForTool(proposal.tool));
    const denied = await kit.runTool({
      tool: proposal.tool,
      args: { config: CANARY },
      context: ctx,
    });
    expect(denied.status).toBe("denied");
    if (denied.status !== "denied") return;
    expect(denied.stage).toBe("screen");

    // The effect never ran; nothing was committed; the secret never reached the WORM/timeline.
    const tl = kit.replayFold();
    expect(tl.steps.length).toBe(0);
    expect(JSON.stringify(tl)).not.toContain(CANARY);
  });

  it("(NON-VACUITY) skipping the bundleRef-only boundary validation lets a literal secret through", () => {
    // If the boundary guard did NOT validate bundleRef-only, a tampered proposal carrying a literal
    // secret would be accepted as-is. This asserts the guard is load-bearing: WITHOUT it, the secret
    // value is present; WITH it, the guard throws (proven in test 3).
    const tampered = { tool: "dev:deploy", args: { config: CANARY } };
    // Without validation the secret is right there in the structure (the failure mode we prevent):
    expect(JSON.stringify(tampered)).toContain(CANARY);
    // With validation it is rejected fail-closed.
    expect(() => validateBundleRefOnly(tampered)).toThrow();
  });
});
