package verify

import (
	"fmt"

	"github.com/agent-os/kernel/internal/chain"
)

// This file adds the RESTORE-SEMANTIC gate on top of the existing hash-chain verification
// (VerifyChain: sequence -> linkage -> entryHash -> checkpoint). It does NOT touch hash/linkage
// computation — it only inspects already-verified entries for legitimate `system.restore` markers
// (design §45/§47). The forward-append RestoreEvent (src/orchestration/restore.ts:41) is the ONLY
// authorized way the state layer jumps; an offline verifier therefore distinguishes "legitimate
// restore (well-formed, authorized marker)" from "malicious truncation / state jump with no — or a
// malformed — marker", which fails closed.
//
// Capability gate (design §46/§48): this is tamper-EVIDENT, not tamper-PROOF. A stolen kernel
// signing key could forge a well-formed RestoreEvent; moving the restore-approval signature to a
// customer-held KMS (external signing root) is P4. During P0–P3 restore is only tamper-evident.

// restoreEventKind is the marker that an entry carries restore semantics
// (matches RestoreEvent.kind in src/orchestration/restore.ts:42).
const restoreEventKind = "system.restore"

// brainSourceID is the brain identity that must NEVER be the source of a restore: the brain cannot
// restore itself (attester != actor, design §44).
const brainSourceID = "brain"

// VerifyRestoreSemantics scans an already-(linkage-)verified chain and enforces that every entry
// carrying restore semantics (kind == "system.restore") is a WELL-FORMED, AUTHORIZED RestoreEvent:
// the required fields (actor, sourceId, targetSnapshotId, targetSequence) are present and non-empty
// AND sourceId != brain. A restore-semantic entry that is malformed, partial, or brain-sourced is an
// unauthorized state jump -> tamper fail (fail-closed). It is meant to run AFTER VerifyChain passes
// (the caller does sequence/linkage/entryHash/checkpoint first); it adds ONLY the restore gate and
// shares the VerifyResult{Ok,BrokenAt,Reason} contract. Entries with no restore semantics are left
// untouched.
func VerifyRestoreSemantics(c chain.SignedChain) VerifyResult {
	for i := range c.Entries {
		ev, ok := c.Entries[i].Event.(map[string]any)
		if !ok {
			continue // not an object event => cannot be a restore marker
		}
		if kind, _ := ev["kind"].(string); kind != restoreEventKind {
			continue // not a restore-semantic entry => out of scope for this gate
		}
		if reason := restoreMarkerReason(ev); reason != "" {
			return VerifyResult{BrokenAt: i, Reason: reason}
		}
	}
	return VerifyResult{Ok: true, Length: len(c.Entries)}
}

// restoreMarkerReason returns "" if ev is a well-formed, authorized RestoreEvent, otherwise a
// "missing-restore-marker: ..." reason. Fail-closed: any missing/empty required field, a non-numeric
// targetSequence, or a brain source is rejected.
func restoreMarkerReason(ev map[string]any) string {
	for _, field := range []string{"actor", "sourceId", "targetSnapshotId"} {
		if s, _ := ev[field].(string); s == "" {
			return fmt.Sprintf("missing-restore-marker: %s absent or empty", field)
		}
	}
	if _, ok := ev["targetSequence"].(float64); !ok {
		return "missing-restore-marker: targetSequence absent or not a number"
	}
	if ev["sourceId"].(string) == brainSourceID {
		return "missing-restore-marker: brain may not restore (attester != actor)"
	}
	return ""
}
