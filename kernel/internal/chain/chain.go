// Package chain builds the hash-chain primitives on top of canonical bytes: length-prefixed
// framing, entryHash, and checkpoint bytes. It conforms byte-for-byte to the TS reference
// (src/audit/kernel/log.ts). It depends on internal/canonical (one direction only; depguard forbids
// the reverse) and must never maintain chain STATE (that is internal/log, a later slice).
package chain

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/agent-os/kernel/internal/canonical"
)

// GenesisPrevHash is the prevHash of the sequence-0 entry: a fixed, non-empty constant.
// Matches TS GENESIS_PREV_HASH = "sha256:" + 64 zero-hex.
var GenesisPrevHash = "sha256:" + strings.Repeat("0", 64)

// Frame length-prefixes each part with an 8-byte big-endian length (unambiguous concatenation),
// matching the TS frame().
func Frame(parts ...[]byte) []byte {
	total := 0
	for _, p := range parts {
		total += 8 + len(p)
	}
	out := make([]byte, 0, total)
	var lenBuf [8]byte
	for _, p := range parts {
		binary.BigEndian.PutUint64(lenBuf[:], uint64(len(p)))
		out = append(out, lenBuf[:]...)
		out = append(out, p...)
	}
	return out
}

func sha256Prefixed(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// ComputeEntryHash = sha256( frame( canonicalBytes(event), prevHash, decimal(sequence) ) ),
// "sha256:"-prefixed. sequence/length are encoded as their DECIMAL STRING UTF-8 bytes (matching TS
// String(sequence)), not binary integers.
func ComputeEntryHash(event any, prevHash string, sequence int) (string, error) {
	cb, err := canonical.CanonicalBytes(event)
	if err != nil {
		return "", err
	}
	return sha256Prefixed(Frame(cb, []byte(prevHash), []byte(strconv.Itoa(sequence)))), nil
}

// CheckpointBytes = frame( headEntryHash, decimal(length) ) — the bytes a checkpoint signs (over the
// chain HEAD, not per-entry).
func CheckpointBytes(headEntryHash string, length int) []byte {
	return Frame([]byte(headEntryHash), []byte(strconv.Itoa(length)))
}
