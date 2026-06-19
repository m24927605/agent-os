# kernel/ — Go evidence kernel (P1)

The durable, append-only, hash-chained, signed WORM audit spine, in a separate process / identity /
language (Go). It conforms **byte-for-byte** to the TS reference contract pinned in SLICE-P0-005
(`src/audit/kernel/*.ts`, `src/audit/canonical.ts`, `src/audit/redact.ts`): genesis prevHash,
8-byte-BE `frame()`, `entryHash`, checkpoint over HEAD. The Go side conforms to TS; TS is never
changed to match Go.

Boundaries (HARD CONSTRAINT A) are enforced at the command level by `internal/` (compiler
encapsulation) + depguard (`.golangci.yml`), wired into `pnpm run verify:go`.

## What exists so far (scope is honest — do not over-claim)

- **P1-S1** — Go module bootstrap; `verify:go` is enforcing.
- **P1-S2** — `internal/canonical` (redact-before-canonicalize, JS-compatible deterministic JSON) +
  `internal/chain` (Frame, ComputeEntryHash, CheckpointBytes, GenesisPrevHash, Ed25519 sign/verify),
  locked by TS-produced golden vectors (`testdata/golden-vectors.json`).
- **P1-S3** — `internal/log` (in-memory `InMemoryAppendOnlyLog`, append-only by construction — no
  Update/Delete; persists the **redacted** event) + `internal/verify` (`VerifyChain`, standalone:
  it does NOT import `internal/log`) + `cmd/verifier` (CLI: exit 0 intact, non-zero on
  tamper/reorder/gap/bad-sig/unparseable/missing-key — fail-closed).

**Not yet (do not assume):** `internal/log` is **in-memory, reference-only — NOT durable and NOT
process-isolated**. Durable WORM storage + monotonic per-source sequence + gap detection = **P1-S4**;
transactional outbox + synchronous-commit-before-effect = **P1-S5**; gRPC ingest + kernel as a
separate process where the control plane can only append = **P1-S6**; two-way TS↔Go cross-language
conformance = **P1-S7**; real Tessera tile-log + RFC-3161 anchoring + WASM verifier = **P4**.

## Run

```
cd kernel && env -u GOROOT CGO_ENABLED=0 go test ./...     # or: pnpm run verify:go (from repo root)
```
(The `env -u GOROOT CGO_ENABLED=0` prefix works around this dev box's gvm/brew GOROOT mismatch and a
macOS x509-cgo LC_UUID crash — see `docs/guardrails.md`.)
