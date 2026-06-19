/**
 * Canonical, deterministic serialization + content-addressing for AuditEvent.
 *
 * The hash-chained WORM evidence kernel (P1, SLICE-P0-005 contract) needs a byte-for-byte
 * reproducible representation so an independent verifier can recompute the same content address.
 * `JSON.stringify` is unsuitable: key order is not guaranteed and it silently coerces `NaN`/
 * `Infinity` to `null`. This module fixes a recursive key order, rejects non-finite numbers and
 * stray `undefined` (fail-closed; no ambiguous coercion), and redacts BEFORE canonicalizing so the
 * Credential Non-Leak invariant holds in the bytes that get hashed and chained.
 *
 * `serializeAuditEvent` (human/log use) is intentionally left untouched; this is the parallel
 * machine/chain path.
 */
import { createHash } from "node:crypto";
import type { AuditEvent } from "./event.js";
import { redactSecrets } from "./redact.js";

/** Deterministic JSON: keys sorted recursively; no silent coercion of non-serializable values. */
function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalizeAuditEvent: non-finite number is not serializable");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") {
    throw new Error("canonicalizeAuditEvent: bigint is not serializable");
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => {
      if (item === undefined) {
        throw new Error("canonicalizeAuditEvent: undefined array element is not serializable");
      }
      return canonicalJson(item);
    });
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      // An undefined property is "absent" (deterministic, matches JSON object semantics) — omit it.
      if (child === undefined) {
        continue;
      }
      parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
    }
    return `{${parts.join(",")}}`;
  }
  // undefined (top-level), function, symbol
  throw new Error(`canonicalizeAuditEvent: unserializable value of type ${typeof value}`);
}

/** Redaction-safe, deterministic UTF-8 byte serialization of an AuditEvent. */
export function canonicalizeAuditEvent(event: AuditEvent): Uint8Array {
  const redacted = redactSecrets(event);
  return new TextEncoder().encode(canonicalJson(redacted));
}

/**
 * Content address of an AuditEvent: `sha256:<hex>` over its canonical bytes.
 * The algorithm prefix is versioned so P1 can migrate to `blake3:` without rewriting existing
 * chain entries (audit is append-only).
 */
export function contentAddress(event: AuditEvent): string {
  const hex = createHash("sha256").update(canonicalizeAuditEvent(event)).digest("hex");
  return `sha256:${hex}`;
}
