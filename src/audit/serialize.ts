/**
 * Redaction-safe serialization for audit events.
 * Always route audit output through this function — never JSON.stringify an event directly.
 */
import type { AuditEvent } from "./event.js";
import { redactSecrets } from "./redact.js";

export function serializeAuditEvent(event: AuditEvent): string {
  return JSON.stringify(redactSecrets(event));
}
