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
- **P1-S4** — `internal/store` (durable append-only file: `[8-byte BE len][body]`, committed only
  after **fsync**; `Load()` REJECTS a torn/truncated tail — no silent truncation; no
  Update/Delete/Truncate surface; pure persistence — imports neither chain nor verify) +
  `internal/sequence` (per-source **monotonic** ingest with **gap** + regression/replay detection,
  0-based first-seen; `Rebuild` reconstructs per-source state from the durable log so a restart
  cannot silently re-open a gap). Startup self-check (feed `Load()` records to `verify`) is the
  caller's job, keeping the verifier independent. `SourceID`/`SourceSeq` are out-of-leaf metadata
  (not hashed, not redacted) — **`SourceID` must be a non-secret namespace id, never a data sink.**
- **P1-S5** — `internal/outbox` (producer-side transactional outbox: durable op-log, per-source
  monotonic sequence allocated by the outbox, fsync-on-commit; at-least-once delivery via an injected
  `Sink` deduped by a **durable delivered-set** so a crash between commit and delivery never
  double-appends; `CheckDedup` returns no-op on same hash, `ErrContentConflict` on a different hash;
  append-only, no Update/Delete) + `internal/commitgate` (`Guard`: durably commit evidence BEFORE
  running the side effect; commit failure or non-durable receipt → effect never runs, fail-closed).
- **P1-S6** — kernel as a **separate process** (`cmd/kernel`, a gRPC server) with an **append-only**
  ingest contract: `internal/server` enforces append-only + monotonic per-source sequence and fails
  closed (typed `AppendError` SEQUENCE_GAP/SEQUENCE_REPLAY/MALFORMED + a durable denial audit under
  source `kernel.audit`) on replay/gap/malformed — a rejected rewrite never mutates the store, and
  the response oneof is never `CODE_UNSPECIFIED`. It durably commits (fsync) BEFORE returning a
  `Receipt` (commit-before-effect at the RPC boundary). `internal/client` exposes ONLY `Append` (no
  mutate method; raw stub not exposed). The control plane reaches the kernel ONLY via the proto
  (zero shared internals); `internal/verify` may not import server/client (depguard `verify-no-log`).
- **P1-S6a** — gRPC/protobuf dependency + codegen foundation (zero behavior): `proto/ingest.proto`
  defines an **append-only** `AppendService` (exactly one RPC, `Append`; no Update/Delete/Rewrite),
  generated into `internal/ingestpb/` (committed); `pnpm run proto:gen` regenerates, `pnpm run
  proto:check` (in `verify`) fails on drift / skips if the protoc toolchain is absent. Deps pinned to
  `grpc v1.64.0` + `protobuf v1.34.2` (go-1.22-compatible; see `docs/guardrails.md`). Generated
  `*.pb.go` are excluded from golangci-lint. Server/client BEHAVIOR is P1-S6.
- **P2R-R2-S5** — TS face of the same contract (no consumer). `pnpm run proto:gen` additionally
  emits a **type-only** TS stub (`ts-proto onlyTypes=true`; **zero runtime imports, no RPC client** —
  a devDependency codegen tool, never in `dependencies`) into `src/runtime/_generated/ingest/`
  (committed, generated; excluded from biome). `pnpm run proto:check` adds a mirror TS drift gate:
  regenerate to a temp dir and `diff` against the committed stub — drift OR a missing/failed
  `protoc-gen-ts_proto` exits non-zero (fail-closed). The stub is a leaf contract: nothing imports it
  until the S6 transport adapter. See `docs/design/ingest-client-sync-commit.md`.
- **P1-S7** — TS↔Go **cross-language conformance** + Phase-1 exit-criteria closeout (zero kernel
  behavior). `conformance/cross-lang/` holds a language-neutral chain fixture (pure data — the only
  cross-plane coupling). A TS-produced chain verifies in the Go verifier and a Go-produced chain
  verifies in the TS `verifyChain`; each language detects tamper/reorder/gap/bad-sig in the OTHER's
  chain; the two fixtures (same seeded key + same events) agree byte-for-byte on entryHash/head/
  signature; the SPKI↔raw ed25519 key encoding round-trips. `pnpm run verify:p1-exit` re-runs all six
  roadmap §3.1 exit criteria as a fail-closed aggregation.

**Not yet (do not assume):** identity hardening is NOT done — **mTLS / tenant-keyed process identity /
gateway-per-tenant = P3** (the current process boundary + typed proto *demonstrates* attester≠actor;
production identity isolation is P3). TS-side control-plane integration = **P2**; real Tessera tile-log
+ RFC-3161 anchoring + WASM verifier = **P4** (the cross-lang fixture is the future WASM verifier's
conformance vector). Cross-equality is bounded to sequence ≤ 2^53−1 (TS number limit; true-uint64
cross-equality deferred).

## Run

```
cd kernel && env -u GOROOT CGO_ENABLED=0 go test ./...     # or: pnpm run verify:go (from repo root)
```
(The `env -u GOROOT CGO_ENABLED=0` prefix works around this dev box's gvm/brew GOROOT mismatch and a
macOS x509-cgo LC_UUID crash — see `docs/guardrails.md`.)
