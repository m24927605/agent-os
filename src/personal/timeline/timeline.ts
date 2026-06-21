/**
 * TaskTimeline — a READ-ONLY plain-language projection of the WORM audit chain.
 *
 * Design invariant 3 (docs/design/personal-shell.md §1): the timeline's ONLY source is the audit
 * kernel's append-only `LogEntry[]`. This module is a pure `fold` over that chain — it appends
 * nothing, opens no side store, and cannot rewrite history. Inputs are `readonly`; the function
 * returns a fresh array of fresh objects, so a caller can never use the projection to reach back
 * and mutate the WORM entries.
 *
 * Low coupling (design §2.2): consumes `LogEntry`/`AuditEvent` types + `redactSecrets` ONLY through
 * the `src/audit` barrel — never a deep import (dependency-cruiser `not-to-internal`). Vendor-free.
 *
 * Exit redaction (design §3.3, invariant 4): every projected string passes through a redactor
 * (the audit barrel `redactSecrets` by default) so a secret that leaked into a non-secret field
 * (e.g. `resource`) never reaches a human-readable surface.
 */
import type { AuditEvent, LogEntry } from "../../audit/index.js";
import { redactSecrets } from "../../audit/index.js";

export interface TimelineEvent {
  /** ISO-8601 timestamp copied from the underlying AuditEvent. */
  readonly at: string;
  /** One-line plain-language summary of what happened. */
  readonly headline: string;
  /** Plain-language detail (resource + policy reason). */
  readonly detail: string;
  /** The WORM chain sequence — never renumbered, never invented. */
  readonly sequence: number;
}

export interface BuildTimelineOptions {
  /** Project only entries whose AuditEvent.taskId matches (no renumbering of sequence). */
  readonly taskId?: string;
  /** Exit redactor; defaults to the audit barrel `redactSecrets`. */
  readonly redact?: (text: string) => string;
}

function headlineFor(event: AuditEvent): string {
  if (event.result === "denied" || event.policyDecision.effect === "deny") {
    return `被拒絕：${event.action} ${event.resource}`;
  }
  if (event.result === "error") {
    return `發生錯誤：${event.action} ${event.resource}`;
  }
  return `已完成：${event.action} ${event.resource}`;
}

function detailFor(event: AuditEvent): string {
  return `動作「${event.action}」作用於「${event.resource}」，原因：${event.policyDecision.reason}`;
}

/**
 * Fold a WORM `LogEntry[]` into plain-language `TimelineEvent[]`, ordered by chain `sequence`.
 *
 * Pure & read-only: returns a brand-new array of brand-new objects; the input chain is never
 * mutated, reordered in place, added to, or dropped from.
 */
export function buildTaskTimeline(
  entries: readonly LogEntry[],
  opts: BuildTimelineOptions = {},
): TimelineEvent[] {
  const redact = opts.redact ?? redactSecrets;
  // Copy before sorting so we never reorder the caller's (possibly frozen) input in place.
  const selected = entries.filter(
    (entry) => opts.taskId === undefined || entry.event.taskId === opts.taskId,
  );
  const ordered = [...selected].sort((a, b) => a.sequence - b.sequence);
  return ordered.map((entry) => ({
    at: redact(entry.event.timestamp),
    headline: redact(headlineFor(entry.event)),
    detail: redact(detailFor(entry.event)),
    sequence: entry.sequence,
  }));
}
