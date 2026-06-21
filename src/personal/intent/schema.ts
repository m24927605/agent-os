/**
 * StructuredIntent — the SOLE structure + validator for a zero-skill user's text request.
 *
 * Personal surface (design §2.2): the IntentGateway converges a line of natural language + an
 * AgentContext into this strict, deny-by-default, auditable shape. Downstream slices (S3 plan
 * preview, S4 approval → P2-I governed pipeline) consume StructuredIntent; nothing reads the raw
 * text again. `.strict()` makes parsing fail-closed: an unexpected field is a parse error, never a
 * silently-tolerated extra.
 *
 * `rawText` carries the user's input AFTER entry-redaction (design §1 invariant 4 / §3.3): the raw
 * secret never reaches this field. We re-validate that here so a mis-wired caller cannot smuggle an
 * obvious credential shape into the persisted/audited intent.
 */
import { z } from "zod";
import { AgentContext } from "../../iam/ids.js";

const nonEmpty = z.string().trim().min(1);

// High-signal secret SHAPES, aligned with src/audit/redact.ts. If a redactor failed to scrub a
// credential into rawText, fail closed at parse time rather than persist it.
const SECRET_VALUE =
  /sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/;

export const StructuredIntent = z
  .object({
    /** The single verb the gateway resolved (e.g. "backup"). */
    action: nonEmpty,
    /** What the action operates on. Required + non-empty: an action with no target is ambiguous. */
    targets: z.array(nonEmpty).min(1),
    /** Validated caller identity, carried through to the governed pipeline (S4). */
    context: AgentContext,
    /** User input AFTER entry-redaction; must not contain an obvious secret shape (fail-closed). */
    rawText: nonEmpty.refine((s) => !SECRET_VALUE.test(s), {
      message: "rawText must be redacted before reaching StructuredIntent",
    }),
  })
  .strict();

export type StructuredIntent = z.infer<typeof StructuredIntent>;
