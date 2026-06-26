/**
 * SLICE-CAP7 (RED-first) — the external-effect boundary ledger.
 *
 * commit-before-effect appends an INTENT event BEFORE the effect ("about to run"). But for a
 * seal-PUNCHING external effect (containment network-egress / host-fs-write), "intent recorded"
 * is NOT "the irreversible external fact happened". CAP7 closes that gap: AFTER the effect runs
 * (an `executed` outcome), IF the PDP decision flagged the call `external`, the pipeline appends a
 * DISTINCT boundary WORM event (`action: "effect.boundary-crossed"`) — a stronger, post-effect
 * record than the intent.
 *
 * This is AUDIT-ONLY (a forward WORM record), NOT a second deny authority: the PDP stays the SOLE
 * deny. The boundary append NEVER changes allow/deny, and a boundary-append REJECT does NOT un-run
 * the (irreversible) effect — the outcome stays `executed` and surfaces a boundary-append-failed
 * marker (mirroring the settlement-failure surfacing).
 *
 * INVARIANTS pinned here:
 *  - boundary ONLY for external + executed: external:false/unset, or denied/aborted (effect didn't
 *    run) => ZERO boundary events. NEVER boundary-without-effect.
 *  - intent + boundary pair: an external executed call => the appender receives EXACTLY 2 events
 *    (intent first, boundary after the effect).
 *  - boundary-append failure: the SECOND append (the boundary) rejecting => outcome stays executed +
 *    surfaced boundary marker; the effect result is unchanged (NEVER faked as "didn't run").
 *  - credential-blind: the boundary event carries ONLY neutral fields + the (already-redacted)
 *    projection — NEVER raw args/env/stdin.
 *
 * NON-VACUITY (asserted by the test design; the source twin is exercised+reverted in the RED→GREEN
 * drive): a mutation that appends the boundary even when external !== true flips the in-sandbox
 * "only 1 event" test RED; a mutation that appends the boundary on a denied external call flips the
 * denied "0 boundary" test RED.
 */
import { describe, expect, it } from "vitest";
import type { CommitAppender } from "../commitgate/index.js";
import type { CostGate, ReleaseResult, ReserveResult } from "../cost/index.js";
import { parseAgentContext } from "../iam/ids.js";
import {
  type ApprovalOutcome,
  type AuthorizeDecision,
  type GovernedCall,
  type GovernedToolCallDeps,
  runGovernedToolCall,
} from "./pipeline.js";

const ctx = parseAgentContext({
  actorId: "agent:claude",
  tenantId: "tenant-a",
  projectId: "proj-1",
  taskId: "task-1",
  requestId: "req-1",
});

function call(): GovernedCall {
  return { tool: "net.fetch", context: ctx };
}

/**
 * A RECORDING appender: captures EVERY appended event (intent + boundary) so a test can count them
 * and inspect each payload. The commit-before-effect intent is appended first; the boundary (if any)
 * second. `failOn` lets a test make the Nth append reject (the boundary is the 2nd).
 */
function recordingAppender(failOn?: number): {
  appender: CommitAppender<unknown, { sequence: number }>;
  events: unknown[];
} {
  const events: unknown[] = [];
  let seq = 0;
  return {
    events,
    appender: {
      append: async (event) => {
        seq += 1;
        if (failOn !== undefined && seq === failOn) {
          throw new Error("boundary append rejected (kernel unavailable)");
        }
        events.push(event);
        return { sequence: seq };
      },
    },
  };
}

const okReserve: ReserveResult = {
  status: "ok",
  reservationId: "rsv-1",
  event: { phase: "reserve", result: "ok" },
};
const okRelease: ReleaseResult = { status: "released", event: { phase: "release", result: "ok" } };

/** A CostGate whose reserve/commit/release all succeed (so cost is never the variable under test). */
const okCost: CostGate = {
  reserve: async () => okReserve,
  commit: async () => ({
    status: "committed",
    overrun: false,
    event: { phase: "commit", result: "ok" },
  }),
  release: async () => okRelease,
};

function depsWith(opts: {
  decision: AuthorizeDecision;
  appender: CommitAppender<unknown, { sequence: number }>;
  approve?: (toolCall: GovernedCall) => ApprovalOutcome;
  effect?: GovernedToolCallDeps<GovernedCall, { sequence: number }>["effect"];
}): GovernedToolCallDeps<GovernedCall, { sequence: number }> {
  return {
    screen: () => ({ ok: true }),
    authorize: () => opts.decision,
    ...(opts.approve !== undefined ? { approve: opts.approve } : {}),
    cost: okCost,
    estimateTokens: () => 10,
    appender: opts.appender,
    effect: opts.effect ?? (async () => ({ ok: true, detail: "effect ran", tokensUsed: 7 })),
  };
}

/** Pull the `action` field off a recorded event (events are structural objects). */
function actionOf(event: unknown): unknown {
  return (event as { action?: unknown }).action;
}

describe("CAP7 — external + executed => intent + a DISTINCT boundary event (post-effect)", () => {
  it("external:true + executed => the appender receives EXACTLY 2 events (intent THEN boundary)", async () => {
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: true }, appender }),
      call(),
    );

    expect(out.status).toBe("executed");
    // EXACTLY two appends: the commit-before-effect INTENT, then the boundary.
    expect(events.length).toBe(2);
    // The intent (commit-before-effect) is NOT the boundary action; the second IS.
    expect(actionOf(events[0])).not.toBe("effect.boundary-crossed");
    expect(actionOf(events[1])).toBe("effect.boundary-crossed");
  });

  it("the boundary event is appended AFTER the effect ran (intent -> effect -> boundary order)", async () => {
    const order: string[] = [];
    const events: unknown[] = [];
    let seq = 0;
    const appender: CommitAppender<unknown, { sequence: number }> = {
      append: async (event) => {
        seq += 1;
        order.push(
          (event as { action?: unknown }).action === "effect.boundary-crossed"
            ? "boundary"
            : "intent",
        );
        events.push(event);
        return { sequence: seq };
      },
    };
    await runGovernedToolCall(
      depsWith({
        decision: { effect: "allow", reason: "ok", external: true },
        appender,
        effect: async () => {
          order.push("effect");
          return { ok: true, detail: "ran", tokensUsed: 1 };
        },
      }),
      call(),
    );
    expect(order).toEqual(["intent", "effect", "boundary"]);
  });
});

describe("CAP7 — in-sandbox (external !== true) => NO boundary (only the intent)", () => {
  it("external:false => ONLY 1 event (the intent); NO boundary event", async () => {
    // NON-VACUITY: a mutation that appends the boundary even when external !== true flips this RED.
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: false }, appender }),
      call(),
    );
    expect(out.status).toBe("executed");
    expect(events.length).toBe(1);
    expect(actionOf(events[0])).not.toBe("effect.boundary-crossed");
  });

  it("external UNSET (byte-identical pre-CAP7) => ONLY 1 event (the intent); NO boundary", async () => {
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok" }, appender }),
      call(),
    );
    expect(out.status).toBe("executed");
    expect(events.length).toBe(1);
    expect(events.every((e) => actionOf(e) !== "effect.boundary-crossed")).toBe(true);
  });
});

describe("CAP7 — NEVER boundary-without-effect (denied/aborted external calls)", () => {
  it("authorize DENY (external irrelevant) => 0 events, 0 boundary (effect never ran)", async () => {
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "deny", reason: "nope", external: true }, appender }),
      call(),
    );
    expect(out.status).toBe("denied");
    // The intent is never appended on a policy deny, so neither is the boundary.
    expect(events.length).toBe(0);
  });

  it("approval DENY on an external allow => intent NOT appended, 0 boundary (effect never ran)", async () => {
    // NON-VACUITY: a mutation that appends the boundary on a denied external call flips this RED.
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({
        decision: { effect: "allow", reason: "ok", external: true, requiresApproval: true },
        appender,
        approve: () => ({ status: "denied", reason: "maker-checker said no" }),
      }),
      call(),
    );
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("approval");
    expect(events.length).toBe(0);
    expect(events.every((e) => actionOf(e) !== "effect.boundary-crossed")).toBe(true);
  });

  it("commit ABORT (intent append rejects) on an external allow => NO boundary (effect never ran)", async () => {
    // The FIRST append (the intent) rejects => commit-before-effect aborts => the effect never runs.
    // A boundary on an aborted external call would be boundary-without-effect — it must NOT appear.
    const events: unknown[] = [];
    let seq = 0;
    const appender: CommitAppender<unknown, { sequence: number }> = {
      append: async (event) => {
        seq += 1;
        // The intent (first append) ALWAYS rejects -> aborted; nothing is recorded.
        throw new Error(`append rejected #${seq}`);
        // (unreachable) events.push(event);
      },
    };
    void events;
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: true }, appender }),
      call(),
    );
    expect(out.status).toBe("denied");
    if (out.status === "denied") expect(out.stage).toBe("commit");
  });
});

describe("CAP7 — boundary-append FAILURE is surfaced; the executed effect is unchanged (post-effect fail-safe)", () => {
  it("the SECOND append (boundary) rejects => outcome STAYS executed + boundary-failed marker; effect unchanged", async () => {
    // NON-VACUITY: remove the try/catch around the boundary append and this REJECTS (losing the
    // receipt of an effect that already ran) — or fakes the effect as not-run. Either flips RED.
    const { appender } = recordingAppender(2); // the 2nd append (the boundary) rejects
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: true }, appender }),
      call(),
    );

    expect(out.status).toBe("executed"); // the external effect is irreversible — never fake "didn't run".
    if (out.status !== "executed") throw new Error("unreachable");
    // The effect's intent receipt is preserved (the intent append succeeded).
    expect(out.receipt).toEqual({ sequence: 1 });
    // A surfaced boundary marker tells the caller the boundary record FAILED (alertable), without
    // pretending the effect did not run.
    expect(out.boundary).toEqual({ status: "append-failed" });
  });

  it("a SUCCESSFUL boundary append surfaces a recorded marker (the boundary IS in the WORM)", async () => {
    const { appender } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: true }, appender }),
      call(),
    );
    expect(out.status).toBe("executed");
    if (out.status !== "executed") throw new Error("unreachable");
    expect(out.boundary).toEqual({ status: "recorded" });
  });

  it("NO boundary marker on an in-sandbox executed call (the field is absent, byte-identical)", async () => {
    const { appender } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: false }, appender }),
      call(),
    );
    expect(out.status).toBe("executed");
    expect(out).not.toHaveProperty("boundary");
  });
});

describe("CAP7 — credential-blind WORM: NO argvRedacted/argv0; a URL-query token NEVER reaches the WORM", () => {
  it("argvRedacted (which can carry a non-shape credential) is NEVER recorded in the boundary WORM event", async () => {
    // R9b-1's OWN header (src/policy/governance-projection.ts) warns: `argvRedacted` shape-redaction
    // does NOT catch a non-shape credential (e.g. a `?access_token=...` URL query — `isAllowedFetchUrl`
    // validates protocol/userinfo/host but NOT the path/query), so the projection is safe ONLY for the
    // local AGT engine, "NEVER a log / WORM / audit payload" sink. The boundary WORM event must therefore
    // record ONLY the SAFE derived fields, NOT the full projection.
    //
    // A URL-QUERY CANARY built at RUNTIME (so the secret scanner stays clean) stands in for a real token
    // that survives argvRedacted. RED against the full-projection code: the canary lands in the WORM.
    const canary = ["CANARY", "access", "token", Math.random().toString(36).slice(2)].join("_");
    const leakyUrl = `https://api.allowed.example/data?access_token=${canary}`;
    // A FULL GovernanceProjection-shaped object whose argvRedacted carries the leaky URL verbatim — the
    // EXACT shape `buildExecRunProjection({ argv: [...curl, url] })` produces for net.fetch.
    const projection = {
      version: 1 as const,
      operationClass: "network",
      argv0: "curl",
      argc: 8,
      argvRedacted: ["curl", "-q", "--globoff", "--noproxy", "*", "-sS", "--", leakyUrl],
      truncated: false,
      usesShellInterpreter: false,
      networkHosts: ["api.allowed.example"],
      destructiveFlags: [],
    };
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({
        decision: { effect: "allow", reason: "ok", external: true, projection },
        appender,
      }),
      call(),
    );
    expect(out.status).toBe("executed");
    const boundary = events.find((e) => actionOf(e) === "effect.boundary-crossed") as Record<
      string,
      unknown
    >;
    expect(boundary).toBeDefined();
    const serialized = JSON.stringify(boundary);
    // (1) The runtime-built URL-query canary must NOT appear ANYWHERE in the boundary WORM bytes.
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("access_token");
    // (2) The raw argv fields are NOT recorded at all (no argvRedacted / argv0 / argc key on the wire).
    expect(serialized).not.toContain("argvRedacted");
    expect(serialized).not.toContain("argv0");
    // (3) Neither is the old full-projection container.
    expect(boundary).not.toHaveProperty("boundaryProjection");
  });

  it("the SAFE summary fields ARE retained (audit value kept): networkHosts + operationClass on the boundary", async () => {
    // The fix drops argvRedacted/argv0 but KEEPS the safe derived fields so the boundary record stays
    // useful: networkHosts (userinfo-stripped, host-only = safe) + operationClass + the shape flags.
    const projection = {
      version: 1 as const,
      operationClass: "network",
      argv0: "curl",
      argc: 8,
      argvRedacted: ["curl", "--", "https://api.allowed.example/x"],
      truncated: false,
      usesShellInterpreter: false,
      networkHosts: ["api.allowed.example"],
      destructiveFlags: [],
    };
    const { appender, events } = recordingAppender();
    await runGovernedToolCall(
      depsWith({
        decision: { effect: "allow", reason: "ok", external: true, projection },
        appender,
      }),
      call(),
    );
    const boundary = events.find((e) => actionOf(e) === "effect.boundary-crossed") as Record<
      string,
      unknown
    >;
    const summary = boundary.boundarySummary as Record<string, unknown>;
    expect(summary).toBeDefined();
    expect(summary.networkHosts).toEqual(["api.allowed.example"]);
    expect(summary.operationClass).toBe("network");
    expect(summary.usesShellInterpreter).toBe(false);
    // The neutral identity fields are still present alongside the summary.
    expect(boundary.tenantId).toBe("tenant-a");
    expect(boundary.actorId).toBe("agent:claude");
    expect(boundary.resource).toBe("net.fetch");
  });

  it("with NO projection, the boundary event still appends (neutral-only) and carries no summary field", async () => {
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: true }, appender }),
      call(),
    );
    expect(out.status).toBe("executed");
    const boundary = events.find((e) => actionOf(e) === "effect.boundary-crossed") as Record<
      string,
      unknown
    >;
    expect(boundary).toBeDefined();
    expect(boundary.action).toBe("effect.boundary-crossed");
    expect(boundary).not.toHaveProperty("boundarySummary");
  });
});

describe("CAP7 — audit-only: the boundary append NEVER changes the allow/deny outcome", () => {
  it("the boundary policyDecision is allow (a forward record), and the pipeline outcome is unchanged executed", async () => {
    const { appender, events } = recordingAppender();
    const out = await runGovernedToolCall(
      depsWith({ decision: { effect: "allow", reason: "ok", external: true }, appender }),
      call(),
    );
    // The pipeline outcome is the SAME executed it would be without CAP7 (PDP sovereign).
    expect(out.status).toBe("executed");
    const boundary = events.find((e) => actionOf(e) === "effect.boundary-crossed") as Record<
      string,
      unknown
    >;
    // The boundary records a forward "allow" decision — it is NOT a deny path.
    expect((boundary.policyDecision as { effect?: unknown }).effect).toBe("allow");
  });
});

describe("CAP9 — the boundary summary carries writeTargets (safe path metadata, parallel to networkHosts)", () => {
  it("a host-fs-write external effect's boundary records writeTargets but NO argvRedacted/argv0 (credential-blind)", async () => {
    // A FULL GovernanceProjection-shaped object carrying writeTargets (the shape a host-fs-write tool's
    // projector produces). argvRedacted is included verbatim to prove it is DROPPED from the boundary WORM.
    const projection = {
      version: 1 as const,
      operationClass: "filesystem",
      argv0: "tee",
      argc: 4,
      argvRedacted: ["tee", "--", "/work/out.txt", "ignored"],
      truncated: false,
      usesShellInterpreter: false,
      networkHosts: [],
      destructiveFlags: [],
      writeTargets: ["/work/out.txt", "/data/out/log.txt"],
    };
    const { appender, events } = recordingAppender();
    await runGovernedToolCall(
      depsWith({
        decision: { effect: "allow", reason: "ok", external: true, projection },
        appender,
      }),
      call(),
    );
    const boundary = events.find((e) => actionOf(e) === "effect.boundary-crossed") as Record<
      string,
      unknown
    >;
    const summary = boundary.boundarySummary as Record<string, unknown>;
    expect(summary).toBeDefined();
    // (1) writeTargets is retained as safe path metadata (the very thing the host-write gate decides on).
    expect(summary.writeTargets).toEqual(["/work/out.txt", "/data/out/log.txt"]);
    // (2) The raw argv fields are STILL not recorded (no argvRedacted / argv0 key on the wire).
    const serialized = JSON.stringify(boundary);
    expect(serialized).not.toContain("argvRedacted");
    expect(serialized).not.toContain("argv0");
    expect(boundary).not.toHaveProperty("boundaryProjection");
  });

  it("a path canary in argvRedacted does NOT leak via the boundary; only the safe writeTargets array does", async () => {
    // A runtime-built canary stands in for a non-shape secret an argv token could carry. It must NOT reach
    // the WORM. writeTargets is host-write path metadata (the gate input), so it IS retained — but it is a
    // bounded string array filtered the SAME way networkHosts/destructiveFlags are.
    const canary = ["CANARY", "fs", "secret", Math.random().toString(36).slice(2)].join("_");
    const projection = {
      version: 1 as const,
      operationClass: "filesystem",
      argv0: "tee",
      argc: 3,
      argvRedacted: ["tee", "--", `/work/${canary}`],
      truncated: false,
      usesShellInterpreter: false,
      networkHosts: [],
      destructiveFlags: [],
      writeTargets: ["/work/out.txt"],
    };
    const { appender, events } = recordingAppender();
    await runGovernedToolCall(
      depsWith({
        decision: { effect: "allow", reason: "ok", external: true, projection },
        appender,
      }),
      call(),
    );
    const boundary = events.find((e) => actionOf(e) === "effect.boundary-crossed") as Record<
      string,
      unknown
    >;
    const serialized = JSON.stringify(boundary);
    // The argv canary does NOT appear (argvRedacted is dropped). writeTargets (the safe array) is present.
    expect(serialized).not.toContain(canary);
    const summary = boundary.boundarySummary as Record<string, unknown>;
    expect(summary.writeTargets).toEqual(["/work/out.txt"]);
  });
});
