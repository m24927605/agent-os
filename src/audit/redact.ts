/**
 * Redaction-safe helpers for the Audit layer.
 *
 * Defense-in-depth for the Credential Non-Leak invariant: any value stored under a
 * secret-like key is replaced with REDACTED before serialization, so credentials can
 * never reach an audit sink even if they leak into free-form context.
 *
 * NOTE (task-2 hardening): this redacts by KEY name. Scanning string VALUES for
 * high-entropy / secret-shaped material is the full loop #3 follow-up.
 */
export const REDACTED = "[REDACTED]";

const SECRET_KEY =
  /(secret|password|passwd|token|api[_-]?key|apikey|authorization|bearer|credential|private[_-]?key|x-api-key)/i;

export function redactSecrets<T>(value: T): T {
  return redact(value) as T;
}

function redact(value: unknown): unknown {
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
