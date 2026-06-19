package chain

// Wire/contract types for the signed hash-chain. They live in `chain` (the byte-for-byte contract
// package) so BOTH internal/log (producer) and internal/verify (independent verifier) can use them
// WITHOUT internal/verify importing internal/log — the standalone verifier shares the pinned data
// contract, not the log's internals. JSON tags match the TS SignedChain shape (src/audit/kernel/log.ts)
// so a TS-produced chain round-trips (cross-language conformance is finished in P1-S7).

// LogEntry is one appended record: its sequence, the (already-redacted at canonicalization) event,
// the prevHash it linked to, and its computed entryHash.
type LogEntry struct {
	Sequence  int    `json:"sequence"`
	Event     any    `json:"event"`
	PrevHash  string `json:"prevHash"`
	EntryHash string `json:"entryHash"`
}

// Checkpoint is an Ed25519 signature over the chain HEAD (checkpointBytes(headEntryHash, length)),
// not a per-entry signature.
type Checkpoint struct {
	Length        int    `json:"length"`
	HeadEntryHash string `json:"headEntryHash"`
	Signature     string `json:"signature"` // base64
}

// SignedChain is the externally-verifiable artifact: the entries plus a checkpoint over their head.
type SignedChain struct {
	Entries    []LogEntry `json:"entries"`
	Checkpoint Checkpoint `json:"checkpoint"`
}
