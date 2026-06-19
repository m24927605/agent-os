// Package store is the durable, append-only persistence for the evidence kernel. Records are written
// as [8-byte big-endian body-length][body] and committed only AFTER fsync. There is intentionally no
// Update/Delete/Truncate/Seek-write surface (append-only by construction). Load() replays the file
// and REJECTS a torn/truncated tail (fail-closed) rather than silently returning a shorter "looks
// intact" chain. It is pure persistence: it does NOT import internal/sequence, internal/verify, or
// internal/chain — the caller orchestrates the startup self-check (feed Load()'s records to verify).
package store

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// LogRecord is one durably persisted record. Sequence/PrevHash/EntryHash/Event mirror the chain
// LogEntry (so the caller can reconstruct a SignedChain for verification); SourceID/SourceSeq are
// out-of-leaf ingest-completeness metadata — they are NOT fed to computeEntryHash and do NOT affect
// the entryHash / cross-language conformance. Event is already redacted before it reaches the store.
type LogRecord struct {
	Sequence  int    `json:"sequence"`
	Event     any    `json:"event"`
	PrevHash  string `json:"prevHash"`
	EntryHash string `json:"entryHash"`
	// SourceID is an ingest-completeness NAMESPACE identifier; it is persisted verbatim (NOT
	// redacted, not in the leaf) — callers must keep it a non-secret identifier, never a sink for
	// free-form/secret-bearing data.
	SourceID  string `json:"sourceId"`
	SourceSeq uint64 `json:"sourceSeq"`
}

// maxRecordSize bounds a single record's body so a torn/forged length prefix cannot trigger an
// unbounded allocation (OOM / panic). 64 MiB is far above any real redacted audit event.
const maxRecordSize = 64 << 20

// Store is a durable append-only file. Not safe for concurrent Append from multiple goroutines.
type Store struct {
	path string
	f    *os.File
}

// Open opens (creating if needed) the durable log for append.
func Open(path string) (*Store, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	return &Store{path: path, f: f}, nil
}

// Append durably persists rec as [8-byte BE len][body] and returns the committed end offset ONLY
// after fsync succeeds. There is no update/delete/truncate.
func (s *Store) Append(rec LogRecord) (committedOffset uint64, err error) {
	body, err := json.Marshal(rec)
	if err != nil {
		return 0, fmt.Errorf("store: marshal record: %w", err)
	}
	var lenBuf [8]byte
	binary.BigEndian.PutUint64(lenBuf[:], uint64(len(body)))
	if _, err := s.f.Write(lenBuf[:]); err != nil {
		return 0, fmt.Errorf("store: write length: %w", err)
	}
	if _, err := s.f.Write(body); err != nil {
		return 0, fmt.Errorf("store: write body: %w", err)
	}
	if err := s.f.Sync(); err != nil { // fsync — only now is the record committed
		return 0, fmt.Errorf("store: fsync: %w", err)
	}
	off, err := s.f.Seek(0, io.SeekCurrent)
	if err != nil {
		return 0, err
	}
	return uint64(off), nil
}

// Close closes the underlying file.
func (s *Store) Close() error { return s.f.Close() }

// Load replays every record and recomputes the head entryHash. A torn/truncated tail (partial length
// prefix, or a length prefix whose body is short) is a hard error — never silently dropped.
func (s *Store) Load() (records []LogRecord, headEntryHash string, err error) {
	f, err := os.Open(s.path)
	if err != nil {
		return nil, "", err
	}
	defer func() { _ = f.Close() }()
	info, err := f.Stat()
	if err != nil {
		return nil, "", err
	}
	fileSize := info.Size()
	r := bufio.NewReader(f)

	head := "sha256:" + zeros64 // genesis if empty (kept local; see note below)
	var offset int64
	for {
		var lenBuf [8]byte
		n, rerr := io.ReadFull(r, lenBuf[:])
		if rerr == io.EOF && n == 0 {
			break // clean end
		}
		if rerr != nil {
			return nil, "", fmt.Errorf("store: torn tail: partial length prefix (%d bytes): %w", n, rerr)
		}
		offset += 8
		bodyLen := binary.BigEndian.Uint64(lenBuf[:])
		// Bound BEFORE allocating: a forged/torn length prefix must error, never panic or OOM.
		if bodyLen > maxRecordSize {
			return nil, "", fmt.Errorf("store: torn tail: implausible body length %d (max %d)", bodyLen, maxRecordSize)
		}
		if int64(bodyLen) > fileSize-offset {
			return nil, "", fmt.Errorf("store: torn tail: body length %d exceeds remaining %d bytes", bodyLen, fileSize-offset)
		}
		body := make([]byte, bodyLen)
		if _, rerr := io.ReadFull(r, body); rerr != nil {
			return nil, "", fmt.Errorf("store: torn tail: truncated body (want %d): %w", bodyLen, rerr)
		}
		offset += int64(bodyLen)
		var rec LogRecord
		if jerr := json.Unmarshal(body, &rec); jerr != nil {
			return nil, "", fmt.Errorf("store: corrupt record: %w", jerr)
		}
		records = append(records, rec)
		head = rec.EntryHash
	}
	return records, head, nil
}

// zeros64 is the 64 zero-hex of the genesis prevHash (kept local so store imports no chain package).
const zeros64 = "0000000000000000000000000000000000000000000000000000000000000000"
