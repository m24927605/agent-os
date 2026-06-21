/**
 * RED-first tests for the Forensic Replay fold engine (SLICE-P2R-R10-S1).
 *
 * Behaviour/invariant coverage (one block per spec §5 bullet):
 *  - ordered fold rebuilds the full timeline (headSequence === lastSequence; steps.length === N).
 *  - determinism: same events -> same timelineHash; mutate any event content -> different hash.
 *  - point-in-time: uptoSequence = k folds only events <= k.
 *  - fail-closed (adversarial): gap / non-monotonic / duplicate sequence / missing `sequence`
 *    field -> throw ReplayError (NEVER return a "looks complete" shorter timeline).
 *  - read-only invariant: input array + elements are not mutated; no tool/IO effect is invoked.
 */
import { describe, expect, it } from "vitest";
import { ReplayError, type ReplayEvent, replayTimeline } from "./replay.js";

function evt(sequence: number, event: unknown): ReplayEvent {
  return { sequence, event };
}

const ordered: readonly ReplayEvent[] = [
  evt(1, { kind: "task.created", taskId: "t-1" }),
  evt(2, { kind: "tool.invoked", tool: "search" }),
  evt(3, { kind: "tool.result", ok: true }),
];

describe("replayTimeline — ordered fold", () => {
  it("rebuilds the full timeline: headSequence === last sequence, steps.length === N", () => {
    const tl = replayTimeline(ordered);
    expect(tl.steps.length).toBe(3);
    expect(tl.headSequence).toBe(3);
  });

  it("folds an empty event sequence into an empty, well-formed timeline", () => {
    const tl = replayTimeline([]);
    expect(tl.steps.length).toBe(0);
    expect(tl.headSequence).toBe(0);
    expect(typeof tl.timelineHash).toBe("string");
  });
});

describe("replayTimeline — determinism", () => {
  it("replaying the same events twice yields the same timelineHash", () => {
    const a = replayTimeline(ordered);
    const b = replayTimeline(ordered.map((e) => evt(e.sequence, e.event)));
    expect(a.timelineHash).toBe(b.timelineHash);
    expect(a.timelineHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changing any event content changes the timelineHash", () => {
    const baseline = replayTimeline(ordered).timelineHash;
    const mutated = replayTimeline([
      evt(1, { kind: "task.created", taskId: "t-1" }),
      evt(2, { kind: "tool.invoked", tool: "DIFFERENT" }),
      evt(3, { kind: "tool.result", ok: true }),
    ]).timelineHash;
    expect(mutated).not.toBe(baseline);
  });
});

describe("replayTimeline — point-in-time (uptoSequence)", () => {
  it("folds only events <= k and sets headSequence === k", () => {
    const tl = replayTimeline(ordered, 2);
    expect(tl.steps.length).toBe(2);
    expect(tl.headSequence).toBe(2);
  });

  it("a point-in-time fold differs from the full-timeline hash", () => {
    expect(replayTimeline(ordered, 2).timelineHash).not.toBe(replayTimeline(ordered).timelineHash);
  });
});

describe("replayTimeline — fail-closed (adversarial)", () => {
  it("throws ReplayError on a sequence gap (missing N+1) instead of returning a shorter timeline", () => {
    const gapped = [evt(1, { a: 1 }), evt(2, { a: 2 }), evt(4, { a: 4 })];
    expect(() => replayTimeline(gapped)).toThrow(ReplayError);
  });

  it("throws ReplayError on a non-monotonic (out-of-order) sequence", () => {
    const reordered = [evt(1, { a: 1 }), evt(3, { a: 3 }), evt(2, { a: 2 })];
    expect(() => replayTimeline(reordered)).toThrow(ReplayError);
  });

  it("throws ReplayError on a duplicate sequence", () => {
    const dup = [evt(1, { a: 1 }), evt(2, { a: 2 }), evt(2, { a: 2 })];
    expect(() => replayTimeline(dup)).toThrow(ReplayError);
  });

  it("throws ReplayError when an element is missing the `sequence` field", () => {
    const malformed = [evt(1, { a: 1 }), { event: { a: 2 } } as unknown as ReplayEvent];
    expect(() => replayTimeline(malformed)).toThrow(ReplayError);
  });

  it("throws ReplayError when an element has a non-integer / non-finite sequence", () => {
    const bad = [evt(1, { a: 1 }), evt(Number.NaN, { a: 2 })];
    expect(() => replayTimeline(bad)).toThrow(ReplayError);
  });

  it("throws ReplayError when uptoSequence falls inside a gap below head but matches no event", () => {
    // events 1,2,3 present; uptoSequence=5 is beyond head and there is no event 4/5 — out of range.
    expect(() => replayTimeline(ordered, 5)).toThrow(ReplayError);
  });
});

describe("replayTimeline — read-only invariant (no mutation, no effect)", () => {
  it("does not mutate the input array or its elements", () => {
    const input = ordered.map((e) => evt(e.sequence, structuredClone(e.event)));
    const snapshot = structuredClone(input);
    replayTimeline(input);
    expect(input).toStrictEqual(snapshot);
  });

  it("never invokes an injected effect: a poison effect callable in the payload is never called", () => {
    // The fold engine takes NO effect/IO dependency by construction (its signature has no effect
    // seam at all). To prove "0 tool re-runs", we plant a callable on the event payload that throws
    // if the engine ever *executes* it. A pure structural fold must NEVER call it; if it did, the
    // thrown error would propagate and fail this test (an effect-spy assertion of 0 invocations).
    let invocations = 0;
    const poisonEffect = (): never => {
      invocations += 1;
      throw new Error("forensic replay must NEVER re-run a tool / perform IO");
    };
    const tl = replayTimeline([
      evt(1, { kind: "tool.invoked", tool: "search", run: poisonEffect }),
    ]);
    expect(tl.headSequence).toBe(1);
    expect(invocations).toBe(0);
  });
});
