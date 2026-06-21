/**
 * BrainState — the vendor-neutral, versionable contract for the brain's durable memory (design
 * §27-§37). It lets orchestration snapshot/restore the brain's memory WITHOUT understanding Hermes
 * internals (pluggability — dependency-cruiser keeps orchestration from importing hermes), so that a
 * restore to time T also restores the brain to T's memory: memory@T = fold(memory-mutation events
 * <= N), rebuilt by R10-S1's fold engine over the `memory-mutation` BrainEvent subset.
 *
 * Capability-gated (design §30): the default Hermes brain mutates memory in place and emits NO
 * versioned mutation event, so a REAL versioning Hermes adapter is R11 work. This module ships the
 * port + a fake only — it touches no WORM, no vendor, no IO.
 *
 * Highest-risk invariant — credential-blind export (design §52): a brain's learned memory may hold
 * plaintext secrets. `export` screens the serialized memory through an INJECTED secret detector
 * BEFORE emitting it; a secret-shaped value anywhere => fail-closed (THROW — never return a
 * half-redacted object). A detector that throws => deny-by-default. The detector is injected (not
 * imported) so this module stays decoupled from the audit layer's secret detector.
 *
 * Cohesion/coupling: only the memory-versioning contract + redact gatekeeping live here. It imports
 * only zod; it does NOT import audit, does NOT append to the WORM, and carries NO vendor name.
 */
import { z } from "zod";
import type { SecretDetector } from "./credential-guard.js";

/**
 * A single versioned memory entry. Stores ONLY a reference/hash (`valueRef`) — never a raw value —
 * so a memory dump is by construction reference-only. (`valueRef` is still screened by the
 * credential-blind detector on export, since a caller could mistakenly place a secret there.)
 */
export const MemoryEntry = z
  .object({
    key: z.string().min(1),
    valueRef: z.string().min(1),
  })
  .strict();
export type MemoryEntry = z.infer<typeof MemoryEntry>;

/**
 * A snapshot of the brain's memory at a fold sequence. `sequence` maps to
 * `SnapshotRecord.memoryVersion` (R10-S2). `.strict()` so an unknown extra field fails parse.
 */
export const VersionedMemory = z
  .object({
    schemaVersion: z.number().int(),
    sequence: z.number().int().nonnegative(),
    entries: z.array(MemoryEntry).readonly(),
  })
  .strict();
export type VersionedMemory = z.infer<typeof VersionedMemory>;

export const CREDENTIAL_BLIND_DENY =
  "brain memory export contains a secret-shaped value (credential-blind violation) — refuse to emit; " +
  "memory must reference values, and secrets are re-injected by the runtime broker, never from a snapshot";
export const DETECTOR_ERROR_DENY =
  "credential detector errored on memory export — deny-by-default (fail-closed)";

/**
 * A versionable brain memory. `export` MUST be credential-blind (throws on any secret, and on a
 * detector error). `import` MUST reject a mismatched `schemaVersion` (backwards-compat gate).
 */
export interface BrainState {
  readonly schemaVersion: number;
  export(detectSecret: SecretDetector): VersionedMemory;
  import(mem: VersionedMemory): void;
}

/**
 * Credential-blind gate over an already-built VersionedMemory. Fail-closed: a secret anywhere THROWS
 * (never returns a half-redacted object), AND a detector that throws ALSO throws (deny-by-default —
 * never emit because the check itself failed). Implementations call this immediately before
 * returning their export.
 */
export function assertCredentialBlind(
  mem: VersionedMemory,
  detectSecret: SecretDetector,
): VersionedMemory {
  let hasSecret: boolean;
  try {
    hasSecret = detectSecret(mem);
  } catch {
    throw new Error(DETECTOR_ERROR_DENY);
  }
  if (hasSecret) throw new Error(CREDENTIAL_BLIND_DENY);
  return mem;
}

/** Reject an imported memory whose schemaVersion does not match this state's (backwards-compat gate). */
export function assertSchemaVersion(expected: number, mem: VersionedMemory): VersionedMemory {
  const parsed = VersionedMemory.parse(mem);
  if (parsed.schemaVersion !== expected) {
    throw new Error(
      `BrainState.import: schemaVersion mismatch (expected ${expected}, got ${parsed.schemaVersion}) — refusing incompatible memory`,
    );
  }
  return parsed;
}
