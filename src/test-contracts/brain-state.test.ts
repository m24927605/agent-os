/**
 * BrainState PORT CONTRACT — versioned, exportable/importable brain memory (design §27-§37).
 *
 * Why: to restore the system to time T the brain's memory must also be T's memory (memory@T =
 * fold(memory-mutation events <= N)) — restored from a clean point, NOT carrying "future" memory.
 * The abstraction lets orchestration snapshot/restore the brain WITHOUT understanding Hermes
 * internals (pluggability — orchestration never imports hermes).
 *
 * Safety (highest risk, design §52): `export` is credential-blind. The injected secret detector
 * screens the serialized memory BEFORE it is emitted; a secret-shaped value anywhere => fail-closed
 * (deny export, never emit a half-redacted object). A detector that throws => deny-by-default.
 *
 * Pluggability: the contract runs over >=1 fake impl (ScriptedBrainState), proving round-trip
 * export/import equivalence. The detector here is the repo's REAL one (audit/redact `redactSecrets`).
 */
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../audit/redact.js";
import { type BrainState, ScriptedBrainState, VersionedMemory } from "../runtime/brain/index.js";

// The repo's real secret detection, expressed as a boolean: a value contains a secret iff redacting
// it changes it.
const detectSecret = (value: unknown): boolean =>
  JSON.stringify(redactSecrets(value)) !== JSON.stringify(value);

const SCHEMA_VERSION = 1;

const makeClean = (): BrainState =>
  new ScriptedBrainState(SCHEMA_VERSION, [
    { key: "user-model", valueRef: "memref:sha256:abc123" },
    { key: "lesson:retry-policy", valueRef: "memref:sha256:def456" },
  ]);

describe("BrainState contract — ScriptedBrainState", () => {
  it("export -> import round-trips to an equivalent state (memory@T is restorable)", () => {
    const a = makeClean();
    const exported = a.export(detectSecret);
    VersionedMemory.parse(exported); // throws if malformed

    const b = new ScriptedBrainState(SCHEMA_VERSION, []);
    b.import(exported);
    expect(b.export(detectSecret)).toEqual(exported);
  });

  it("import REJECTS a VersionedMemory whose schemaVersion does not match (backwards-compat gate)", () => {
    const a = makeClean();
    const exported = a.export(detectSecret);
    const wrongVersion = { ...exported, schemaVersion: SCHEMA_VERSION + 1 };

    const b = new ScriptedBrainState(SCHEMA_VERSION, []);
    expect(() => b.import(wrongVersion)).toThrow(/schemaVersion/i);
  });

  it("export carries the fold sequence (maps to SnapshotRecord.memoryVersion)", () => {
    const a = new ScriptedBrainState(SCHEMA_VERSION, [], 42);
    expect(a.export(detectSecret).sequence).toBe(42);
  });
});

describe("BrainState credential-blind export (highest-risk invariant, design §52)", () => {
  // Secret-shaped canary built at runtime (NOT a source literal, so scan_secrets.sh stays clean),
  // hidden in the entry's valueRef field — proving by-SHAPE detection screens the whole serialized
  // memory, not only a known key. Matches the redact SECRET_VALUE pattern sk-[A-Za-z0-9]{16,}.
  const secretRef = `sk-${"d".repeat(24)}`;

  it("FAILS-CLOSED (denies export, no object) when an entry contains a secret-shaped value", () => {
    const evil = new ScriptedBrainState(SCHEMA_VERSION, [{ key: "leaked", valueRef: secretRef }]);
    expect(() => evil.export(detectSecret)).toThrow(/credential-blind|secret/i);
  });

  it("DENIES-BY-DEFAULT (no object) when the secret detector itself throws", () => {
    const a = makeClean();
    expect(() =>
      a.export(() => {
        throw new Error("detector blew up");
      }),
    ).toThrow(/deny-by-default|fail-closed|detector/i);
  });

  it("catches a secret nested in a deep entry (not just the first)", () => {
    const evil = new ScriptedBrainState(SCHEMA_VERSION, [
      { key: "ok", valueRef: "memref:sha256:clean" },
      { key: "deep", valueRef: secretRef },
    ]);
    expect(() => evil.export(detectSecret)).toThrow(/credential-blind|secret/i);
  });

  it("lets a clean memory (reference strings only) export normally", () => {
    expect(() => makeClean().export(detectSecret)).not.toThrow();
  });
});

describe("VersionedMemory schema is .strict()", () => {
  it("rejects an unknown extra field", () => {
    const a = makeClean();
    const exported = a.export(detectSecret);
    expect(() => VersionedMemory.parse({ ...exported, extra: "nope" })).toThrow();
  });

  it("requires entries to carry non-empty key + valueRef", () => {
    expect(() =>
      VersionedMemory.parse({
        schemaVersion: SCHEMA_VERSION,
        sequence: 0,
        entries: [{ key: "", valueRef: "x" }],
      }),
    ).toThrow();
  });
});
