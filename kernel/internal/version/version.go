// Package version exposes the kernel contract version. It is a minimal bootstrap
// placeholder (SLICE-P1-001) — NO evidence / crypto / hash-chain / checkpoint logic lives here.
// It sits under internal/ for compiler-level encapsulation: nothing outside the kernel module
// can import it (HARD CONSTRAINT A, Go side).
package version

// KernelContractVersion returns the pinned kernel contract version string.
func KernelContractVersion() string {
	return "agent-os-kernel/v0"
}
