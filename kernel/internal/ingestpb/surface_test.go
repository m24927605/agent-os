package ingestpb

import "testing"

// The wire surface must stay append-only by construction: the ONLY mutating RPC is Append (no
// Update/Delete/Rewrite/Upsert/Overwrite), plus the strictly READ-ONLY Checkpoint anchor (R10-S4),
// which captures a consistent snapshot point and never writes/rewrites/truncates. This is an explicit
// allowlist (deny-by-default): any RPC not in this set — or any streaming RPC — fails the guard, so a
// future history-rewriting method cannot slip in unnoticed.
func TestAppendServiceIsAppendOnly(t *testing.T) {
	// methodName -> mutating?  (mutating RPCs may only ever append; read-only RPCs never write.)
	allowed := map[string]bool{
		"Append":     true,  // append-only write surface
		"Checkpoint": false, // read-only consistent-snapshot anchor; never writes
	}
	mutating := 0
	for _, m := range AppendService_ServiceDesc.Methods {
		isMut, ok := allowed[m.MethodName]
		if !ok {
			t.Fatalf("unexpected RPC %q on AppendService — append-only surface forbids unknown RPCs (deny-by-default)", m.MethodName)
		}
		if isMut {
			mutating++
		}
	}
	if len(AppendService_ServiceDesc.Methods) != len(allowed) {
		t.Fatalf("AppendService must expose exactly the allowlisted RPCs (%d), got %d", len(allowed), len(AppendService_ServiceDesc.Methods))
	}
	if mutating != 1 {
		t.Fatalf("exactly one mutating RPC (Append) is permitted, got %d", mutating)
	}
	if len(AppendService_ServiceDesc.Streams) != 0 {
		t.Fatalf("no streaming RPCs expected, got %d", len(AppendService_ServiceDesc.Streams))
	}
}
