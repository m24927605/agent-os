/**
 * Evidence kernel v0 — append-only, hash-chained, signed log CONTRACT (TypeScript).
 *
 * This is the typed contract + an in-memory reference implementation that pins the invariants
 * (and conformance constants) for the P1 Go Tessera kernel. It is NOT durable and NOT
 * process-isolated — a control plane sharing this process could still drop a write before append.
 * The real tamper-evidence (separate process/identity, external anchoring, WASM verifier) is P1.
 *
 * Pinned P1-conformance constants (a P1 verifier must match these byte-for-byte):
 *  - genesis prevHash = "sha256:" + 64 zero-hex (a real value, never empty/omitted).
 *  - entryHash = sha256( frame( canonicalBytes(event), prevHash, sequence ) ), `sha256:`-prefixed,
 *    where frame() length-prefixes each part (8-byte big-endian) so concatenation is unambiguous.
 *  - checkpoint = Ed25519 signature over frame( headEntryHash, length ) — a checkpoint over the
 *    chain HEAD (Tessera model), not a per-entry signature.
 */
import { type KeyObject, createHash, sign } from "node:crypto";
import { canonicalizeAuditEvent, contentAddress } from "../canonical.js";
import type { AuditEvent } from "../event.js";

/** prevHash of the first (sequence 0) entry: a fixed, non-empty constant. */
export const GENESIS_PREV_HASH = `sha256:${"0".repeat(64)}`;

export interface AppendReceipt {
  readonly sequence: number;
  readonly contentHash: string;
  readonly prevHash: string;
  readonly entryHash: string;
}

export interface LogEntry {
  readonly sequence: number;
  readonly event: AuditEvent;
  readonly prevHash: string;
  readonly entryHash: string;
}

export interface Checkpoint {
  readonly length: number;
  readonly headEntryHash: string;
  /** Ed25519 signature (base64) over checkpointBytes(headEntryHash, length). */
  readonly signature: string;
}

export interface SignedChain {
  readonly entries: readonly LogEntry[];
  readonly checkpoint: Checkpoint;
}

/** Append-only by construction: there is intentionally NO update/delete method. */
export interface AppendOnlyLog {
  append(event: AuditEvent): AppendReceipt;
}

const textEncoder = new TextEncoder();

function u64be(value: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setBigUint64(0, BigInt(value), false);
  return buf;
}

/** Length-prefixed (8-byte big-endian) concatenation — unambiguous, no separator collisions. */
function frame(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) {
    total += 8 + part.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(u64be(part.length), offset);
    offset += 8;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sha256Prefixed(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** entryHash = sha256( frame( canonicalBytes(event), prevHash, sequence ) ). Pinned for P1. */
export function computeEntryHash(event: AuditEvent, prevHash: string, sequence: number): string {
  return sha256Prefixed(
    frame([
      canonicalizeAuditEvent(event),
      textEncoder.encode(prevHash),
      textEncoder.encode(String(sequence)),
    ]),
  );
}

/** Bytes signed by a checkpoint: frame( headEntryHash, length ). Pinned for P1. */
export function checkpointBytes(headEntryHash: string, length: number): Uint8Array {
  return frame([textEncoder.encode(headEntryHash), textEncoder.encode(String(length))]);
}

/** Reference-only, in-memory log. NOT durable, NOT process-isolated (P1 = real Go Tessera kernel). */
export class InMemoryAppendOnlyLog implements AppendOnlyLog {
  readonly #entries: LogEntry[] = [];
  readonly #privateKey: KeyObject;
  readonly publicKey: KeyObject;

  constructor(keys: { readonly publicKey: KeyObject; readonly privateKey: KeyObject }) {
    this.publicKey = keys.publicKey;
    this.#privateKey = keys.privateKey;
  }

  append(event: AuditEvent): AppendReceipt {
    const sequence = this.#entries.length;
    const prev = this.#entries.at(-1);
    const prevHash = prev ? prev.entryHash : GENESIS_PREV_HASH;
    const entryHash = computeEntryHash(event, prevHash, sequence);
    this.#entries.push({ sequence, event, prevHash, entryHash });
    return { sequence, contentHash: contentAddress(event), prevHash, entryHash };
  }

  entries(): readonly LogEntry[] {
    return this.#entries.slice();
  }

  checkpoint(): Checkpoint {
    const length = this.#entries.length;
    const head = this.#entries.at(-1);
    const headEntryHash = head ? head.entryHash : GENESIS_PREV_HASH;
    const signature = sign(null, checkpointBytes(headEntryHash, length), this.#privateKey).toString(
      "base64",
    );
    return { length, headEntryHash, signature };
  }
}
