/**
 * SnapshotRecord contract + system.snapshot event type (SLICE-P2R-R10-S2; design
 * docs/design/time-travel-snapshot-replay.md §40, §52, §56 Build-list #3).
 *
 * A consistent snapshot's UNIFIED ANCHOR is a single WORM `sequence` (the kernel's single-writer
 * mutex serializes it — design §40); every other constituent state is addressed BY that sequence.
 * `SnapshotRecord` is the strict, type-checked contract for that anchor; `toSnapshotAuditEvent`
 * wraps it into a `kind: "system.snapshot"` event the R2 ingest client can later append into WORM.
 *
 * Hard guarantees (design §52 — highest-risk invariant: snapshot MUST be credential-blind):
 *  - REFERENCE-OR-HASH ONLY: every field is a reference (`sandboxRef`, `ledgerLsn`) or a content
 *    hash (`wormHeadHash`) or an integer anchor — NO raw payload, NO credential, is ever stored.
 *  - `.strict()` FAIL-CLOSED: an unknown/extra key (the seam a smuggled `rawCredential` would use)
 *    makes `parse` throw — unknown shape ⇒ deny (mirrors store.go torn-tail philosophy).
 *  - CREDENTIAL-BLIND, DENY-BY-DEFAULT: `toSnapshotAuditEvent` runs an INJECTED secret detector
 *    over the record's string-valued references; a secret-shaped value ⇒ throw, and a detector
 *    that itself throws ⇒ throw (unknown/error ⇒ deny). The credential walks the runtime broker on
 *    restore, never the snapshot.
 *
 * Low coupling / high cohesion: this module ONLY defines the schema + a pure conversion + the
 * injected-detector guard. It does NO IO, NEVER captures constituent state (that is R10-S3's
 * capture phase) and NEVER appends to WORM (that is the R2 ingest client). The detector is
 * injected, so this module does not import the audit redactor internals and names no vendor; its
 * only dependency is `zod` (already in use). Identity/anchor fields are validated structurally.
 */
import { z } from "zod";

/**
 * ToolManifest.sideEffect classes (design §19): the divergence taxonomy a DivergenceReport reasons
 * over. `none`/`read` are reversible-by-construction; `write` may have a compensate(); `external`
 * has left the system; `irreversible` can never be unwound (ACCEPT-and-record, design §23).
 */
export const SideEffectClass = z.enum(["none", "read", "write", "irreversible", "external"]);
export type SideEffectClass = z.infer<typeof SideEffectClass>;

/**
 * One external-effect entry observed since the snapshot baseline — the seed of a DivergenceReport
 * (design §23). Strict so a smuggled extra key (e.g. a raw payload) fails closed.
 */
export const ExternalEffect = z
  .object({
    tool: z.string().trim().min(1),
    sideEffect: SideEffectClass,
    idempotent: z.boolean(),
  })
  .strict();
export type ExternalEffect = z.infer<typeof ExternalEffect>;

/** A WORM head hash is the audit kernel's content address: `sha256:<64 hex>`. */
const WormHeadHash = z.string().regex(/^sha256:[0-9a-f]{64}$/, {
  message: "wormHeadHash must be a sha256:<64-hex> content address",
});

/**
 * The type-checked anchor of a consistent snapshot. `.strict()` (design §17 boundary hardening):
 * any unknown field ⇒ parse throws, so no raw payload can seep in through an extra key.
 */
export const SnapshotRecord = z
  .object({
    /** Stable identity of this snapshot. */
    snapshotId: z.string().uuid(),
    /** UNIFIED ANCHOR — the single WORM sequence every constituent state is addressed by. */
    sequence: z.number().int().nonnegative(),
    /** WORM head content address @ sequence (R10-S1 timeline anchor source). */
    wormHeadHash: WormHeadHash,
    /** Brain memory version @ sequence (R10-S6 versioned memory; design §27). */
    memoryVersion: z.number().int().nonnegative(),
    /** Postgres PITR LSN, or null = append-REVERSAL ledger mode (design §14). */
    ledgerLsn: z.string().trim().min(1).nullable(),
    /** Declarative Sandbox CRD reference — NOT a memory checkpoint (design §50). */
    sandboxRef: z.string().trim().min(1).nullable(),
    /** External effects since baseline — the DivergenceReport seed (design §23). */
    externalEffectsSinceBaseline: z.array(ExternalEffect).readonly(),
  })
  .strict();
export type SnapshotRecordShape = z.infer<typeof SnapshotRecord>;
// Spec §4 public name; the runtime value above is the schema, this is the inferred type.
export type SnapshotRecord = SnapshotRecordShape;

/**
 * A secret detector: returns `true` when the supplied string is secret-SHAPED. Injected so this
 * module stays decoupled from the audit redactor (the SnapshotAuditGuard, design §52). A detector
 * that THROWS is treated as a positive-by-default (deny-by-default). Named with the `Snapshot`
 * prefix to avoid colliding with the brain-guard `SecretDetector` in the repo's public barrel.
 */
export type SnapshotSecretDetector = (value: string) => boolean;

/** The system.snapshot event — what the R2 ingest client appends into WORM. Readonly throughout. */
export interface SnapshotAuditEvent {
  readonly kind: "system.snapshot";
  readonly snapshotId: string;
  readonly sequence: number;
  readonly wormHeadHash: string;
  readonly memoryVersion: number;
  readonly ledgerLsn: string | null;
  readonly sandboxRef: string | null;
  readonly externalEffectsSinceBaseline: readonly ExternalEffect[];
}

/** Thrown when the credential-blind invariant is violated (or cannot be proven). */
export class CredentialBlindViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialBlindViolation";
  }
}

/** The reference-typed string fields a detector must clear before a record may become an event. */
function scannableStrings(rec: SnapshotRecord): readonly string[] {
  const out: string[] = [rec.snapshotId, rec.wormHeadHash];
  if (rec.ledgerLsn !== null) {
    out.push(rec.ledgerLsn);
  }
  if (rec.sandboxRef !== null) {
    out.push(rec.sandboxRef);
  }
  for (const effect of rec.externalEffectsSinceBaseline) {
    out.push(effect.tool);
  }
  return out;
}

/**
 * Pure conversion of a SnapshotRecord into a `system.snapshot` audit event (NO IO, NO append).
 *
 * Credential-blind gate (deny-by-default, design §52): every reference-typed string field is run
 * through the injected `detector`. A secret-shaped value, OR a detector that throws, raises
 * `CredentialBlindViolation` — the event is NEVER produced when a secret might be present.
 */
export function toSnapshotAuditEvent(
  rec: SnapshotRecord,
  detector: SnapshotSecretDetector,
): SnapshotAuditEvent {
  for (const value of scannableStrings(rec)) {
    let flagged: boolean;
    try {
      flagged = detector(value);
    } catch (cause) {
      // Detector error ⇒ unknown ⇒ deny (fail-closed). We do NOT echo `value` (it may be the
      // secret) — only the field count, never the payload.
      throw new CredentialBlindViolation(
        `snapshot credential-blind check failed closed: detector threw (${
          cause instanceof Error ? cause.name : "unknown"
        })`,
      );
    }
    if (flagged) {
      throw new CredentialBlindViolation(
        "snapshot credential-blind check rejected a secret-shaped reference field",
      );
    }
  }
  return {
    kind: "system.snapshot",
    snapshotId: rec.snapshotId,
    sequence: rec.sequence,
    wormHeadHash: rec.wormHeadHash,
    memoryVersion: rec.memoryVersion,
    ledgerLsn: rec.ledgerLsn,
    sandboxRef: rec.sandboxRef,
    externalEffectsSinceBaseline: rec.externalEffectsSinceBaseline,
  };
}
