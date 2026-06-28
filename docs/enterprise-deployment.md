# Enterprise Deployment & Provisioning Checklist

> **Audience:** the platform/SRE team at an enterprise that has read the SEATBELT security
> whitepaper, understands the trust model (deny-by-default, credential-blind, commit-before-effect,
> attester≠actor WORM), and now wants to run a governed Enterprise fleet in production.
>
> **Read first:** the [Composition Root Guide](./sdk/composition-root-guide.md) — *how to actually
> run a surface*. That guide shows the **code shape** (the injected seams and the `createEnterpriseFleet`
> facade). **This** document is the **infrastructure shape**: the concrete things **you** must stand up
> behind those seams, why each one matters, and which guarantee each unlocks. The two are complementary:
> the guide is what your composition root *calls*; this checklist is what those calls must *talk to*.

---

## The honest starting point

Agent OS is a **library, not a turnkey service**, and today it is a **private, in-repo package**:
`package.json` declares `"name": "agent-os"` with `"private": true`. **`npm install agent-os` does not
resolve** against any public registry. The quickstart is the in-repo path:

```bash
git clone <your-fork-or-mirror-of-agent-os>
pnpm install
pnpm run example:enterprise   # builds + runs the Enterprise composition root over in-memory fakes
```

Every surface factory **defaults to a fully in-memory composition** — an `InMemoryAppendOnlyLog` with
an in-process ed25519 key, a `FakeSandboxAdapter`, and an `InMemoryCostGate` per tenant. That default
runs a *real* governed flow end-to-end (screen → PDP → cost → commit-before-effect → effect → WORM →
console) with **zero external dependencies**. It is genuinely the seatbelt — *in memory*.

**Production = swap every in-memory fake for a real adapter behind the same injected port shape.** None
of the items below ship turnkey. Each is **the enterprise's to provision**. This checklist is exactly
the gap between the in-repo (fakes / runtime-direct) system and a production-grade deployment. Where an
item is **deploy-gated** (the seam exists but the production path is not wired in this repo), it is
flagged as such — do not assume otherwise.

The factory you wire is `createEnterpriseFleet(opts)` (`src/enterprise/bootstrap.ts`). Its production
seams are the per-tenant injectors: `wormSinkFor`, `costGateFor`, `allowToolInvokePerTenant`,
`secondaries`, `toolRegistry`, plus out-of-band checker-capability issuance for `operatorAction`.

---

## How to read each item

> **Provision** — the concrete infrastructure you stand up.
> **Wire** — the `createEnterpriseFleet` seam (or external step) it plugs into.
> **Why** — what is fake / runtime-direct today, and what breaks if you skip it.
> **Guarantee unlocked** — the SEATBELT invariant it makes real in production.
> **Status** — `LIVE-capable` (seam wired, you provide the backend) or `DEPLOY-GATED` (not wired yet — flagged).

---

## 1. The real WORM kernel + a real KMS/HSM trust-root (TR2) — the attester≠actor anchor

**Provision.** Run the Go evidence kernel (`kernel/cmd/kernel`) as a standing **partitioned
AppendService** (gRPC), backed by durable storage, with **one independent WORM chain per tenant
partition** (its own chain head + its own Ed25519 signing key). Bind that signing key material to a
**real KMS/HSM trust-root (TR2)** so the attester key is held by infrastructure the actor process
cannot forge or read.

**Wire.** Inject `wormSinkFor: (binding) => createPartitionedIngestSink(transport, binding)`
(`src/runtime/ingest/partitioned-sink.ts`), where `transport` is the gRPC append transport
(`createRpcAppendTransport`, `src/runtime/ingest/transport.ts`). The sink stamps
`partitionId = binding.partitionId` on **every** request (proto `AppendRequest.partition_id`, field 4),
so the kernel routes each tenant's append to its **own** independent chain. The sink is closure-bound to
one binding, so cross-tenant write is structurally impossible.

**Why.** With no `wormSinkFor`, each tenant's WORM is an in-process `InMemoryAppendOnlyLog` with an
ed25519 keypair **generated in-process** (`provisionTenant` calls `generateKeyPairSync("ed25519")`,
`src/enterprise/bootstrap.ts`). The comment there is explicit: *"real per-tenant key provision is
P4 … attester == operator"*. In other words, in the in-repo default the **attester and the actor are
the same process** — the moat is *demonstrated in memory*, not anchored. The whole attester≠actor
guarantee rests on the signing key living somewhere the actor cannot reach.

**Guarantee unlocked.** **attester≠actor WORM** + **commit-before-effect**. The commitgate
(`src/commitgate/guard.ts`) `await`s `appender.append(event)` and runs the effect **only on the next
line**; the partitioned sink's append **rejects** on any transport reject/timeout, dedup conflict, or
non-receipt response, which makes `commitBeforeEffect` refuse the effect (no receipt ⇒ no observable
effect). An auditor can later verify the signed chain against the KMS/HSM-rooted public key — *without
trusting your running platform*.

**Status.** The live partitioned sink is **LIVE-capable** (the seam is wired and proven against a real
kernel by `bootstrap.live-kernel.e2e.test.ts` / `partition-readback.live.test.ts`). The **KMS/HSM
trust-root externalization (TR2)** is **DEPLOY-GATED / P4**: the repo's live tests prove *given the
kernel's attester key, verification binds to it*, but **trust-root distribution and key externalization
(HSM / per-tenant KMS / remote attestation) are explicitly out of scope in-repo** (see
`signed-readback.live.test.ts`, `partition-readback.live.test.ts`, `tenant-lifecycle.test.ts`). You
provision the HSM/KMS and the endorsement of *which key is which tenant's*.

---

## 2. A real zero-cred / egress-controlled / ephemeral sandbox substrate (exec + browser)

**Provision.** A real `ExecutionSubstrate` that runs agent effects (shell exec **and** browser
navigation) in **ephemeral, zero-credential, egress-controlled** sandboxes — i.e. no ambient secrets in
the sandbox, an enforced outbound network policy, an enforced host-write mount policy, and teardown
after use.

**Wire.** Provide a real `SandboxAdapter` / `ExecCapableSandboxAdapter` (`src/runtime/substrate/port.ts`)
in place of the default `FakeSandboxAdapter`. Carry the per-sandbox `egressAllow` and `hostWriteAllow`
allowlists (`SandboxSpec`) into your substrate's actual network-policy and host-mount configuration.

**Why.** The fleet default is `FakeSandboxAdapter` — its `createSandbox` only **echoes a status**; it
runs nothing and isolates nothing. Critically, the port documents an **honest boundary**: *"the REAL
no-egress enforcement is a DEPLOY FACT (the OpenShell network policy)"* and *"the REAL host-write
enforcement is a DEPLOY FACT (the sandbox host-mount + kernel realpath, symlink-resistant)."* The
in-repo PDP egress/host-write decisions (`egressDecisionForProjection`, `hostWriteDecisionForProjection`)
are **defense-in-depth only** — lexical, testable, *secondary*. The **substrate seal is primary**, and
that seal is yours to deploy. Where the substrate's create request has no field to carry an allowlist
(the pinned OpenShell `CreateSandboxRequest` proto subset does not), the adapter treats it as
**documented deploy-intent**, never fabricating a wire field — meaning the actual enforcement *must* be
configured in your substrate.

**Guarantee unlocked.** **credential-blind** at the effect boundary (no ambient creds in the sandbox),
plus real egress/host-write containment of every executed effect. Combined with the upstream screen
(`exec.env`/`stdin` are credential-blind and screened by `makeExecEffect` before any exec), the secret
never reaches the process.

**Status.** **LIVE-capable but DEPLOY-DEPENDENT.** The port is swappable (proven by the `Fake`/`Null`
second implementation) and a live governed real-Chromium navigate+read has been demonstrated, but the
**actual zero-cred / no-egress / ephemeral enforcement is a deploy fact you own** — the in-repo defaults
do not enforce it.

---

## 3. The SpendGuard ledger adapter — including the `release()` RPC

**Provision.** Stand up the SpendGuard ledger (its session-reservation model:
`reserve_session → commit_session_delta → release/expire`, backed by its real Postgres-stored-proc-over-gRPC
ledger) and a `LedgerTransport` that talks to it.

**Wire.** Inject `costGateFor: (tenantId) => new SpendGuardCostGate(ledgerTransport)`
(`src/cost/adapters/spendguard/adapter.ts`) — one **independent** gate per tenant, so tenant-A
exhausting or blowing its budget never affects tenant-B. The adapter maps the vendor-neutral `CostGate`
port (`reserve`/`commit`/`release`) onto SpendGuard's ledger and **fail-closed-overrides** SpendGuard's
predictor-down *fail-open* behavior: a missing estimate or any transport error yields a **deny**, never
an allow.

**Why — and the `release()` gap.** The default per-tenant gate is `InMemoryCostGate(budget)`. The real
adapter exists, **but its `release()` is deliberately not wired**:

```ts
// src/cost/adapters/spendguard/adapter.ts
release(ctx, _reservationId): Promise<ReleaseResult> {
  return Promise.resolve(
    denyRelease(ctx, "release not wired (deny-by-default, fail-closed; SpendGuard Release -> R11)"),
  );
}
```

`release()` is the **abort path** (the third terminal edge, mutually exclusive with `commit`): when a
run is aborted *before* the effect ran, `release` should return the still-reserved budget (`held -=
reserved`, `settled` unchanged — no real spend occurred). Because the SpendGuard `release_session` RPC
is **out of scope (R11/R12 follow-up)**, the adapter's `release()` is **fail-closed deny-all**: it never
frees a reservation. **Consequence to plan for: until `release()` is wired, an aborted run does not
return its reserved budget — an abort erodes the tenant's budget.** This is a deliberate fail-closed
choice (never *over*-credit), but it means abort-heavy workloads will see budget drift downward.

**Guarantee unlocked.** The **hard-cap spend invariant**: an over-budget `reserve` is **denied** (a
runaway agent cannot bankrupt a tenant), a `commit` without a prior reservation is denied, and an
in-flight overrun is **recorded faithfully** (never erased) with the budget then exhausted for every
subsequent reserve. The fail-closed override ensures a ledger outage **denies spend**, never opens it.

**Status.** `reserve` / `commit` are **LIVE-capable** (you supply the `LedgerTransport`). `release()` is
**DEPLOY-GATED (R11/R12)** — until SpendGuard `release_session` is wired, abort = budget erosion, as
above.

---

## 4. Real multi-tenant provisioning — per-tenant gateways/stores, PDP-scoped sessions

**Provision.** A real per-tenant onboarding pipeline: each tenant gets its **own** gateway routing,
**own** WORM partition + key, **own** spend gate, **own** approval inbox, **own** allow-rules, and a
PDP-scoped session whose `AgentContext.tenantId` is the *only* tenant it can name.

**Wire.** `createEnterpriseFleet({ tenants, allowToolInvokePerTenant, wormSinkFor, costGateFor, ... })`.
Static tenants are provisioned at construction; dynamic onboarding/offboarding is `registerTenant` /
`deprovisionTenant`. Both share the **same** `provisionTenant` step (byte-identical provisioning), which
builds **independent closure-bound instances** per tenant — *never* "one shared instance + a tenantId
parameter". Set `allowToolInvokePerTenant(tenantId)` to mint each tenant's `tool:invoke` allow-rule
(scoped to `fleet:*` with `tenantId === binding.tenantId`); the PDP fails closed cross-tenant by
construction even if mis-wired.

**Why.** The default is a single in-process fleet. The **tenant-sealed invariant** is load-bearing:
collapsing any per-tenant instance (e.g. one shared WORM log) to a shared instance would make tenant-A's
approve→WORM→timeline **leak into tenant-B** — precisely what the cross-tenant e2e flips RED. Real
deployment means real per-tenant backends behind each of those independent slots (a real WORM partition
per §1, a real spend gate per §3), plus the operational machinery to onboard/offboard tenants safely.
Note the deliberate behavior: `deprovisionTenant` revokes *routing/action* capability but, by the
append-only invariant, **never erases** the tenant's WORM history; a retired tenantId is **not
re-onboardable in-process** (re-registration is fail-closed denied) to avoid silently reusing old WORM
state.

**Guarantee unlocked.** **Tenant isolation** (structural, not a permission check): a caller holding
tenant-A's facade has no argument by which to name tenant-B, so cross-tenant read/write/approve is
*impossible*, not merely *forbidden*. This is re-proven on every commit by `verify:cross-tenant` across
both the TS plane and the Go kernel partition plane (`scripts/verify-cross-tenant.sh`) — see §7.

**Status.** **LIVE-capable.** The seams and isolation invariants are implemented and gated; you provide
the real per-tenant backends (§1, §3) and the onboarding orchestration.

---

## 5. The released independent verifier binary + key distribution — the auditor's trust anchor

**Provision.** Build and distribute the **standalone evidence-chain verifier** to your auditors:

```bash
pnpm run verifier:release    # → dist/verifier/ (gitignored, not committed)
```

This produces versioned, **reproducible** (byte-identical for a given commit), cross-platform binaries
(`verifier-linux-amd64`, `-arm64`, `-darwin-*`, `-windows-amd64.exe`) plus `verifier.wasm` (runs in a
browser / any WASM host, **offline**) and a sorted `SHA-256SUMS`. See
[`docs/sdk/verifier-release.md`](./sdk/verifier-release.md) for the full release flow and reproducibility
guarantees. Distribute the binary + checksums to auditors, and distribute the **trust-root public key**
(the KMS/HSM-anchored Ed25519 public key from §1) **out-of-band** — the auditor supplies it as the
`--pubkey` input at verification time; the verifier does **no** pubkey pinning itself.

**Wire.** Auditors run the binary directly:

```bash
./verifier-darwin-arm64 --chain chain.json --pubkey auditor-supplied-trust-root.pem
# exit 0 = chain intact; 1 = chain broken (reorder/tamper/gap/bad sig); 2 = unparseable input / bad pubkey
```

The Developer surface can also spawn it across a process boundary via `verifyEvidenceChain(pubkeyPath,
env)` (`src/developer/bootstrap.ts`), honoring `AGENTOS_VERIFIER_BIN` (default `agentos-verifier`) and
relaying the exit code verbatim — fail-closed: a missing/un-executable binary or any unexpected exit code
is treated as **not intact**.

**Why.** This binary is *the entire point of attester≠actor*: it lets an auditor **trust the small
verifier, not your platform**. It depends only on `internal/verify` + `internal/chain` and **never** on
the producer (`internal/log`); it is fail-closed (never `exit 0` on an incomplete chain). If you do not
ship and distribute it, the WORM chain is only as trustworthy as your assertion about it.

**Guarantee unlocked.** **Independent, offline verifiability** of the attester≠actor WORM — the trust
anchor that closes the moat for a third party.

**Status.** The release pipeline is **LIVE** (`pnpm run verifier:release`). **Honest scope:** the
verifier does **no pubkey pinning** and does **not** externalize the signing root itself — *pubkey
pinning / externalized trust-root = P4* (`docs/sdk/verifier-release.md`); auto-publish to GitHub
Releases/CDN and embedding the WASM into the shell UIs are explicitly **out of scope**. Key
**distribution** is your out-of-band responsibility.

---

## 6. Wire `pnpm run verify` into CI — reproducing the multi-language toolchain on the runner

**Provision.** A CI runner (or runner image) that can reproduce the **full** verification toolchain:
Node + pnpm, Go (for the kernel + verifier, `CGO_ENABLED=0`, `GOTOOLCHAIN=local`), Python (for the
Python boundary verify), and protobuf, plus the cross-tenant Go partition conformance.

**Wire.** Run the universal gate as a required CI check on every PR/merge:

```bash
pnpm run verify
```

which is (verbatim from `package.json`):

```
typecheck && lint && build && test && deps:check && proto:check && openshell:proto:check
  && spendguard:proto:check && agt:proto:check && verify:go && verify:py
  && verify:cross-tenant && launcher:check && secret-scan
```

**Why.** The gate **exists** and is authoritative — *its exit code is the only acceptable proof of
"works"* (1808 TS tests pass locally). The **operator step** is reproducing its toolchain on a runner:
`verify:go` and `verify:cross-tenant` need a Go toolchain (and self-defend against a stale host
`GOROOT`/PATH-`go` skew — see `scripts/verify-cross-tenant.sh`), `verify:py` needs Python,
`proto:check` (and the per-vendor proto checks) need protobuf, and `secret-scan` must run so **no
credential ever lands in a workspace file, log, artifact, snapshot, or fixture**. `verify:cross-tenant`
is **release-blocking**: any single tenant-isolation boundary leaking (TS routing/persistence/maker-checker
*or* the Go kernel partition plane) fails the whole gate.

**Guarantee unlocked.** Continuous enforcement of **every** invariant — deny-by-default, isolation,
credential-blindness — on every change, with the same fail-closed semantics the local pre-commit guard
enforces (`git config core.hooksPath .githooks`; `--no-verify` is forbidden).

**Status.** The gate is **LIVE**; **reproducing the Node + Go + Python + proto + cross-tenant toolchain
on a CI runner is your operator step.**

---

## 7. maker≠checker capability issuance (out-of-band)

**Provision.** A **separate, independent issuing authority** that mints `CheckerCapability` tokens for
privileged operator actions (`operatorAction`, e.g. `suspend-agent`). This authority is **not** the
maker and **not** the actor process — the capability **cannot be self-issued by the maker**.

**Wire.** Pass the issued `CheckerCapability` to `fleet.operatorAction(ctx, action, cap)`. The fleet
calls `enforceMakerChecker(ctx, action, cap)` (`src/tenant/maker-checker.ts`), a deny-by-default pure
function that requires **all** of: a well-formed capability (possession), `cap.tenantId === ctx.tenantId`
(cross-tenant capability does not apply), `cap.makerActorId !== ctx.actorId` (same person cannot be both
maker and checker), and a **re-derived** `actionIdentity` match (TOCTOU defense — the identity of the
action *about to run* must equal the capability's bound identity). The capability holds **no secret**:
`capabilityRef` is an **opaque reference** to the independently-issued capability.

**Why.** The reference example **self-issues** a capability only to drive the enforce side — the
composition-root guide is explicit that *"in production the checker capability is issued by a separate
maker≠checker authority."* If you let the actor process mint its own capabilities, maker≠checker
collapses and a single compromised actor can authorize its own privileged action.

**Guarantee unlocked.** **maker≠checker** on every privileged operator action: a sensitive action only
proceeds when an *independently issued* capability, bound to (tenant, action-identity, maker), is
possessed by a *different* checker — enforced by possession, not by a string compare, and re-validated
against the action about to run.

**Status.** The enforcement primitive is **LIVE** (deny-by-default, fully tested + in the cross-tenant
conformance gate). The **independent issuing authority is yours to provision out-of-band** — it is not
part of the in-repo fleet.

---

## Deployment readiness summary

| # | Provision (yours) | Seam / step | Guarantee unlocked | Status |
|---|---|---|---|---|
| 1 | Partitioned WORM kernel + KMS/HSM trust-root (TR2) | `wormSinkFor` → `createPartitionedIngestSink` | attester≠actor WORM + commit-before-effect | sink **LIVE-capable**; TR2 **DEPLOY-GATED (P4)** |
| 2 | Zero-cred / egress-controlled / ephemeral sandbox (exec + browser) | real `SandboxAdapter` for `FakeSandboxAdapter` | credential-blind + real containment of effects | **LIVE-capable**, deploy-fact enforcement |
| 3 | SpendGuard ledger + `LedgerTransport` | `costGateFor` → `SpendGuardCostGate` | hard-cap spend; fail-closed on outage | reserve/commit **LIVE**; `release()` **DEPLOY-GATED (R11/R12)** — abort erodes budget |
| 4 | Per-tenant backends + onboarding orchestration | `tenants` / `register`/`deprovisionTenant` / `allowToolInvokePerTenant` | structural tenant isolation | **LIVE-capable** |
| 5 | Released verifier binary + out-of-band key distribution | `pnpm run verifier:release`; `verifyEvidenceChain` | independent offline verifiability | release **LIVE**; pinning/root externalization **P4** |
| 6 | CI runner reproducing the multi-language toolchain | `pnpm run verify` as a required check | continuous enforcement of all invariants | gate **LIVE**; toolchain repro is your step |
| 7 | Independent maker≠checker issuing authority | `operatorAction(ctx, action, cap)` / `enforceMakerChecker` | maker≠checker on privileged actions | primitive **LIVE**; issuer **out-of-band, yours** |

**Bottom line.** The governance is in the spine, not the adapter — so none of the above changes your
composition-root **code**; you inject a different adapter behind the same port. But every item is **real
infrastructure you must stand up**, and three of them (TR2 key externalization, SpendGuard `release()`,
auto-publish/pinning of the verifier) are **deploy-gated and do not exist turnkey today**. Treat this
checklist as the literal gap between the in-repo demonstration and a production deployment — and do not
overclaim what has not yet been wired.

---

## Where to go next

- **Run a surface (code shape):** [Composition Root Guide](./sdk/composition-root-guide.md).
- **Author tools (the `sideEffect`/`containment` fields that drive the gates):**
  [`docs/sdk/tool-manifest-authoring.md`](./sdk/tool-manifest-authoring.md).
- **Hand the verifier to auditors:** [`docs/sdk/verifier-release.md`](./sdk/verifier-release.md).
