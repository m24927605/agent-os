package server

import (
	"encoding/json"
	"sync"

	"github.com/agent-os/kernel/internal/chain"
	"github.com/agent-os/kernel/internal/store"
)

// StoreAuditSink durably records denied Append attempts to an append-only store under the reserved
// source "kernel.audit" (a separate monotonic stream). It records only the source_id, rejected
// sequence, code, and a static reason — never the rejected payload — so it cannot leak credentials.
type StoreAuditSink struct {
	mu    sync.Mutex
	store *store.Store
	seq   uint64
}

// NewStoreAuditSink rebuilds the audit sequence from the durable store.
func NewStoreAuditSink(st *store.Store) (*StoreAuditSink, error) {
	records, _, err := st.Load()
	if err != nil {
		return nil, err
	}
	var seq uint64
	for _, r := range records {
		if r.SourceID == "kernel.audit" && r.SourceSeq+1 > seq {
			seq = r.SourceSeq + 1
		}
	}
	return &StoreAuditSink{store: st, seq: seq}, nil
}

func (a *StoreAuditSink) RecordDenial(sourceID string, sequence uint64, code, detail string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	ev := map[string]any{
		"kind": "ingest.denied", "sourceId": sourceID, "sequence": sequence,
		"code": code, "reason": detail, "result": "denied",
	}
	body, _ := json.Marshal(ev)
	_, err := a.store.Append(store.LogRecord{
		Sequence: int(a.seq), Event: ev, EntryHash: chain.ContentAddress(body),
		SourceID: "kernel.audit", SourceSeq: a.seq,
	})
	a.seq++
	return err
}
