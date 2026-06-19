package ingestpb

import "testing"

// The wire surface must be append-only: exactly one RPC, named Append.
func TestAppendServiceIsAppendOnly(t *testing.T) {
	if n := len(AppendService_ServiceDesc.Methods); n != 1 {
		t.Fatalf("AppendService must expose exactly 1 RPC (append-only), got %d", n)
	}
	if m := AppendService_ServiceDesc.Methods[0].MethodName; m != "Append" {
		t.Fatalf("the only RPC must be Append, got %q", m)
	}
	if len(AppendService_ServiceDesc.Streams) != 0 {
		t.Fatalf("no streaming RPCs expected, got %d", len(AppendService_ServiceDesc.Streams))
	}
}
