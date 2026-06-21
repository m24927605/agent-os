/**
 * Fail-closed AppendResponse parser (slice P2R-R2-S1).
 *
 * The SINGLE point where a kernel AppendResponse oneof{receipt|error} is turned into an
 * AppendReceipt. Mirrors kernel/internal/client/client.go:38-48: a present `receipt` is the ONLY
 * success path. Deny-by-default — an `error` branch, an empty oneof (both undefined), and the
 * proto-zero CODE_UNSPECIFIED (proto/ingest.proto:31) all THROW. We never return a falsy receipt:
 * the commitgate treats a resolved value as a durable commit, so any non-receipt MUST reject
 * (docs/design/ingest-client-sync-commit.md §6).
 *
 * The thrown message may carry the typed code + the kernel's static detail (proto/ingest.proto:37
 * guarantees detail is "static reason / field name only"), but this parser NEVER constructs a
 * message from canonical_event content.
 */
import type { AppendReceipt } from "../kernel/log.js";
import type { AppendResponseShape } from "./transport.js";

/** proto3 zero value for AppendError.Code — always a deny, never success (proto/ingest.proto:31). */
const CODE_UNSPECIFIED = "CODE_UNSPECIFIED";

/**
 * Parse a kernel AppendResponse into a durable AppendReceipt, or THROW (fail-closed).
 *
 * Returns the receipt ONLY when `resp.receipt` is present. Every other path — `error` set, empty
 * oneof, or CODE_UNSPECIFIED — throws with a static deny reason (code + detail; never event bytes).
 */
export function parseAppendResponse(resp: AppendResponseShape): AppendReceipt {
  const { error } = resp;
  if (error !== undefined) {
    // CODE_UNSPECIFIED is the proto zero — explicitly denied, never treated as success.
    throw new Error(`append denied: ${error.code} (${error.detail})`);
  }

  const receipt = resp.receipt;
  if (receipt === undefined) {
    // Empty oneof: neither receipt nor error. Deny-by-default — never synthesize a falsy receipt.
    throw new Error("append: empty response (fail-closed)");
  }

  // Success: the kernel durably committed and returned all four chain fields.
  return {
    sequence: receipt.sequence,
    contentHash: receipt.contentHash,
    prevHash: receipt.prevHash,
    entryHash: receipt.entryHash,
  };
}

export { CODE_UNSPECIFIED };
