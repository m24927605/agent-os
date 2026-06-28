# Auditor Guide: Independently Verify the Evidence Chain

> Audience: a **third-party auditor** whose trust model is *"I trust this small binary, not your
> platform."* This guide shows you how to obtain a verifier you can audit yourself, run it offline
> against a signed evidence chain plus a public key **you** hold, and read its exit code as the single
> source of truth — without trusting Agent OS, its toolchain, or its operator.

Companion reading: the [Verifier Release](./sdk/verifier-release.md) artifact spec (how the binary is
built — versioned, reproducible, cross-platform + WASM) and the [Security Model](./security-model.md)
whitepaper (the `attester ≠ actor` moat in §3.4 and the deploy-gated limits in §9). This guide is
operational; those two are authoritative on design and on the honest limits.

---

## 1. Why you can trust a small binary instead of the platform

The whole point of the evidence chain is that **you do not have to trust the system that produced it.**
Two structural facts make that real:

**The producer cannot rewrite its own history (`attester ≠ actor`).** The kernel control plane can
only *append* — there is no truncate or rewrite RPC (`kernel/internal/server/append.go`). The party
that *acts* can never *attest to* or *rewrite* what it did. So the chain you are handed is, by
construction, append-only.

**The verifier is independent of the producer.** The standalone verifier
(`kernel/cmd/verifier`, recompute core in `kernel/internal/verify/verify.go`) depends only on
`internal/verify` + `internal/chain`. It **never imports the producer** (`internal/log`) — the package
doc states this is "true by construction" and `depguard` enforces it in the build. The verifier does
not call the platform, does not phone home, and does not need the system online. It takes two inputs —
a chain file and **a public key you supply** — recomputes the entire hash chain offline, and tells you
whether it holds.

This is the trust pivot: **the public key is supplied by you, the auditor, at verification time** — not
embedded by us, not pinned, not fetched. You decide which key is authoritative (see §6 on how far that
guarantee currently reaches), and the binary does nothing but math you can re-derive. You can read its
~200 lines of Go, build it yourself from source, or reproduce the released artifact byte-for-byte
(§2). What you choose to trust is a small, auditable, offline tool — not Agent OS.

---

## 2. Obtain a verifier you trust

You have two paths. Both end with a binary (or `.wasm`) that depends on nothing but its two inputs.

### Option A — build it yourself from source (strongest)

The package is **private and in-repo** (`package.json` is `"name": "agent-os"`, `"private": true`), so
`npm install agent-os` does **not** resolve. Clone the repo and build the verifier from the Go source
you can read:

```bash
# from the repo root, with a Go toolchain installed
pnpm run verifier:release
```

This runs `scripts/build-verifier-release.sh` and writes to `dist/verifier/` (gitignored):

| Artifact | Platform |
|---|---|
| `verifier-linux-amd64` | Linux x86-64 |
| `verifier-linux-arm64` | Linux ARM64 |
| `verifier-darwin-amd64` | macOS Intel |
| `verifier-darwin-arm64` | macOS Apple Silicon |
| `verifier-windows-amd64.exe` | Windows x86-64 |
| `verifier.wasm` | browser / any WASM host (runs offline) |
| `SHA-256SUMS` | SHA-256 of every artifact above (sorted, stable) |

Prefer to invoke `go build ./cmd/verifier` directly from the `kernel/` directory — same result. The
source is small enough to read end-to-end before you trust it: `kernel/cmd/verifier/main.go` (the CLI +
exit codes), `verify_bytes.go` (parse the chain JSON + the Ed25519 key), and
`kernel/internal/verify/verify.go` (the recompute).

### Option B — reproduce a released artifact (verify someone else's build)

The release is **reproducible by construction**: building the same commit twice yields a
**byte-identical** binary and the **same `SHA-256SUMS`**. This is achieved with `-trimpath` (strips
absolute build paths), `CGO_ENABLED=0` (no host C toolchain), `-ldflags "-s -w -buildid="` (strips the
non-deterministic build id), `GOFLAGS=-mod=readonly` + `GOTOOLCHAIN=local` (pinned toolchain), and a
**deterministic version label** (the git commit, not a wallclock timestamp).

To convince yourself a binary you were handed is the one that comes from the source you read: build the
same commit yourself and diff the checksums.

```bash
cd dist/verifier && shasum -a 256 -c SHA-256SUMS   # validate the artifacts against the manifest
./verifier-darwin-arm64 --version                  # print the embedded release/version label
```

> The release **version label ≠ the chain contract version**. The label identifies the *artifact*; the
> chain's contract version is provided independently by `internal/version.KernelContractVersion()`
> (`agent-os-kernel/v0`). The release build does not touch it.

---

## 3. Run the verifier against a chain + public key

You need two files:

- **the chain** — a `SignedChain` JSON: `{ "entries": [...], "checkpoint": {...} }`
  (shape in `kernel/internal/chain/types.go`).
- **the public key** — the Ed25519 verification key, **PEM or raw DER**. You supply this. It is the
  trust-root for the signature check.

### Native CLI

```bash
./verifier-darwin-arm64 --chain chain.json --pubkey auditor-pub.pem
# exit 0 = chain intact
# exit 1 = chain broken (reorder / insert / tamper / gap / invalid signature)
# exit 2 = bad input (unparseable chain JSON, or a missing/non-Ed25519 public key)
```

On success it prints `ok length=<N>` to stdout; on a break it prints `broken at <i>: <reason>` to
stderr; on bad input it prints `error: <detail>` to stderr. **Only the exit code is the contract** —
the `reason` text is human-readable, not a stable surface. `--pubkey` is required; if omitted the
verifier exits `2`. If `--chain` is omitted the verifier reads the chain from **stdin** (so you can
pipe it).

### WASM (browser / Node, fully offline)

Load Go's `wasm_exec.js` (ships with the Go distribution) plus `verifier.wasm`, then call the single
global function the WASM entrypoint (`kernel/cmd/verifier/wasm_main.go`) exposes:

```js
const r = globalThis.agentosVerifyChain(chainJsonString, pubKeyPemString);
// r = { ok: boolean, length: number, brokenAt: number, reason: string }
```

The WASM path is **I/O only** — it delegates to the exact same `verifyChainBytes` core the native CLI
uses (`verify_bytes.go`), so there is **zero duplication of verification logic** between the two. It is
fail-closed the same way: a missing argument, a wrong-typed argument, a malformed chain, or a bad key
yields `ok:false` and **never** `ok:true`. This is the path to run a verification entirely in an
air-gapped browser tab with no platform contact at all.

### Via the in-repo CLI (convenience wrapper)

The repo CLI exposes `agentos verify --chain <f> --pubkey <f>`, which **spawns** the same standalone
binary across a process boundary and **relays its exit code verbatim** (`src/cli/main.ts`). It defaults
to a binary named `agentos-verifier` on `PATH` and lets you point at a specific artifact with the
`AGENTOS_VERIFIER_BIN` environment variable. This wrapper imports **no** verification logic of its own —
it is purely argv → spawn → exit-code. For an independent audit, prefer running the binary directly
(Option A/B); the wrapper is for in-repo convenience and yields the same 0/1/2.

---

## 4. What the verifier proves — and what it does not

### What a `exit 0` proves

The verifier recomputes the chain in a fixed check order — **sequence → linkage → entry-hash →
checkpoint length → head → Ed25519 signature** (`verify.go`):

1. **Sequence monotonicity.** Entry `i` must have `sequence == i`. A gap or reorder fails.
2. **Hash linkage.** Each entry's `prevHash` must equal the previous entry's `entryHash`, anchored at a
   fixed genesis (`"sha256:" + 64 zeros`). A reorder, insertion, or deletion breaks linkage.
3. **Entry-hash integrity.** It recomputes `entryHash = sha256( frame( canonicalBytes(event), prevHash,
   decimalSequence ) )` (`ComputeEntryHash` / `EntryHashFromCanonical` in `kernel/internal/chain/chain.go`)
   and compares. **Any change to an entry's content — a single character — produces a different hash and
   fails the recompute.** The framing is length-prefixed (8-byte big-endian per part) so concatenation is
   unambiguous; the canonical serialization is byte-for-byte deterministic (sorted keys,
   JSON.stringify-compatible escaping, JS-identical number formatting) so a Go recompute matches the TS
   producer exactly.
4. **Checkpoint binds the head.** The checkpoint's `length` must equal the number of entries, and its
   `headEntryHash` must equal the last entry's `entryHash`.
5. **Ed25519 signature.** The checkpoint signature must verify against **your** public key over
   `CheckpointBytes(headEntryHash, length)` (`kernel/internal/chain/sign.go`). The checkpoint signs the
   **chain head**, not each entry — so one signature attests to the entire ordered history up to that
   length.

Together, `exit 0` gives you:

- **Tamper-evidence** — no entry's content can be altered without changing its hash and breaking the
  recompute. A one-character edit anywhere ⇒ `exit 1`.
- **Append-only integrity** — no entry can be inserted, deleted, or reordered without breaking the
  `prevHash` linkage or the sequence check.
- **Non-repudiation of the head** — the holder of the private key signed *this exact ordered history of
  this exact length*. A different history would need a different valid signature.

**Try it.** Flip one byte in any `event` field in `chain.json` and re-run: the verifier exits `1` with
`entry hash mismatch (tampered content)`. Swap two entries: `prev-hash linkage broken`. Drop an entry:
`sequence not monotonic`. Re-sign with the wrong key, or hand it the wrong `--pubkey`: `checkpoint
signature invalid`. It is **fail-closed** — it never exits `0` unless the chain fully verifies.

### What it does NOT prove

- **It does not prove the events are *true* or *complete*.** It proves the chain it was given is
  internally consistent and signed. It cannot tell you that *every* real-world action was logged — only
  that what *is* in the chain was not tampered with or reordered after the fact. (The
  commit-before-effect discipline that makes "intent is recorded before the effect runs" hold is a
  separate platform property described in the Security Model; the verifier does not attest to it.)
- **It does not prove *who* holds the private key, or that the operator cannot hold it.** That is the
  trust-root question — see §6. The verifier proves "this history was signed by the holder of the key
  that matches the pubkey you supplied." Whether that key is operator-inaccessible is a deployment fact,
  not something the binary can establish.
- **It does no key pinning and externalizes no root.** It will faithfully verify against *whatever*
  public key you hand it. Choosing and trusting the right key is your responsibility (and, today, has the
  scope limit in §6).
- **It does not interpret semantics.** `reason` strings are advisory; the exit code (0/1/2) is the only
  contract. A `2` means *bad input* (you gave it something unparseable, or a missing/non-Ed25519 key) —
  it is **not** a verdict on the chain and must never be read as "intact."

---

## 5. Credential-blindness of the bytes you audit

You can audit the chain without ever seeing a customer secret in it — by design, and with a backstop.

Producers redact **before** serialization: credentials are scrubbed by-key (any value under a
secret-like key → `[REDACTED]`) and by-value (secret-shaped substrings scrubbed) before an event is
ever hashed or chained (`src/audit/redact.ts`, `src/audit/canonical.ts`; the Go conformance copy is
`kernel/internal/canonical/canonical.go`).

The kernel then applies a **defense-in-depth ingest backstop** so the WORM bytes are credential-blind
*even if a producer fails*: `RedactCanonicalBytes` (`kernel/internal/canonical/canonical.go`) runs the
by-value secret-shape scrub over the already-canonical JSON bytes **before** they are hashed or
persisted. It is **canonical-preserving and idempotent**:

- **Honest path** (producer already redacted): no secret-shaped substring exists, so the replace is a
  no-op, the bytes are byte-identical, the `entryHash` is unchanged, and chain continuity holds.
- **Threat path** (a buggy or hostile producer leaks a credential-shaped value): the matched substring is
  replaced with `[REDACTED]` *before* it can reach the chain hash or the durable WORM record.

So a raw credential cannot land in the WORM bytes you audit, even if an upstream producer is broken.
(The backstop deliberately does **only** the by-value scrub — by-key structural redaction would require
unmarshal/re-marshal and risk canonical drift; the full by-key+by-value redaction is the producer's job,
and the kernel backstops the credential-*value* shapes.) See Security Model §3.2–§3.3 for the full
Credential Non-Leak invariant.

---

## 6. The trust-root, stated honestly (how far the guarantee reaches today)

This matters most to you, so it is stated plainly. The verifier's signature check is exactly as strong
as the protection of the **private key** that signed the checkpoint. The kernel signs through a
`CheckpointSigner` **port** that has *no method returning private-key material*
(`kernel/internal/signer/signer.go`) — the control plane computes the bytes to sign and hands them to a
signer; it cannot extract the key.

**What ships in-tree today:** an *in-process* signer (the key is operator-held *in* the kernel process)
and a *command* signer (the key is out of process). With the in-process signer, `attester ≠ actor`
holds **to the process boundary** — the control plane / brain cannot sign or rewrite, but the *operator
of the process* could in principle reach the key.

**What is deploy-gated (TR2):** operator-**inaccessible** externalization — AWS/GCP KMS, an HSM /
PKCS#11 token, or a TPM/SGX-attested signer — is a **drop-in third implementation of the same two-method
contract**, but standing it up is a **deployment fact, not done in-tree** (Security Model §9, item 1).

So, precisely: **today the cryptographic guarantee reaches to the process boundary.** The verifier
proves the history was signed by the key matching your pubkey and was not tampered with or reordered;
full *operator-unforgeability* — the assurance that even the operator could not have produced a
different valid history — depends on your deployment binding the signing key to a KMS/HSM/remote-attested
root and on you obtaining the pubkey through a trustworthy channel. The released verifier deliberately
does **no** pubkey pinning and externalizes **no** root; that is a future surface, not claimed here.

Account for this when you write your opinion: the math is sound and reproducible; the *strength of the
non-repudiation* is bounded by where the private key lives in the deployment you are auditing.

---

## 7. Quick reference

| You want to… | Do this |
|---|---|
| Build a verifier you can audit | clone the in-repo package, `pnpm run verifier:release` (or `go build ./cmd/verifier` in `kernel/`) |
| Confirm a handed-to-you binary matches the source | reproduce the build on the same commit, diff `SHA-256SUMS` |
| Validate artifacts against the manifest | `cd dist/verifier && shasum -a 256 -c SHA-256SUMS` |
| Verify a chain (native) | `./verifier-<os>-<arch> --chain chain.json --pubkey your-pub.pem` |
| Verify a chain (offline browser) | load `verifier.wasm` + `wasm_exec.js`, call `agentosVerifyChain(chainJSON, pubKeyPEM)` |
| Read the result | **exit 0 = intact, 1 = broken, 2 = bad input** (only the code is the contract) |

Authoritative companions: [Verifier Release](./sdk/verifier-release.md) ·
[Security Model](./security-model.md) (`attester ≠ actor` in §3.4; deploy-gated limits in §9).
