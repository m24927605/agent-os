# Security, Trust & Compliance Whitepaper — the SEATBELT story

> **Audience:** the security reviewer an enterprise hands this document to before adopting Agent OS.
> **Scope:** what Agent OS defends, where each defense is enforced *in code*, and — honestly — what is
> not yet enforced in-tree. Every claim below is grounded in a named source file you can read; nothing
> here is aspirational unless it is explicitly flagged in [§9 Deploy-gated limits](#9-deploy-gated-limits-read-this).
>
> **Companion docs:** [Composition Root Guide](./sdk/composition-root-guide.md) (how to actually run a
> surface — the adopter contracts that keep these guarantees holding are §4 there),
> [Tool Manifest Authoring](./sdk/tool-manifest-authoring.md) (the `sideEffect`/`containment` fields
> that drive the gates), [Verifier Release](./sdk/verifier-release.md) (independently verify the
> evidence chain — the attester≠actor moat).
>
> **Credibility statement.** The invariants in this document are command-verified: `pnpm run verify`
> exits 0 with **1808 TypeScript tests passing** (182 files; 29 skipped) plus the Go/Python/cross-tenant
> gates, and the design has been through an adversarial multi-expert review. "Only command output is
> truth" is the house rule — where a guarantee is real today it is a test; where it is deploy-provided
> it is flagged as such.

---

## 1. The one-paragraph threat model

Agent OS governs a **computer that operates itself by intent**. The component that decides *what to do*
— the LLM "brain" — is treated as **UNTRUSTED**. It is assumed to be **prompt-injectable**: an attacker
who can influence the model's input (a malicious web page it reads, a poisoned document, a crafted email)
is assumed to be able to make the brain *propose* any action it likes. The design therefore never asks
"is the brain behaving?" It asks "**can a misbehaving brain cause an un-governed effect, leak a
credential, escape its allowlist, or rewrite its own history?**" — and the answer must be *no* by
construction, not by the brain's good behavior.

The trust boundary is sharp: the brain may **propose**; only the governance core may **decide, record,
and act**; and only an *independent* party (not the brain, not the actor) may **attest or restore**. The
rest of this document is the set of mechanisms that hold that boundary, each named to the file that
enforces it.

---

## 2. The governed edge — every effect funnels through one pipeline

There is exactly one place a brain-proposed action becomes a real effect: `runGovernedToolCall`
(`src/orchestration/pipeline.ts`). It is an ordered, fail-closed sequence; each gate short-circuits to a
*denied* outcome, and the effect runs **only** after every gate passes **and** the WORM commit receipt is
in hand:

```
screen (credential-blind)
  → authorize (PDP — sole deny authority)
    → approval (fail-closed; only when the allow carries requiresApproval)
      → cost.reserve (budget hard-cap)
        → commit-before-effect (append AuditEvent, await receipt)
          → effect (the only place a real side effect happens)
            → cost.commit  +  boundary-ledger append (for external effects)
```

The pipeline is vendor-neutral by dependency injection: it imports only port *types* and never names a
specific tool family, so exec / browser / action connectors all compose the same edge
(`src/orchestration/pipeline.ts:14–21`, `GovernedToolCallDeps`). The guarantees below hold **only if an
adopter routes every effect through this edge** — that adopter contract is spelled out in the
[Composition Root Guide §1 and §4](./sdk/composition-root-guide.md).

---

## 3. The four invariants, as defense properties — and where each lives in code

The four SEATBELT invariants are not slogans; each is a concrete code mechanism with a test behind it.

### 3.1 Deny-by-default / fail-closed

**Property:** an action runs only if an explicit allow rule matches; anything unknown, malformed, or
errored is denied. There is no silent allow.

**Where it's enforced:**

- **The Policy Decision Point** (`src/policy/evaluate.ts`). `evaluatePolicy` is the PDP seed and is
  fail-closed at every branch:
  - a request that fails schema validation → `deny("malformed policy request (fail-closed)")`
    (`evaluate.ts:116–120`);
  - **deny-precedence**: a matching deny rule wins over every allow; a *malformed* deny rule is **not**
    silently skipped — it returns `deny("malformed deny rule (fail-closed)")`, because "if I cannot
    prove a deny rule does not match, I must deny" (`evaluate.ts:127–144`);
  - **deny-by-default**: no matching allow ⇒ `deny("no matching allow rule (deny-by-default)")`
    (`evaluate.ts:173`);
  - any thrown exception during evaluation ⇒ `deny("policy evaluation error (fail-closed)")`
    (`evaluate.ts:174–176`).
  - Allow-rule globs reject a wildcard-only pattern (`*`, `**`) as dangerously broad
    (`matchResource`, `evaluate.ts:74–77`), while a wildcard-only *deny* over-matches on purpose
    (fail-safe: it can only deny more — `matchDenyResource`, `evaluate.ts:85–96`).
- **The advisory fold** (`src/policy/dedup.ts`). The committed stack can carry several policy engines
  (the PDP, an AGT-derived advisor, OpenShell OPA/Z3). They are **demoted to advisories**: `combineDecisions`
  is **any-deny-wins** and treats *anything that is not exactly `"allow"`* — a deny, or a malformed/garbage
  effect from an untrusted advisor — as a deny (`dedup.ts:61–86`). A secondary that **throws or rejects**
  yields a synthetic deny (`evaluateSecondaries`, `dedup.ts:33–51`). A broken or hostile advisor can only
  ever deny *more*, never grant.
- **The defense-in-depth egress and host-write gates** (`src/policy/egress-allowlist.ts`,
  `src/policy/host-write-target.ts`). For a tool whose credential-blind projection carries network hosts
  or write targets, the authorize closure folds in a per-tool deny-all-by-default decision:
  - `matchEgressAllow` is **exact-match** (case-insensitive, trim+lowercase normalize) — *not* suffix or
    substring; an empty host or empty allowlist denies (`egress-allowlist.ts:38–44`). So
    `evil-api.allowed.example` and `api.allowed.example.evil.com` do **not** match `api.allowed.example`.
  - `matchHostWriteTarget` is **lexical canonicalization** + under-root containment with a `/` boundary —
    `/allowedX` is *not* under `/allowed`, `/allowed/../etc/passwd` normalizes out and is rejected, a
    relative/empty/root-escaping path or an empty allowlist all deny (`host-write-target.ts:52–95`).
- **The lease lifecycle FSM** (`src/credential/fsm.ts`) and **restore FSM** (`src/orchestration/restore.ts`):
  every transition not explicitly listed is denied; an unlisted, terminal, expired, or malformed transition
  returns `denied`, never throws through.

**Why it's trustworthy:** none of these gates depends on the brain. The PDP keys only on
`action`/`resource`/`tenant` and **ignores** the brain-supplied governance projection entirely
(`src/policy/types.ts:20–26` — "The PDP IGNORES it").

### 3.2 Credential-blind

**Property:** raw secrets never reach the audit sink, the hash chain, the immutable WORM, logs, snapshots,
or any reasoning input. The system can *use* a credential at the egress point without the brain or the
record ever holding it.

**Where it's enforced (three layers, defense-in-depth):**

1. **The placeholder model — the brain holds a placeholder, never a value.** `src/credential/inject.ts`
   projects an `injected`, not-yet-expired lease into a provider-env map whose **values are always
   placeholder strings** (`openshell:resolve:env:<KEY>`), never a secret (`inject.ts:40–78`). It "never
   touches a literal secret, never queries a secret store, and never resolves a placeholder back to a
   value" (`inject.ts:6–9`). The lease FSM and inject both **fail closed on expiry independent of state**
   (an `injected` lease past `expiresAtMs` is refused before any placeholder is produced — `fsm.ts:167–169`,
   `inject.ts:69–71`), closing the "injected-but-not-yet-expired" window. The auditable `LeaseEvent` is
   **reference-only** — `bundleRef` + state delta, *no* key values — so redacting it is a no-op by
   construction (`fsm.ts:34–49`).

2. **Producer-side redaction before serialization.** `src/audit/redact.ts` runs two passes *before* any
   event is canonicalized or hashed: **by-KEY** (any value under a secret-like key name → `[REDACTED]`)
   and **by-VALUE** (high-signal secret *shapes* — `sk-…`, `ghp_…`, `AKIA…`, `xox[baprs]-…`, PEM private
   keys, JWTs, Google `ya29.`/`AIza` tokens, `Bearer …` — scrubbed even inside a non-secret-named field).
   `src/audit/canonical.ts` redacts **before** canonicalizing (`canonical.ts:64–68`), so credentials never
   reach the bytes that get hashed and chained.

3. **The kernel ingest redaction backstop — the WORM is credential-blind even if a producer fails.** This
   is the load-bearing one for an enterprise reviewer: credential-blindness of the immutable log must
   **not** be producer-trust alone. On the Go kernel's append path
   (`kernel/internal/server/append.go:111–117`), *before anything is hashed or persisted*, the validated
   canonical bytes pass through `canonical.RedactCanonicalBytes` (`kernel/internal/canonical/canonical.go:50–64`).
   That function applies the **same** by-value secret-shape scrub as the TS side (the regex is kept
   byte-identical across the two languages — `canonical.go:23–32`) directly over the canonical JSON bytes,
   and is **canonical-preserving + idempotent**:
   - *Honest path* (the producer already redacted): no secret-shaped substring ⇒ `ReplaceAll` is a no-op ⇒
     bytes are byte-identical ⇒ the entry hash and chain continuity are intact.
   - *Threat path* (a buggy or compromised producer leaks a credential-shaped value): the matched substring
     is replaced with `[REDACTED]` **before** it can reach the chain hash or the durable WORM record.

   So a raw credential cannot land in the WORM even if an upstream producer is broken or hostile.

4. **Snapshots and boundary records are reference-or-hash only.** A `SnapshotRecord` is `.strict()` — an
   unknown extra key (the seam a smuggled `rawCredential` would use) makes parse throw — and
   `toSnapshotAuditEvent` runs an injected secret detector over every reference-typed string field,
   throwing `CredentialBlindViolation` on a hit *or* if the detector itself throws (deny-by-default)
   (`src/orchestration/snapshot.ts:14–24`, `58–163`). The external-effect **boundary ledger** event records
   only an **allow-list** of safe derived fields (`boundarySummaryFromProjection`,
   `pipeline.ts:351–370`): userinfo-stripped host-only `networkHosts`, lexical `writeTargets`,
   `operationClass`, and boolean shape flags — and **deliberately drops** `argv0` / `argvRedacted` / `argc`,
   which are only *shape*-redacted and could carry a `?access_token=…` URL query or `--password=…`
   (`pipeline.ts:264–271`, `337–349`).

### 3.3 Commit-before-effect

**Property:** no external effect becomes observable until its AuditEvent is durably recorded and a receipt
is in hand. There is no "best-effort run, log later" — the un-recorded effect is structurally impossible.

**Where it's enforced:**

- **The TS commit gate** (`src/commitgate/guard.ts`). `commitBeforeEffect` appends the event, **awaits** the
  receipt, and *only then* invokes the effect (`guard.ts:57–74`). On any append failure or timeout the effect
  is **not** invoked and the call resolves `aborted` (fail-closed, `guard.ts:67–69`). The adapter contract is
  explicit and load-bearing: signal a failed append by **rejecting** (or never resolving) — a resolved
  promise, *even with an empty receipt*, counts as a durable commit and lets the effect run (`guard.ts:15–23`).
  This is the single most important adopter contract; it is restated as the un-recorded-effect guard in the
  [Composition Root Guide §4.1](./sdk/composition-root-guide.md).
- **The pipeline wiring** (`src/orchestration/pipeline.ts:214–231`). The pipeline calls `commitBeforeEffect`,
  and on `aborted` it **releases** the cost reservation (not commits) so a reserve-then-abort cannot erode the
  hard cap, and returns `denied@commit` — the effect never ran and no spend occurred.
- **The kernel RPC boundary** (`kernel/internal/server/append.go`). The kernel durably commits (fsync, via
  the store) **before** returning a Receipt; if the durable commit fails it returns an internal error and
  **no** Receipt — "commit-before-effect at the RPC boundary" (`append.go:1–5`, `126–132`). The ingest is
  append-only and monotonic per source: a sequence gap or a replay is denied and *the denial itself is
  durably recorded* before the typed error is returned (`append.go:83–109`).

### 3.4 attester ≠ actor (the WORM moat)

**Property:** the party that *acts* can never *attest to* or *rewrite* its own history, and the attestation
is **independently verifiable** by a third party who does not trust the platform. The brain can never
self-attest or self-restore.

**Where it's enforced:**

- **The kernel control plane can only Append.** `kernel/internal/server/append.go` "is the in-path
  enforcement point that makes 'attester != attested actor' hold: the control plane can only Append, never
  rewrite" (`append.go:1–6`). There is no truncate/rewrite RPC.
- **The kernel process is structurally unable to hold the signing key.** Checkpoint signing goes through a
  `CheckpointSigner` **port** (`kernel/internal/signer/signer.go:47–53`): the kernel computes the bytes to
  sign and hands them to the signer; the interface has *no* method that returns private-key material
  (`signer.go:38–46`). With the in-process signer the key is operator-held in-process (attester≠actor holds
  *to the process boundary* — the control plane cannot sign); with the command signer the key is out of
  process. The KMS/HSM externalization that makes the key operator-*inaccessible* is **TR2 / deploy-provided**
  — see [§9](#9-deploy-gated-limits-read-this).
- **Independent verification.** The standalone verifier (`kernel/internal/verify/verify.go`,
  `kernel/cmd/verifier`) recomputes the hash chain (sequence → linkage → entry-hash → checkpoint length →
  head → Ed25519 signature) and **does not import the producer** (`internal/log`) — "the verifier is
  independent of the producer is true by construction" (`verify.go:1–7`). The **Ed25519 public key is
  supplied by the auditor at verification time**, not by us (`docs/sdk/verifier-release.md`). It fails closed
  (any reorder/tamper/gap/invalid-signature ⇒ non-zero exit). A reproducible, versioned, cross-platform +
  WASM build is documented in [Verifier Release](./sdk/verifier-release.md), so an auditor can run a verifier
  they trust, offline, in any environment.
- **The brain can never self-restore.** In `src/orchestration/restore.ts`, a restore whose `sourceId` is a
  brain source (`brain`, `hermes`) is **denied at the `validating` phase, before any append**
  (`restore.ts:131–163`) — "the brain can NEVER self-restore; restore is admin/approver-signed."

---

## 4. The boundary ledger + the restore anchor cross-validation

Two records make the moat *prove* consistency rather than merely assert it.

**The external-effect boundary ledger** (`src/orchestration/pipeline.ts:254–297`). When an effect is
classified `external` (a seal-punching containment — `network-egress` / `host-fs-write`, set by the
composition root from the tool manifest's `containment`), and the effect **executes**, the pipeline appends
a *distinct post-effect* boundary WORM event — a stronger record than the commit-before-effect intent: "the
irreversible external fact happened," not just "about to run." This is **audit-only**: it runs only on the
executed path (so there is never a boundary-without-effect), it never changes allow/deny (the PDP stays the
sole deny authority), and a failed boundary append surfaces a `boundary:"append-failed"` marker rather than
faking "didn't run" (`pipeline.ts:273–297`). It carries only the safe `boundarySummary` allow-list described
in §3.2.

**The restore anchor cross-validation** (`src/orchestration/restore.ts`, with `src/orchestration/snapshot.ts`).
A `SnapshotRecord` records, at its `sequence`, the live WORM head content address (`wormHeadHash`) and the
brain `memoryVersion` — a **unified anchor**. Before rebuilding to a snapshot, the restore FSM's
`verifying-anchor` phase reads the **live chain's** anchor at that sequence *under the global lock* (a
consistent read) and **refuses — fail-closed, pre-`initiated`, with no append** — if the recorded head hash
or memory version no longer matches the live chain there (`restore.ts:182–203`). A stale or *forged* snapshot
anchor cannot drive a rebuild. The comparison lives in the reviewed FSM, never delegated.

---

## 5. Authorization model — the policy rules ARE the authorization (no separate RBAC, by design)

> **A clear statement for your reviewer's checklist:** **Authorization in Agent OS is the Policy Decision
> Point** — the allow/deny rules evaluated by `src/policy/evaluate.ts`. Agent OS **deliberately has NO
> separate RBAC layer.** The policy rules *are* the authorization model. `src/iam` is **identity-only**
> (`src/iam/ids.ts`: branded, non-empty `TenantId` / `ProjectId` / `TaskId` / `ActorId` / `RequestId` /
> `SandboxId`, and the OCSF `AgentContext` aggregate). **This is an intentional design choice, not a gap.**

Rationale you can hand to a reviewer: a single, fail-closed, deny-by-default PDP with explicit allow/deny
rules — scoped by `tenantId` for cross-tenant isolation (`evaluate.ts:42–45`, `146–172`: a tenant-A allow
never grants tenant-B; cross-tenant defaults to deny) — is the *one* authority. Adding a parallel RBAC layer
would create a second place that says "yes," and the design's core principle is that there is exactly one
deny authority (everything else is advisory, folded any-deny-wins — §3.1). Roles, if an adopter wants them,
are expressed *as policy rules* keyed on the identity in `AgentContext`, not as a separate subsystem with its
own grant semantics. There is no role/permission grant code in `src/` to audit because there is intentionally
none.

---

## 6. Recovery is forward-only — there is no undo

An executed external effect is **irreversible** by assumption. Agent OS therefore does **not** offer undo or
log truncation; recovery is **forward-only snapshot/restore/replay**:

- `restore-to-S` is **not** a truncation. It emits **two new forward** `RestoreEvent`s into the append-only
  chain — `RestoreInitiated` then `RestoreCompleted` — and rebuilds the state-layer projection in between;
  the original events stay on the chain and forward continues at `M+1` (`src/orchestration/restore.ts:1–37`).
  The only emit seam is the injected `RestoreAppender`, whose **sole capability is `append`** — there is
  deliberately no truncate/rewrite method, so the FSM *physically cannot* rewrite history
  (`restore.ts:73–80`).
- Every phase is fail-closed (`idle → validating → locked → verifying-anchor → initiated → rebuilding →
  completed | aborted`); a failure during `rebuilding` aborts **without** emitting `RestoreCompleted`, so no
  half-completed illusion is ever left on the chain (`restore.ts:220–226`).

### The DivergenceReport

Because external effects cannot be unwound, the operator must *see* them before approving a restore. The
`SnapshotRecord.externalEffectsSinceBaseline` field — a list of `ExternalEffect{ tool, sideEffect, idempotent }`
typed against the divergence taxonomy (`none`/`read`/`write`/`irreversible`/`external`) — is the
**DivergenceReport seed** (`src/orchestration/snapshot.ts:28–47`, `72–73`). It is carried *verbatim* into the
`RestoreInitiated` event (`restore.ts:60–65`, `205–218`) — never swallowed — so the forward chain records
exactly which irreversible effects occurred since baseline that a restore cannot undo.

---

## 7. The composition-root contracts that keep these guarantees holding

The kernel enforces its own boundaries, but it **cannot protect an adopter's adapters**. The guarantees above
hold only if the integrator honors a small set of contracts, fully documented in the
[Composition Root Guide §4](./sdk/composition-root-guide.md). The security-critical ones:

1. **Route every effect through `runGovernedToolCall`.** Never call a substrate/connector directly.
2. **The appender must reject (never resolve falsy) on a failed WORM append** — otherwise the
   un-recorded-effect guard is reopened (`src/commitgate/guard.ts:15–23`).
3. **`AuthorizeDecision` is the sole deny authority** — fold all advisories into the authorize closure via
   `combineDecisions` (any-deny-wins). A secondary can only *narrow*, never grant.
4. **Wire `approve`, or destructive tools are `denied@approval`** (correct fail-closed default, but a wiring
   step you must not forget — `pipeline.ts:183–203`).
5. **Never route the raw governance projection to your own sinks** — it is only *shape*-redacted; the kernel
   protects the boundary WORM, not the other places you might log it.

---

## 8. What `pnpm run verify` actually proves (and what it does not)

`pnpm run verify` is the universal gate. Today it runs (from `package.json`):
`typecheck → lint → build → test → deps:check → proto:check (× several) → verify:go → verify:py →
verify:cross-tenant → launcher:check → secret-scan`. Its exit code is the only accepted proof of "works."
The TS test leg is **1808 passing** (command-verified). The Go leg exercises the kernel append/redaction/chain/
verify packages; `verify:cross-tenant` exercises tenant isolation; `secret-scan` (`scripts/scan_secrets.sh`)
fails the build on a committed secret shape.

**What it does NOT include:** the **live demo scripts are not part of `pnpm run verify`.** The two proven
live demos — a governed Gmail send and a governed real Chromium navigate+read — are standalone
`e2e:live-*` scripts (`package.json`: `e2e:live-gmail` → `scripts/e2e-live-gmail.sh`, `e2e:live-browser` →
`scripts/e2e-live-browser.sh`, etc.) that touch real external systems and credentials, so they are run
out-of-band, never in the offline gate. They are **runtime-direct** (see §9): they demonstrate the full
governed flow end-to-end against real effects, but they exercise the *runtime-direct* credential posture, not
the future sandbox-resolver posture.

---

## 9. Deploy-gated limits (READ THIS)

This codebase's credibility is its honesty. The following are **real, current limitations** — they are
*not* claimed to be solved in-tree today. A reviewer should weigh them explicitly.

1. **Real KMS/HSM trust-root is deploy-provided (TR2).** The kernel signs through a `CheckpointSigner` port
   and never holds raw private-key bytes (`kernel/internal/signer/signer.go`). In-tree we ship an
   **in-process** signer (key is operator-held *in* the process) and a **command** signer (key out of
   process). Operator-*inaccessible* externalization — AWS/GCP KMS, an HSM/PKCS#11 token, a TPM/SGX-attested
   service — is a **drop-in third implementation of the same two-method contract**, but standing it up is a
   **deployment fact (TR2)**, not done in-tree. So today attester≠actor holds **to the process boundary**;
   full operator-unforgeability depends on your deployment's key protection.

2. **Runtime-never-holds-the-token posture (EXEC2) is future; today is runtime-direct.** The placeholder model
   (`src/credential/inject.ts`) and the OpenShell `SecretResolver` are designed so a sandbox resolves a
   placeholder to a real secret *at egress* and the brain/runtime never holds the token. **That sandbox-resolver
   path is not yet wired end-to-end in-tree.** Today the actor holds the credential **directly at the egress
   point** (runtime-direct), including in the live demo scripts. The placeholder seam, the lease FSM, and the
   ingest redaction backstop are real and tested; the "runtime never sees the token" property is **aspirational
   / deploy-and-future-gated**.

3. **Recovery capture phase and `runRestore` composition-root wiring are not yet wired in-tree.** The restore
   FSM (`src/orchestration/restore.ts`), the snapshot contract (`src/orchestration/snapshot.ts`), and the
   anchor cross-validation are implemented and tested, but the **snapshot *capture* phase** (actually
   collecting the constituent state into a `SnapshotRecord`) and the wiring of `runRestore` into a live
   composition root are **not yet present in-tree**. Recovery is forward-only *by design* and the FSM cannot
   rewrite history *by construction*; what is pending is the operational plumbing that feeds and triggers it.

4. **The advisory secondary engines (AGT-derived, OpenShell OPA/Z3) are folded as advisories** — they
   strengthen deny-by-default but the in-tree default path runs the PDP plus any wired secondaries; a full
   external policy engine is an adopter-provided adapter behind the `SecondaryPolicyAdapter` seam
   (`src/policy/dedup.ts`).

5. **The egress and host-write PDP gates are best-effort secondary checks, not the primary seal.** Both
   modules say so explicitly in their headers (`egress-allowlist.ts:56–61`, `host-write-target.ts:18–25`):
   the *primary* no-egress / no-host-write enforcement is the **substrate seal** (the sandbox network policy
   and host-mount + kernel realpath), which is symlink- and IP-literal-resistant. The PDP gates are
   lexical/exact-match defense-in-depth — they catch `..` traversal, sibling-prefix, and unknown hosts, but a
   symlink inside an allowed root or an obfuscated IP-literal could slip the *lexical* check and is caught by
   the substrate, which is a **deployment-provided** component.

---

## 10. Reviewer's quick map (file → guarantee)

| Guarantee | Primary enforcement file(s) |
|---|---|
| Deny-by-default / fail-closed PDP | `src/policy/evaluate.ts` |
| Any-deny-wins advisory fold | `src/policy/dedup.ts` (`combineDecisions`, `evaluateSecondaries`) |
| Egress deny-all-by-default (defense-in-depth) | `src/policy/egress-allowlist.ts` |
| Host-write deny-all-by-default (defense-in-depth) | `src/policy/host-write-target.ts` |
| Credential-blind: placeholder model | `src/credential/inject.ts`, `src/credential/fsm.ts` |
| Credential-blind: producer redaction | `src/audit/redact.ts`, `src/audit/canonical.ts` |
| Credential-blind: **kernel ingest backstop** | `kernel/internal/canonical/canonical.go` (`RedactCanonicalBytes`), `kernel/internal/server/append.go` |
| Commit-before-effect (TS) | `src/commitgate/guard.ts` |
| Commit-before-effect (kernel RPC) | `kernel/internal/server/append.go` |
| attester ≠ actor: append-only control plane | `kernel/internal/server/append.go` |
| attester ≠ actor: signer port (no raw key) | `kernel/internal/signer/signer.go` |
| attester ≠ actor: independent verifier | `kernel/internal/verify/verify.go`, `kernel/cmd/verifier` |
| Brain cannot self-restore | `src/orchestration/restore.ts` |
| Boundary ledger (external effect) | `src/orchestration/pipeline.ts` |
| Restore anchor cross-validation | `src/orchestration/restore.ts`, `src/orchestration/snapshot.ts` |
| DivergenceReport | `src/orchestration/snapshot.ts`, `src/orchestration/restore.ts` |
| Identity-only IAM (no RBAC, by design) | `src/iam/ids.ts` |
| The one governed edge | `src/orchestration/pipeline.ts` (`runGovernedToolCall`) |

---

## 11. Where to go next

- **Run a surface (the adopter contracts that keep these guarantees holding):** [Composition Root Guide](./sdk/composition-root-guide.md).
- **Author a tool (the `sideEffect`/`containment` fields that drive the approval / external gates):** [Tool Manifest Authoring](./sdk/tool-manifest-authoring.md).
- **Independently verify the evidence chain (the attester≠actor moat):** [Verifier Release](./sdk/verifier-release.md).

> **Honesty note (restated):** `agent-os` is currently an in-repo / private package — an external
> `npm install agent-os` does **not** resolve yet. Quickstarts use the in-repo path (`git clone` +
> `pnpm install` + the repo's scripts). Everything flagged in [§9](#9-deploy-gated-limits-read-this) is
> deploy-gated or future; everything else in this document is command-verified by `pnpm run verify`.
