/**
 * PlanPreview — project a StructuredIntent into a zero-skill-readable plain-language plan.
 *
 * Design §2.1 / §5: this is the "看得懂的計畫" the user sees BEFORE any effect (invariant 2,
 * plan-preview-before-effect). It is the content S4 ApprovalInbox renders for explicit approval.
 *
 * Deterministic, NOT an LLM (design §5, capability gate G1 inactive): the preview is templated
 * purely from the StructuredIntent structure, so the same intent always yields a deeply-equal
 * preview (snapshot-verifiable) and there is no hallucination or free-text leak surface.
 *
 * Exit redaction (design §1 invariant 4 / §3.3): every projected string is scrubbed through the
 * audit module's redactor on the way out, so a credential that a mis-wired upstream smuggled into
 * a target/action never appears in the preview. The default redactor is consumed via the audit
 * public barrel (`../../audit/index.js`), never its internals (dependency-cruiser `not-to-internal`).
 *
 * Low coupling (design §2.2): a pure function + an injectable redactor. It imports only the
 * `personal/intent` barrel (the `StructuredIntent` type) and the `audit` barrel (`redactSecrets`),
 * both inward and acyclic; no vendor, no top-level `src/index.ts`.
 */
import { redactSecrets } from "../../audit/index.js";
import type { StructuredIntent } from "../intent/index.js";

/** A plain-language plan a zero-skill user can read and approve. */
export interface PlanPreview {
  /** One-line human summary of what will happen. */
  title: string;
  /** Ordered plain-language steps, one per target. */
  steps: string[];
  /** The concrete resources the plan will touch (the intent's targets). */
  affectedResources: string[];
  /** A coarse risk/scope summary in human words (NOT a precise cost figure — that is R6). */
  summary: string;
}

export interface PlanPreviewDeps {
  /** Exit redactor. Defaults to the audit module's `redactSecrets` (consumed via its barrel). */
  redact?: (s: string) => string;
}

// Human phrasing per known action verb. Unknown verbs fall back to the verb itself, so the
// projection never throws and stays zero-skill friendly (design §5).
const ACTION_VERB: Record<string, string> = {
  backup: "Back up",
  restore: "Restore",
  move: "Move",
  copy: "Copy",
  delete: "Delete",
  share: "Share",
  open: "Open",
};

function verb(action: string): string {
  return ACTION_VERB[action] ?? action;
}

export function renderPlanPreview(
  intent: StructuredIntent,
  deps: PlanPreviewDeps = {},
): PlanPreview {
  const redact = deps.redact ?? redactSecrets;
  const action = verb(intent.action);

  const affectedResources = intent.targets.map((t) => redact(t));
  const steps = affectedResources.map((target, i) => `${i + 1}. ${action} ${target}.`);

  const resourceList = affectedResources.join(", ");
  const title = redact(`${action} ${affectedResources.length} item(s)`);
  const summary = redact(
    `This plan will ${action.toLowerCase()} ${affectedResources.length} resource(s): ${resourceList}. Review the steps below, then approve to proceed.`,
  );

  return { title, steps, affectedResources, summary };
}
