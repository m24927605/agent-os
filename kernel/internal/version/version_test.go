package version

import "testing"

func TestKernelContractVersion(t *testing.T) {
	if got := KernelContractVersion(); got != "agent-os-kernel/v0" {
		t.Fatalf("KernelContractVersion() = %q, want %q", got, "agent-os-kernel/v0")
	}
}
