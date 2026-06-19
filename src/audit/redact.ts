/**
 * Redaction-safe helpers for the Audit layer.
 *
 * Defense-in-depth for the Credential Non-Leak invariant. Two complementary passes, applied
 * BEFORE serialization (so credentials never reach an audit sink / hash chain):
 *  - by-KEY: any value stored under a secret-like key is replaced with REDACTED.
 *  - by-VALUE (SLICE-P0-007): any string value is scanned for high-signal secret SHAPES and the
 *    matched substrings are replaced with REDACTED — so a secret leaked into a non-secret-named
 *    field (e.g. `resource`) is still scrubbed. High-signal patterns only (low false-positive),
 *    aligned with scripts/scan_secrets.sh; this is NOT entropy scoring.
 */
export const REDACTED = "[REDACTED]";

const SECRET_KEY =
  /(secret|password|passwd|token|api[_-]?key|apikey|authorization|bearer|credential|private[_-]?key|x-api-key)/i;

// Matched substrings are replaced with REDACTED. Patterns contain regex metacharacters, so this
// source does not match itself under scan_secrets.sh.
const SECRET_VALUE =
  /sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g;

function scrubSecretValues(value: string): string {
  return value.replace(SECRET_VALUE, REDACTED);
}

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return scrubSecretValues(value);
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? REDACTED : redact(val);
    }
    return out;
  }
  return value;
}
