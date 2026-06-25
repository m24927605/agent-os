/**
 * SLICE-LR1 — snapshot restore proven LIVE against the REAL Go kernel (cross-process, cross-language).
 *
 * `snapshot.ts` + `restore.ts` (`runRestore`) + `replay.ts` were unit-built but never live-e2e'd. LR1
 * is the gated real run: against a spawned `kernel/cmd/kernel` AppendService it (1) appends a chain of
 * AuditEvents up to an anchor sequence **S** (a representative task state), (2) appends MORE events past
 * S to **M** (state moves forward), then (3) drives `runRestore(...)` restore-to-S with an admin/approver
 * -signed `RestoreAuthorization` and a `RestoreAppender` backed by the SAME real ingest appender, whose
 * `rebuildProjection` reads back the LIVE chain via `ListEntries` (read-transport) up to S and folds it
 * with `replay`. It proves, on the REAL WORM hash-chain, that restore-to-S:
 *   (a) rebuilds the S-state correctly (the folded projection at S == the expected state at S — live);
 *   (b) FORWARD-APPENDS the two RestoreEvents (RestoreInitiated then RestoreCompleted) at M+1, M+2;
 *   (c) is FORWARD-ONLY / never truncated: all pre-restore sequences 0..S AND S+1..M still present after;
 *   (d) is admin-signed: an UNAUTHORIZED actor (authorize -> deny) appends NOTHING — the brain can NEVER
 *       self-restore;
 *   (e) is fail-closed: a read/fold error mid-restore (a SnapshotRecord anchor out of the live range fed
 *       to replay) aborts WITHOUT emitting RestoreCompleted — no half-completed illusion (restore.ts §16).
 *
 * ⚠️ KERNEL SEQUENCING (the load-bearing harness fact): the ingest appender is CLIENT-sequenced
 * PER (sourceId) — `createIngestAppender` tracks its own monotonic counter, and dedup keys (sourceId,
 * sequence). `ListEntries` returns the WHOLE single-chain across ALL sources, each entry carrying its
 * own per-source `sequence`. `replay` requires a SINGLE monotonic timeline. So the harness MUST: (i) emit
 * the RestoreEvents through the SAME appender instance as the task chain (so their sequences CONTINUE
 * M+1, M+2 — not restart at 0 on a second source), and (ii) fold/assert over ONLY this test's events,
 * isolated by the `requestId` prefix `req-<sourceId>-` (LogEntry drops sourceId, so requestId is the
 * per-test witness). This also makes the three tests independent of run order on a shared kernel chain.
 *
 * GATED on AGENTOS_LIVE_KERNEL_ENDPOINT: under plain `pnpm run verify` (no env) this `describe.skip`s,
 * keeping the gate hermetic (no spawn/build). Run it with the real kernel via `pnpm run e2e:live-restore`
 * (scripts/e2e-live-restore.sh builds + spawns the kernel, sets the env, then tears down).
 *
 * HONEST BOUNDARY (mirrors the spec §5): LR1 lifts snapshot restore to LIVE-PROVEN (against the real
 * kernel), peer to AGT/kernel. restore stays an OPERATOR recovery tool — admin/approver-signed, NOT in
 * the autonomous loop. LR1 does not change that posture; it proves the tool actually works on a real chain.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type AppendReceipt,
  type AuditEvent,
  type LogEntry,
  createAuditEvent,
  createIngestAppender,
} from "../audit/index.js";
import { createEntriesReader } from "../runtime/ingest/read-transport.js";
import { createRpcAppendTransport } from "../runtime/ingest/transport.js";
import { type ReplayEvent, replayTimeline } from "./replay.js";
import { type RestoreAppender, type RestoreEvent, runRestore } from "./restore.js";
import type { ExternalEffect, SnapshotRecord } from "./snapshot.js";

const ENDPOINT = process.env.AGENTOS_LIVE_KERNEL_ENDPOINT;

// Skip cleanly when not driven by the harness -> `pnpm run verify` stays hermetic (no spawn/build).
const d = ENDPOINT ? describe : describe.skip;

const HEAD = `sha256:${"a".repeat(64)}`;

/** Per-test requestId prefix — the witness that isolates THIS test's events on the shared single chain. */
const reqPrefix = (sourceId: string): string => `req-${sourceId}-`;

/** Build one task-state AuditEvent; `requestId` carries the per-test prefix so we can isolate it. */
function mkEvent(sourceId: string, action: string): AuditEvent {
  return createAuditEvent({
    actorId: "agent:lr1",
    tenantId: "tenant-lr1",
    projectId: "proj-1",
    taskId: "task-1",
    requestId: `${reqPrefix(sourceId)}${action}`,
    action,
    resource: "res-prod",
    policyDecision: { effect: "allow", reason: "ok" },
    result: "success",
  });
}

/** The REAL grpc-js ingest appender for arbitrary AuditEvents (the chain we restore over). */
function eventAppender(sourceId: string) {
  return createIngestAppender<AuditEvent>({
    transport: createRpcAppendTransport({ endpoint: ENDPOINT as string }),
    sourceId,
  });
}

/**
 * The narrow forward-append seam (`RestoreAppender`) backed by the SAME real ingest APPENDER INSTANCE as
 * the task chain — so the two forward markers CONTINUE that source's monotonic sequence (M+1, M+2), never
 * restart at 0 on a second source (which would break `replay`'s single-monotonic-timeline contract). Its
 * sole capability is `append` (no truncate/rewrite surface). It serializes each RestoreEvent into an
 * AuditEvent (the kernel's only append shape); `requestId` keeps this test's prefix so the marker stays
 * inside the per-test fold; `action` carries the marker; `resource` carries the target snapshot/sequence.
 */
function liveRestoreAppender(
  inner: ReturnType<typeof eventAppender>,
  sourceId: string,
): RestoreAppender {
  return {
    async append(event: RestoreEvent): Promise<AppendReceipt> {
      const audit = createAuditEvent({
        actorId: `admin:${event.actor}`,
        tenantId: "tenant-lr1",
        projectId: "proj-1",
        taskId: "task-1",
        requestId: `${reqPrefix(sourceId)}restore-${event.restorePhase}`,
        action: `system.restore:${event.restorePhase}`,
        resource: `snapshot:${event.targetSnapshotId}@${event.targetSequence}`,
        policyDecision: { effect: "allow", reason: "admin approved restore" },
        result: "success",
      });
      return inner.append(audit);
    },
  };
}

/** Map a read-back `LogEntry` into the structural `ReplayEvent` the fold engine consumes. */
function toReplayEvent(entry: LogEntry): ReplayEvent {
  return { sequence: entry.sequence, event: entry.event };
}

/**
 * Isolate THIS test's events from the shared single chain by the per-test requestId prefix. LogEntry drops
 * sourceId, so requestId is the witness. The filtered slice is a single monotonic timeline (one source,
 * one appender instance) that `replay` can fold; other tests' (and other sources') events are excluded.
 */
function mine(entries: readonly LogEntry[], sourceId: string): readonly LogEntry[] {
  const p = reqPrefix(sourceId);
  return entries.filter((e) => String(e.event.requestId).startsWith(p));
}

/** Append `actions` in order via `appender`, returning the settled sequence of the LAST one (the head). */
async function appendChain(
  appender: ReturnType<typeof eventAppender>,
  actions: readonly string[],
  sourceId: string,
): Promise<number> {
  let lastSeq = -1;
  for (const action of actions) {
    const r = await appender.append(mkEvent(sourceId, action));
    lastSeq = r.sequence;
  }
  return lastSeq;
}

d("LR1 — snapshot restore-to-S, LIVE against the real Go kernel", () => {
  it("(a-c) restore-to-S rebuilds the S-state, forward-appends both RestoreEvents, and NEVER truncates 0..M", async () => {
    // A UNIQUE source: the appender is client-sequenced per source, so its counter starts at 0 for THIS
    // chain; the requestId prefix isolates this test's events on the shared chain.
    const sourceId = `lr1-restore-${Date.now()}`;
    const appender = eventAppender(sourceId);
    const reader = createEntriesReader({ endpoint: ENDPOINT as string });

    // 1) Append a chain of task-state AuditEvents up to anchor sequence S (the head / checkpoint).
    const stateAtS = ["created", "claimed", "tool:search", "tool:write"];
    const S = await appendChain(appender, stateAtS, sourceId);
    expect(S).toBeGreaterThanOrEqual(stateAtS.length - 1);

    // 2) Append MORE events PAST S, advancing state to M > S (the divergence we restore away from).
    const stateAfterS = ["tool:email", "completed"];
    const M = await appendChain(appender, stateAfterS, sourceId);
    expect(M).toBeGreaterThan(S);

    // Capture THIS test's full pre-restore chain (0..M) for the forward-only / non-truncation proof.
    const preEntries = mine(await reader(), sourceId);
    const preCount = preEntries.length;
    expect(preCount).toBe(M + 1); // exactly the M+1 events this test appended (0..M), isolated
    // A stable per-(sequence,entryHash) fingerprint of EVERY pre-restore entry — the load-bearing witness
    // that restore adds-only (a truncating/rewriting appender would drop or alter one of these).
    const preFingerprint = new Map<number, string>(
      preEntries.map((e) => [e.sequence, e.entryHash]),
    );

    // The expected S-state: fold THIS test's live chain (read back via ListEntries) up to S with `replay`.
    const expectedAtS = replayTimeline(preEntries.map(toReplayEvent), S);

    // 3) The SnapshotRecord anchored at the LIVE head sequence S; restore-to-S rebuilds via the same
    //    read+fold path the operator's recovery would (no in-memory shortcut — it reads the REAL chain).
    const snap: SnapshotRecord = {
      snapshotId: randomUUID(),
      sequence: S,
      wormHeadHash: HEAD,
      memoryVersion: 1,
      ledgerLsn: null,
      sandboxRef: null,
      externalEffectsSinceBaseline: [] as readonly ExternalEffect[],
    };

    // rebuildProjection reads the LIVE chain via ListEntries up to S and folds it. A throw fails closed.
    let rebuilt: ReturnType<typeof replayTimeline> | undefined;
    const restoreAppender = liveRestoreAppender(appender, sourceId);
    const outcome = await runRestore(
      {
        acquireCheckpoint: async () => undefined,
        // admin/approver-signed: the operator approval seam (PDP). allow -> proceed.
        authorize: () => ({ effect: "allow" as const, reason: "admin approved restore" }),
        appender: restoreAppender,
        rebuildProjection: async (s: SnapshotRecord) => {
          const live = mine(await reader(), sourceId);
          rebuilt = replayTimeline(live.map(toReplayEvent), s.sequence);
        },
      },
      snap,
      "approver-1",
      "orchestration",
    );

    // restore-to-S completed (admin-signed, locked, both forward events emitted, projection rebuilt).
    expect(outcome.status).toBe("completed");
    expect(outcome.phase).toBe("completed");

    // (a) REPLAY CORRECT: the rebuilt projection at S equals the expected S-state on the LIVE chain — the
    //     deterministic content address (timelineHash) AND the folded head match (same chain, same fold).
    expect(rebuilt).toBeDefined();
    expect(rebuilt?.timelineHash).toBe(expectedAtS.timelineHash);
    expect(rebuilt?.headSequence).toBe(S);
    const lastStep = rebuilt?.steps[rebuilt.steps.length - 1];
    expect((lastStep?.event as AuditEvent | undefined)?.action).toBe(stateAtS[stateAtS.length - 1]);

    // (b) FORWARD-APPEND: read the chain back AFTER restore; the two RestoreEvents are the NEW head at
    //     M+1 (RestoreInitiated) and M+2 (RestoreCompleted) — forward from M, never a rewrite of history.
    const postEntries = mine(await reader(), sourceId);
    const initiated = postEntries.find((e) => e.sequence === M + 1);
    const completed = postEntries.find((e) => e.sequence === M + 2);
    expect(initiated?.event.action).toBe("system.restore:RestoreInitiated");
    expect(completed?.event.action).toBe("system.restore:RestoreCompleted");
    expect(initiated?.event.resource).toBe(`snapshot:${snap.snapshotId}@${S}`);

    // (c) FORWARD-ONLY / NEVER TRUNCATED (NON-VACUITY built in): the count grew by EXACTLY the two forward
    //     events, and EVERY pre-restore (sequence, entryHash) in 0..M is STILL present byte-for-byte. A
    //     truncating/rewriting appender (dropping 0..S, or rewriting S+1..M) would FAIL here — a missing
    //     sequence or a changed entryHash trips the loop. restore adds-only.
    expect(postEntries.length).toBeGreaterThanOrEqual(preCount); // monotonic non-decreasing
    expect(postEntries.length).toBe(preCount + 2); // exactly the two forward RestoreEvents
    const postFingerprint = new Map<number, string>(
      postEntries.map((e) => [e.sequence, e.entryHash]),
    );
    for (const [seq, hash] of preFingerprint) {
      expect(postFingerprint.get(seq)).toBe(hash); // every 0..M still on the chain, unchanged
    }
  });

  it("(d) admin-signed: an UNAUTHORIZED actor (authorize -> deny) appends NOTHING — the brain can NEVER self-restore", async () => {
    const sourceId = `lr1-deny-${Date.now()}`;
    const appender = eventAppender(sourceId);
    const reader = createEntriesReader({ endpoint: ENDPOINT as string });

    await appendChain(appender, ["created", "claimed"], sourceId);
    const S = 1; // this source's anchor (0-indexed; "claimed" settled at per-source sequence 1)

    const beforeCount = mine(await reader(), sourceId).length;

    const snap: SnapshotRecord = {
      snapshotId: randomUUID(),
      sequence: S,
      wormHeadHash: HEAD,
      memoryVersion: 1,
      ledgerLsn: null,
      sandboxRef: null,
      externalEffectsSinceBaseline: [] as readonly ExternalEffect[],
    };

    // authorize -> deny: the operator-signing gate refuses this actor. The FSM aborts at `validating`
    // BEFORE any append. (Mirrors the brain-source deny — restore is never self-service.)
    const restoreAppender = liveRestoreAppender(appender, sourceId);
    const outcome = await runRestore(
      {
        acquireCheckpoint: async () => undefined,
        authorize: () => ({ effect: "deny" as const, reason: "actor is not an approver" }),
        appender: restoreAppender,
        rebuildProjection: async () => {
          throw new Error("rebuildProjection must NEVER run on a denied restore");
        },
      },
      snap,
      "intern-9",
      "orchestration",
    );

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("validating");

    // NO RestoreEvent reached the REAL chain: this test's count is unchanged and no restore marker appears.
    const after = mine(await reader(), sourceId);
    expect(after.length).toBe(beforeCount);
    expect(after.some((e) => String(e.event.action).startsWith("system.restore:"))).toBe(false);
  });

  it("(e) fail-closed: a read/fold error mid-restore aborts WITHOUT emitting RestoreCompleted (no half-completed illusion)", async () => {
    const sourceId = `lr1-failclosed-${Date.now()}`;
    const appender = eventAppender(sourceId);
    const reader = createEntriesReader({ endpoint: ENDPOINT as string });

    const M = await appendChain(appender, ["created", "claimed", "completed"], sourceId);

    // A SnapshotRecord whose anchor is PAST this source's head (out of range): when rebuildProjection folds
    // the live chain up to this anchor, `replay`'s out-of-range guard throws -> the FSM aborts at
    // `rebuilding`, AFTER RestoreInitiated but WITHOUT RestoreCompleted (restore.ts's "no half-completed").
    const outOfRange = M + 999;
    const snap: SnapshotRecord = {
      snapshotId: randomUUID(),
      sequence: outOfRange,
      wormHeadHash: HEAD,
      memoryVersion: 1,
      ledgerLsn: null,
      sandboxRef: null,
      externalEffectsSinceBaseline: [] as readonly ExternalEffect[],
    };

    const restoreAppender = liveRestoreAppender(appender, sourceId);
    const outcome = await runRestore(
      {
        acquireCheckpoint: async () => undefined,
        authorize: () => ({ effect: "allow" as const, reason: "admin approved restore" }),
        appender: restoreAppender,
        rebuildProjection: async (s: SnapshotRecord) => {
          const live = mine(await reader(), sourceId);
          // replay fails closed on an out-of-range cut-point -> rebuildProjection rejects -> abort.
          replayTimeline(live.map(toReplayEvent), s.sequence);
        },
      },
      snap,
      "approver-1",
      "orchestration",
    );

    expect(outcome.status).toBe("aborted");
    expect(outcome.phase).toBe("rebuilding");

    // FAIL-CLOSED on the REAL chain: RestoreInitiated IS on the chain (the attempt is honestly recorded),
    // but RestoreCompleted must NEVER be — no half-completed restore illusion.
    const after = mine(await reader(), sourceId);
    const initiated = after.filter((e) => e.event.action === "system.restore:RestoreInitiated");
    const completed = after.filter((e) => e.event.action === "system.restore:RestoreCompleted");
    expect(initiated.length).toBe(1); // the attempt was forward-recorded
    expect(completed.length).toBe(0); // ...and NEVER completed (the security spine of restore.ts)
  });
});
