import { describe, expect, it, vi } from "vitest";
import { parseAgentContext } from "../../iam/ids.js";
import type { GovernedCall, GovernedOutcome } from "../../orchestration/index.js";
import type { PlanPreview } from "../plan/index.js";
import { ApprovalInbox, MAX_PENDING } from "./index.js";

// A valid zero-skill caller identity (same shape as the S1/S2/S3 tests).
const ctx = parseAgentContext({
  actorId: "user-1",
  tenantId: "personal",
  projectId: "home",
  taskId: "task-1",
  requestId: "req-1",
});

// A minimal GovernedCall (the lowered shape S4 hands to the injected pipeline runner; see
// src/orchestration/pipeline.ts GovernedCall = { tool, context }).
function callOf(tool: string): GovernedCall {
  return { tool, context: ctx };
}

// A plain-language preview the owner reviews before approving (S3 PlanPreview shape).
function previewOf(title: string): PlanPreview {
  return {
    title,
    steps: [`1. ${title}.`],
    affectedResources: ["photos"],
    summary: `This plan will ${title.toLowerCase()}.`,
  };
}

// An executed outcome a stub runner returns (P2-I GovernedOutcome shape). Carries the now-required
// `settlement` (the surfaced cost.commit result); the inbox passes the runner's outcome through opaquely.
function executed(): GovernedOutcome<string> {
  return {
    status: "executed",
    reservationId: "res-1",
    receipt: "receipt-1",
    settlement: { status: "committed", overrun: false },
  };
}

describe("ApprovalInbox — explicit-approve is the ONLY effect entry (deny-by-default)", () => {
  it("submit -> pending+id; approve(id) invokes the injected runner EXACTLY once -> executed", async () => {
    const run = vi.fn(async (_tc: GovernedCall) => executed());
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    const submitted = inbox.submit(previewOf("Back up photos"), callOf("fs.backup"));
    expect(submitted.status).toBe("pending");
    if (submitted.status !== "pending") throw new Error("unreachable");
    expect(submitted.id.length).toBeGreaterThan(0);

    const decided = await inbox.approve(submitted.id);
    expect(decided.status).toBe("executed");
    expect(decided.outcome).toEqual(executed());
    expect(run).toHaveBeenCalledTimes(1);
    // approve lowered THIS entry's call to the runner.
    expect(run).toHaveBeenCalledWith(callOf("fs.backup"));
  });

  it("deny-by-default: a still-pending entry NEVER runs; reject(id) -> denied, runner 0 times", async () => {
    const run = vi.fn(async (_tc: GovernedCall) => executed());
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    const submitted = inbox.submit(previewOf("Delete files"), callOf("fs.delete"));
    if (submitted.status !== "pending") throw new Error("unreachable");

    // Never approved -> runner must not have fired at all.
    expect(run).toHaveBeenCalledTimes(0);

    const rejected = inbox.reject(submitted.id);
    expect(rejected.status).toBe("denied");
    expect(run).toHaveBeenCalledTimes(0);
  });

  it("approving an unknown id -> denied, runner 0 times (deny-by-default)", async () => {
    const run = vi.fn(async (_tc: GovernedCall) => executed());
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    const decided = await inbox.approve("no-such-id");
    expect(decided.status).toBe("denied");
    expect(run).toHaveBeenCalledTimes(0);
  });

  it("one-time authorization (anti-replay): a second approve(id) is denied, runner NOT called again", async () => {
    const run = vi.fn(async (_tc: GovernedCall) => executed());
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    const submitted = inbox.submit(previewOf("Share report"), callOf("fs.share"));
    if (submitted.status !== "pending") throw new Error("unreachable");

    const first = await inbox.approve(submitted.id);
    expect(first.status).toBe("executed");
    expect(run).toHaveBeenCalledTimes(1);

    // Replay attempt: the entry is terminal -> deny, no double-effect.
    const second = await inbox.approve(submitted.id);
    expect(second.status).toBe("denied");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("a rejected entry cannot then be approved (terminal): approve(id) -> denied, runner 0 times", async () => {
    const run = vi.fn(async (_tc: GovernedCall) => executed());
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    const submitted = inbox.submit(previewOf("Move docs"), callOf("fs.move"));
    if (submitted.status !== "pending") throw new Error("unreachable");

    expect(inbox.reject(submitted.id).status).toBe("denied");
    const decided = await inbox.approve(submitted.id);
    expect(decided.status).toBe("denied");
    expect(run).toHaveBeenCalledTimes(0);
  });

  it("pending cap: the 4th submit over MAX_PENDING is denied (borrow Hermes max-3-pending)", () => {
    expect(MAX_PENDING).toBe(3);
    const run = vi.fn(async (_tc: GovernedCall) => executed());
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    for (let i = 0; i < MAX_PENDING; i++) {
      expect(inbox.submit(previewOf(`Task ${i}`), callOf(`fs.t${i}`)).status).toBe("pending");
    }
    const overflow = inbox.submit(previewOf("Task overflow"), callOf("fs.overflow"));
    expect(overflow.status).toBe("denied");
    if (overflow.status !== "denied") throw new Error("unreachable");
    expect(overflow.reason.length).toBeGreaterThan(0);
  });

  it("deciding a pending entry frees a cap slot so a new submit can pend again", async () => {
    const run = vi.fn(async (_tc: GovernedCall) => executed());
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    let firstId = "";
    for (let i = 0; i < MAX_PENDING; i++) {
      const s = inbox.submit(previewOf(`Task ${i}`), callOf(`fs.t${i}`));
      if (s.status !== "pending") throw new Error("unreachable");
      if (i === 0) firstId = s.id;
    }
    // At cap -> denied.
    expect(inbox.submit(previewOf("over"), callOf("fs.over")).status).toBe("denied");

    // Approve one -> it becomes terminal, freeing a pending slot.
    expect((await inbox.approve(firstId)).status).toBe("executed");

    // Now a fresh submit can pend again.
    expect(inbox.submit(previewOf("after free"), callOf("fs.free")).status).toBe("pending");
  });

  it("approve a plan the pipeline denies (runner returns denied) -> DecideOutcome denied, P2-I stage passed through", async () => {
    const denied: GovernedOutcome<string> = {
      status: "denied",
      stage: "policy",
      reason: "PDP says no",
    };
    const run = vi.fn(async (_tc: GovernedCall) => denied);
    const inbox = new ApprovalInbox<GovernedCall, string>(run);

    const submitted = inbox.submit(previewOf("Risky op"), callOf("fs.risky"));
    if (submitted.status !== "pending") throw new Error("unreachable");

    const decided = await inbox.approve(submitted.id);
    expect(decided.status).toBe("denied");
    expect(decided.outcome).toEqual(denied);
    expect(run).toHaveBeenCalledTimes(1);

    // Still terminal: cannot retry after a pipeline denial (one-time authorization).
    const retry = await inbox.approve(submitted.id);
    expect(retry.status).toBe("denied");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
