/**
 * Standalone chain verifier — recomputes the hash-chain, detects tamper/reorder/gap, and verifies
 * the Ed25519 checkpoint signature. It trusts ONLY the entries + checkpoint it is handed (plus the
 * public key); it does not read a log instance's internal state. It shares the pinned hash/frame
 * functions with the log on purpose — recomputing with the SAME definition is the point.
 */
import { type KeyObject, verify } from "node:crypto";
import { GENESIS_PREV_HASH, type SignedChain, checkpointBytes, computeEntryHash } from "./log.js";

export type VerifyResult =
  | { ok: true; length: number }
  | { ok: false; brokenAt: number; reason: string };

export function verifyChain(chain: SignedChain, publicKey: KeyObject): VerifyResult {
  const { entries, checkpoint } = chain;

  let prevHash = GENESIS_PREV_HASH;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) {
      return { ok: false, brokenAt: i, reason: "missing entry" };
    }
    if (entry.sequence !== i) {
      return {
        ok: false,
        brokenAt: i,
        reason: `sequence not monotonic: expected ${i}, got ${entry.sequence}`,
      };
    }
    if (entry.prevHash !== prevHash) {
      return { ok: false, brokenAt: i, reason: "prev-hash linkage broken (reorder/insert/tamper)" };
    }
    if (computeEntryHash(entry.event, entry.prevHash, entry.sequence) !== entry.entryHash) {
      return { ok: false, brokenAt: i, reason: "entry hash mismatch (tampered content)" };
    }
    prevHash = entry.entryHash;
  }

  if (checkpoint.length !== entries.length) {
    return { ok: false, brokenAt: entries.length, reason: "checkpoint length mismatch" };
  }
  const head = entries.at(-1);
  const headEntryHash = head ? head.entryHash : GENESIS_PREV_HASH;
  if (checkpoint.headEntryHash !== headEntryHash) {
    return { ok: false, brokenAt: entries.length, reason: "checkpoint head mismatch" };
  }
  const signatureOk = verify(
    null,
    checkpointBytes(checkpoint.headEntryHash, checkpoint.length),
    publicKey,
    Buffer.from(checkpoint.signature, "base64"),
  );
  if (!signatureOk) {
    return { ok: false, brokenAt: entries.length, reason: "checkpoint signature invalid" };
  }

  return { ok: true, length: entries.length };
}
