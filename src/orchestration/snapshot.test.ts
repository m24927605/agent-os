/**
 * RED-first tests for the SnapshotRecord schema + system.snapshot event type (SLICE-P2R-R10-S2).
 *
 * Behaviour/invariant coverage (one block per spec §5 bullet):
 *  - valid record parses; toSnapshotAuditEvent returns kind === "system.snapshot" and preserves
 *    sequence/wormHeadHash.
 *  - .strict() (adversarial): an unknown field (e.g. a smuggled `rawCredential`) -> parse throws,
 *    so a raw payload can never seep in through an extra key.
 *  - field-type violations: negative `sequence` / `wormHeadHash` missing the `sha256:` prefix /
 *    non-uuid `snapshotId` -> parse fails closed.
 *  - credential-blind: an injected detector scans the assembled record; a secret-shaped value
 *    (hidden in `sandboxRef`) -> reject (deny-by-default; a detector that THROWS also rejects).
 *  - externalEffectsSinceBaseline carrying irreversible/external entries is preserved in full by
 *    toSnapshotAuditEvent (the DivergenceReport seed is never swallowed).
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ExternalEffect,
  SnapshotRecord,
  type SnapshotRecordShape,
  toSnapshotAuditEvent,
} from "./snapshot.js";

const HEAD = `sha256:${"a".repeat(64)}`;

function validRecord(over: Partial<Record<string, unknown>> = {}): SnapshotRecordShape {
  const base = {
    snapshotId: randomUUID(),
    sequence: 42,
    wormHeadHash: HEAD,
    memoryVersion: 7,
    ledgerLsn: "0/16B6C50",
    sandboxRef: "sandbox-crd://golden-image-v3",
    externalEffectsSinceBaseline: [] as readonly ExternalEffect[],
    ...over,
  };
  return SnapshotRecord.parse(base);
}

// A detector that never flags (every field is clean) — used by the happy-path conversions.
const cleanDetector = (_value: string): boolean => false;

describe("SnapshotRecord — valid contract + toSnapshotAuditEvent", () => {
  it("parses a valid record and converts to a system.snapshot event preserving anchors", () => {
    const rec = validRecord();
    const ev = toSnapshotAuditEvent(rec, cleanDetector);
    expect(ev.kind).toBe("system.snapshot");
    expect(ev.sequence).toBe(rec.sequence);
    expect(ev.wormHeadHash).toBe(rec.wormHeadHash);
    expect(ev.snapshotId).toBe(rec.snapshotId);
  });

  it("accepts null ledgerLsn (append-REVERSAL mode) and null sandboxRef", () => {
    const rec = validRecord({ ledgerLsn: null, sandboxRef: null });
    const ev = toSnapshotAuditEvent(rec, cleanDetector);
    expect(ev.ledgerLsn).toBeNull();
    expect(ev.sandboxRef).toBeNull();
  });
});

describe("SnapshotRecord — .strict() rejects unknown fields (adversarial)", () => {
  it("throws when an extra `rawCredential` key is smuggled in", () => {
    expect(() =>
      SnapshotRecord.parse({
        snapshotId: randomUUID(),
        sequence: 1,
        wormHeadHash: HEAD,
        memoryVersion: 0,
        ledgerLsn: null,
        sandboxRef: null,
        externalEffectsSinceBaseline: [],
        rawCredential: "should-not-be-here",
      }),
    ).toThrow();
  });
});

describe("SnapshotRecord — field-type fail-closed", () => {
  it("rejects a negative sequence", () => {
    expect(() => validRecord({ sequence: -1 })).toThrow();
  });

  it("rejects a wormHeadHash missing the sha256: prefix", () => {
    expect(() => validRecord({ wormHeadHash: "b".repeat(64) })).toThrow();
  });

  it("rejects a non-uuid snapshotId", () => {
    expect(() => validRecord({ snapshotId: "not-a-uuid" })).toThrow();
  });

  it("rejects a negative memoryVersion", () => {
    expect(() => validRecord({ memoryVersion: -3 })).toThrow();
  });
});

describe("SnapshotRecord — credential-blind (deny-by-default)", () => {
  it("rejects when the injected detector flags a secret-shaped value (hidden in sandboxRef)", () => {
    // Runtime-assembled secret canary (NO source literal -> secret-scan stays clean).
    const canary = ["sk", "-", "A".repeat(24)].join("");
    const rec = validRecord({ sandboxRef: canary });
    const detector = (value: string): boolean => value.includes("sk-");
    expect(() => toSnapshotAuditEvent(rec, detector)).toThrow();
  });

  it("rejects (deny-by-default) when the detector itself throws", () => {
    const rec = validRecord();
    const exploding = (_value: string): boolean => {
      throw new Error("detector blew up");
    };
    expect(() => toSnapshotAuditEvent(rec, exploding)).toThrow();
  });

  it("does NOT swallow the error: a clean record passes the same detector path", () => {
    const rec = validRecord();
    expect(() => toSnapshotAuditEvent(rec, cleanDetector)).not.toThrow();
  });
});

describe("SnapshotRecord — externalEffectsSinceBaseline preserved (DivergenceReport seed)", () => {
  it("keeps irreversible/external entries intact through toSnapshotAuditEvent", () => {
    const effects: readonly ExternalEffect[] = [
      { tool: "email.send", sideEffect: "irreversible", idempotent: false },
      { tool: "http.post", sideEffect: "external", idempotent: true },
    ];
    const rec = validRecord({ externalEffectsSinceBaseline: effects });
    const ev = toSnapshotAuditEvent(rec, cleanDetector);
    expect(ev.externalEffectsSinceBaseline).toEqual(effects);
    expect(ev.externalEffectsSinceBaseline.length).toBe(2);
  });

  it("rejects an unknown sideEffect class (fail-closed enum)", () => {
    expect(() =>
      validRecord({
        externalEffectsSinceBaseline: [{ tool: "x", sideEffect: "nuke", idempotent: false }],
      }),
    ).toThrow();
  });
});
