/**
 * RED-first tests for the Restore FSM + RestoreEvent forward-append (SLICE-P2R-R10-S3).
 *
 * Behaviour/invariant coverage (one block per spec §5 bullet):
 *  - happy path: valid snapshot + admin actor -> phases validating->locked->initiated->rebuilding->
 *    completed; the injected appender receives EXACTLY 2 forward events (RestoreInitiated, then
 *    RestoreCompleted) in order.
 *  - forward-only invariant (adversarial): the FSM only ever `append`s — the injected appender is a
 *    spy whose ONLY capability is append; we assert 0 truncate/rewrite calls (the surface does not
 *    exist) and that both emitted events are forward `kind: "system.restore"` events.
 *  - attester != actor (adversarial): sourceId === "brain" -> aborted at `validating`, deny-by-
 *    default, NO append (the brain cannot self-restore).
 *  - fail-closed per phase (adversarial): acquireCheckpoint reject -> aborted at `locked`, Restore
 *    Initiated NOT emitted; rebuildProjection reject -> aborted at `rebuilding`, RestoreCompleted
 *    NOT emitted (no half-completed illusion left behind).
 *  - authorize deny -> aborted at `validating`, no append.
 *  - DivergenceReport: a non-empty externalEffectsSinceBaseline is carried verbatim into the
 *    RestoreInitiated event (operator can see it before approval; design §23).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AppendReceipt } from "../audit/index.js";
import {
  type RestoreAppender,
  type RestoreDeps,
  type RestoreEvent,
  runRestore,
} from "./restore.js";
import type { ExternalEffect, SnapshotRecord } from "./snapshot.js";

const HEAD = `sha256:${"a".repeat(64)}`;

function snapshot(over: Partial<SnapshotRecord> = {}): SnapshotRecord {
  return {
    snapshotId: randomUUID(),
    sequence: 42,
    wormHeadHash: HEAD,
    memoryVersion: 7,
    ledgerLsn: "0/16B6C50",
    sandboxRef: "sandbox-crd://golden-image-v3",
    externalEffectsSinceBaseline: [] as readonly ExternalEffect[],
    ...over,
  };
}

function receipt(sequence: number): AppendReceipt {
  return {
    sequence,
    contentHash: `sha256:${"b".repeat(64)}`,
    prevHash: `sha256:${"c".repeat(64)}`,
    entryHash: `sha256:${"d".repeat(64)}`,
  };
}

/** A spy appender whose ONLY capability is `append` — there is no truncate/rewrite surface. */
function spyAppender(): RestoreAppender & { readonly calls: RestoreEvent[] } {
  const calls: RestoreEvent[] = [];
  return {
    calls,
    async append(event: RestoreEvent): Promise<AppendReceipt> {
      calls.push(event);
      return receipt(calls.length);
    },
  };
}

function deps(
  over: Partial<RestoreDeps> = {},
): RestoreDeps & { readonly appender: ReturnType<typeof spyAppender> } {
  const appender = (over.appender as ReturnType<typeof spyAppender>) ?? spyAppender();
  return {
    acquireCheckpoint: async () => undefined,
    authorize: () => ({ effect: "allow" as const, reason: "admin approved" }),
    rebuildProjection: async () => undefined,
    ...over,
    appender,
  } as RestoreDeps & { readonly appender: ReturnType<typeof spyAppender> };
}

describe("runRestore — happy path", () => {
  it("walks validating->locked->initiated->rebuilding->completed and appends exactly 2 forward events", async () => {
    const d = deps();
    const snap = snapshot();
    const outcome = await runRestore(d, snap, "admin-1", "orchestration");

    expect(outcome.status).toBe("completed");
    expect(outcome.phase).toBe("completed");
    expect(d.appender.calls).toHaveLength(2);
    expect(d.appender.calls[0]?.kind).toBe("system.restore");
    expect(d.appender.calls[0]?.restorePhase).toBe("RestoreInitiated");
    expect(d.appender.calls[1]?.restorePhase).toBe("RestoreCompleted");
    expect(d.appender.calls[0]?.targetSnapshotId).toBe(snap.snapshotId);
    expect(d.appender.calls[0]?.targetSequence).toBe(snap.sequence);
    expect(d.appender.calls[0]?.actor).toBe("admin-1");
  });
});

describe("runRestore — forward-only invariant (adversarial)", () => {
  it("only ever appends; the appender exposes no truncate/rewrite capability", async () => {
    const d = deps();
    await runRestore(d, snapshot(), "admin-1", "orchestration");

    // The injected appender is the ONLY emit seam; it has exactly one method.
    const surface = Object.keys(d.appender).filter((k) => k !== "calls");
    expect(surface).toEqual(["append"]);
    for (const call of d.appender.calls) {
      expect(call.kind).toBe("system.restore");
    }
  });
});

describe("runRestore — attester != actor (adversarial)", () => {
  it("denies a brain-originated restore at validating with no append", async () => {
    const d = deps();
    const outcome = await runRestore(d, snapshot(), "admin-1", "brain");

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("validating");
    expect(d.appender.calls).toHaveLength(0);
  });
});

describe("runRestore — fail-closed per phase (adversarial)", () => {
  it("aborts at locked when acquireCheckpoint rejects and never emits RestoreInitiated", async () => {
    const d = deps({
      acquireCheckpoint: async () => {
        throw new Error("global lock contended");
      },
    });
    const outcome = await runRestore(d, snapshot(), "admin-1", "orchestration");

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("locked");
    expect(d.appender.calls).toHaveLength(0);
  });

  it("aborts at rebuilding when rebuildProjection rejects and never emits RestoreCompleted", async () => {
    const d = deps({
      rebuildProjection: async () => {
        throw new Error("DB txn torn mid-rebuild");
      },
    });
    const outcome = await runRestore(d, snapshot(), "admin-1", "orchestration");

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("rebuilding");
    // RestoreInitiated was emitted, but RestoreCompleted must NOT be (no half-completed illusion).
    expect(d.appender.calls).toHaveLength(1);
    expect(d.appender.calls[0]?.restorePhase).toBe("RestoreInitiated");
  });
});

describe("runRestore — authorize deny", () => {
  it("aborts at validating with no append when authorize denies", async () => {
    const d = deps({
      authorize: () => ({ effect: "deny" as const, reason: "not an approver" }),
    });
    const outcome = await runRestore(d, snapshot(), "intern-9", "orchestration");

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("validating");
    expect(d.appender.calls).toHaveLength(0);
  });
});

describe("runRestore — DivergenceReport carried into RestoreInitiated", () => {
  it("passes a non-empty externalEffectsSinceBaseline verbatim into the forward initiated event", async () => {
    const divergence: readonly ExternalEffect[] = [
      { tool: "send_email", sideEffect: "irreversible", idempotent: false },
    ];
    const d = deps();
    const snap = snapshot({ externalEffectsSinceBaseline: divergence });
    await runRestore(d, snap, "admin-1", "orchestration");

    expect(d.appender.calls[0]?.divergenceReport).toEqual(divergence);
  });
});
