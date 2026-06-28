/**
 * RED-first tests for the ANCHOR-VERIFY step of the Restore FSM (fix/restore-anchor-validation).
 *
 * THE CONCERN (verified real): `runRestore` routed only `snapshot.sequence` into rebuildProjection
 * and NEVER cross-validated the snapshot's recorded anchor (`wormHeadHash`, `memoryVersion`) against
 * the LIVE chain at that sequence. A snapshot whose sequence still exists but whose recorded head
 * hash / memory version no longer matches the live chain (a STALE or FORGED anchor) could be
 * rebuilt to. SnapshotRecord captures `wormHeadHash`+`memoryVersion` SPECIFICALLY so restore can
 * prove the snapshot is consistent with the live chain BEFORE rebuilding to it.
 *
 * THE FIX adds a fail-closed `verifying-anchor` phase BETWEEN `locked` and `initiated`: AFTER
 * acquireCheckpoint (so the read is under the global lock = consistent) and BEFORE emitting
 * RestoreInitiated (so a bad anchor records NO forward event), the FSM calls the injected
 * `readLiveChainAnchor(snapshot.sequence)` and COMPARES (in the reviewed FSM, not delegated):
 *   - read throws            -> aborted("verifying-anchor", "anchor read failed closed: ...")
 *   - wormHeadHash mismatch   -> aborted("verifying-anchor", "...refusing to restore to a
 *                                stale/forged anchor")
 *   - memoryVersion mismatch  -> aborted("verifying-anchor", same shape)
 *   - exact match            -> proceed to `initiated`
 * On every failure path there is NO append (the abort is PRE-`initiated`), so the appender sees 0
 * events — consistent with the other pre-initiated aborts (validating / locked).
 *
 * Coverage (one block per spec bullet):
 *  - MATCH: live anchor == snapshot anchor -> proceeds -> rebuildProjection called -> RestoreCompleted.
 *  - ⚠️ MISMATCH wormHeadHash -> aborted at verifying-anchor; rebuild NEVER called; 0 events appended.
 *  - ⚠️ MISMATCH memoryVersion -> aborted; rebuild NEVER called; 0 events appended.
 *  - READ THROWS -> aborted fail-closed; rebuild NEVER called; 0 events appended.
 *  - ORDER: anchor-verify is AFTER acquireCheckpoint and BEFORE initiated (recorded call order).
 *  - NON-VACUITY: documented mutation (skip the wormHeadHash/memoryVersion compare, always proceed)
 *    flips the MISMATCH tests RED (rebuild runs on a bad anchor).
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
const OTHER_HEAD = `sha256:${"e".repeat(64)}`;

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

interface Trace {
  readonly steps: string[];
  readonly rebuilt: SnapshotRecord[];
}

/**
 * Build fake deps with a recorded call order. By DEFAULT `readLiveChainAnchor` returns the snapshot's
 * EXACT anchor (matching) so a default run proceeds — overrides drive the mismatch / throw cases.
 */
function deps(
  snap: SnapshotRecord,
  over: Partial<RestoreDeps> = {},
): {
  readonly d: RestoreDeps & { readonly appender: ReturnType<typeof spyAppender> };
  readonly trace: Trace;
} {
  const appender = (over.appender as ReturnType<typeof spyAppender>) ?? spyAppender();
  const steps: string[] = [];
  const rebuilt: SnapshotRecord[] = [];
  const base: RestoreDeps = {
    acquireCheckpoint: async () => {
      steps.push("acquireCheckpoint");
    },
    authorize: () => ({ effect: "allow" as const, reason: "admin approved" }),
    readLiveChainAnchor: async (sequence: number) => {
      steps.push(`readLiveChainAnchor(${sequence})`);
      // DEFAULT = matching anchor: the live chain agrees with the snapshot's recorded anchor.
      return { wormHeadHash: snap.wormHeadHash, memoryVersion: snap.memoryVersion };
    },
    appender,
    rebuildProjection: async (s: SnapshotRecord) => {
      steps.push("rebuildProjection");
      rebuilt.push(s);
    },
  };
  const d = { ...base, ...over, appender } as RestoreDeps & {
    readonly appender: ReturnType<typeof spyAppender>;
  };
  return { d, trace: { steps, rebuilt } };
}

describe("runRestore — anchor cross-validation (MATCH)", () => {
  it("proceeds and rebuilds when the live chain anchor exactly matches the snapshot anchor", async () => {
    const snap = snapshot();
    const { d, trace } = deps(snap);

    const outcome = await runRestore(d, snap, "admin-1", "orchestration");

    expect(outcome.status).toBe("completed");
    expect(outcome.phase).toBe("completed");
    expect(trace.rebuilt).toHaveLength(1);
    expect(trace.rebuilt[0]).toBe(snap);
    expect(d.appender.calls).toHaveLength(2);
    expect(d.appender.calls[0]?.restorePhase).toBe("RestoreInitiated");
    expect(d.appender.calls[1]?.restorePhase).toBe("RestoreCompleted");
  });
});

describe("runRestore — anchor cross-validation (⚠️ MISMATCH wormHeadHash)", () => {
  it("aborts at verifying-anchor, never rebuilds, and appends NO event when the live head hash differs", async () => {
    const snap = snapshot({ wormHeadHash: HEAD });
    const { d, trace } = deps(snap, {
      readLiveChainAnchor: async () => ({
        // live chain head at this sequence is DIFFERENT from the snapshot's recorded head -> stale/forged
        wormHeadHash: OTHER_HEAD,
        memoryVersion: snap.memoryVersion,
      }),
    });

    const outcome = await runRestore(d, snap, "admin-1", "orchestration");

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("verifying-anchor");
    expect(outcome.reason).toMatch(/stale\/forged anchor/);
    // PRE-initiated abort: rebuild NEVER ran and NOTHING was appended to the chain.
    expect(trace.rebuilt).toHaveLength(0);
    expect(d.appender.calls).toHaveLength(0);
  });
});

describe("runRestore — anchor cross-validation (⚠️ MISMATCH memoryVersion)", () => {
  it("aborts at verifying-anchor, never rebuilds, and appends NO event when the live memoryVersion differs", async () => {
    const snap = snapshot({ memoryVersion: 7 });
    const { d, trace } = deps(snap, {
      readLiveChainAnchor: async () => ({
        wormHeadHash: snap.wormHeadHash,
        // live chain memory version at this sequence has moved on -> the snapshot anchor is stale
        memoryVersion: 9,
      }),
    });

    const outcome = await runRestore(d, snap, "admin-1", "orchestration");

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("verifying-anchor");
    expect(outcome.reason).toMatch(/stale\/forged anchor/);
    expect(trace.rebuilt).toHaveLength(0);
    expect(d.appender.calls).toHaveLength(0);
  });
});

describe("runRestore — anchor cross-validation (READ THROWS -> fail-closed)", () => {
  it("aborts at verifying-anchor fail-closed, never rebuilds, and appends NO event when the live read throws", async () => {
    const snap = snapshot();
    const { d, trace } = deps(snap, {
      readLiveChainAnchor: async () => {
        throw new Error("live chain read transport down");
      },
    });

    const outcome = await runRestore(d, snap, "admin-1", "orchestration");

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("verifying-anchor");
    expect(outcome.reason).toMatch(/anchor read failed closed/);
    expect(trace.rebuilt).toHaveLength(0);
    expect(d.appender.calls).toHaveLength(0);
  });
});

describe("runRestore — anchor-verify ORDER (after lock, before initiated)", () => {
  it("reads the live anchor AFTER acquireCheckpoint and BEFORE emitting RestoreInitiated", async () => {
    const snap = snapshot();
    const { d, trace } = deps(snap);

    const outcome = await runRestore(d, snap, "admin-1", "orchestration");

    expect(outcome.status).toBe("completed");
    // The lock is taken first (so the read is consistent), THEN the anchor read, THEN the rebuild.
    expect(trace.steps).toEqual([
      "acquireCheckpoint",
      `readLiveChainAnchor(${snap.sequence})`,
      "rebuildProjection",
    ]);
    // ...and only AFTER the matching read does any forward event appear (RestoreInitiated first).
    expect(d.appender.calls[0]?.restorePhase).toBe("RestoreInitiated");
  });
});
