# Agent OS

> **A computer that operates itself by intent.** You say what you want — the whole machine does it.

![TypeScript](https://img.shields.io/badge/core-TypeScript-3178c6)
![Go](https://img.shields.io/badge/evidence%20kernel-Go-00add8)
![Python](https://img.shields.io/badge/agent%20shim-Python-3776ab)
![verify](https://img.shields.io/badge/gate-pnpm%20run%20verify%20(13--leg)-2ea44f)
![evidence](https://img.shields.io/badge/evidence-attester%E2%89%A0actor%20WORM-6f42c1)

Agent OS is an **operating system for the agent era**. You type (and eventually speak) plain-language
intent; a swappable **brain** drives a **real computer** to do the work — turning intent into a clarified
plan, an approval, real effects, and a timeline you can read back. The skill of "using a computer" is
meant to dissolve into "telling a computer what you want."

- **Brain** — the agent that proposes the work (default **Hermes**, swappable via the Brain Port).
- **Body** — **NVIDIA OpenShell**: a real sandboxed computer the brain operates.
- **Spine** — `agent-os`: one small ordered orchestration pipeline + vendor-neutral contracts that route
  every proposed action to a real effect, across three co-equal surfaces.
- **Seatbelt** — a fail-closed safety subsystem (deny-by-default, credential-blind, commit-before-effect,
  and an **independently-verifiable** evidence chain) that makes it *safe* to let an autonomous agent run
  your computer — or your company. It is load-bearing support, never the headline.

> **Status:** the **spine + the three surfaces + the seatbelt** are built and pass a 13-leg `verify`
> gate (~851 tests); the real-vendor wires (OpenShell / NemoClaw / SpendGuard / Hermes / the Go kernel)
> are proven by **opt-in, infra-gated** live e2e scripts. The full "say anything, the whole computer does
> it" experience is the **north star**; what ships today is the governed spine + surfaces + verifiable
> evidence. See [Status](#status-honest).

---

## How it works

```
            you (intent)                          you / auditor (verify)
                 │                                          ▲
                 ▼                                          │  spawn the released
        ┌──────────────────┐   proposes   ┌─────────────────┴───────────┐  verifier (offline,
        │  BRAIN (Hermes,   │ ───────────► │  SPINE — agent-os            │  process-isolated)
        │  swappable)       │  tool calls  │  runGovernedToolCall:        │
        └──────────────────┘              │   screen ▸ authorize ▸ cost  │
                                          │   ▸ commit-before-effect ▸   │
        ┌──────────────────┐   effects    │   effect                     │
        │  BODY — OpenShell │ ◄─────────── │                              │
        │  (real sandbox)   │              └──────────────┬───────────────┘
        └──────────────────┘                              │ append (await receipt)
                                                          ▼
                                          ┌──────────────────────────────┐
              SEATBELT wraps it all  ───► │  WORM evidence kernel (Go,    │
              deny-by-default · credential│  separate process, Ed25519,   │
              -blind · commit-before-     │  hash-chained, per-tenant)    │
              effect · attester ≠ actor   └──────────────────────────────┘
```

The **spine** is one ~55-line fail-closed pipeline (`src/orchestration/pipeline.ts`): a brain-proposed
tool call becomes a real effect only after `screen` (credential-blind) → `authorize` (deny-by-default
PDP) → `cost.reserve` (budget hard-cap) → **commit-before-effect** (append the audit record and *await
the receipt*) → `effect` → `cost.commit`. The effect runs **only** after every gate passes **and** the
evidence is durably recorded. Five collaborators are injected as **vendor-neutral ports**, so the spine
names no vendor and reaches no module's internals — enforced by the build, not by etiquette.

## Three surfaces, one core

| Surface | What you get |
|---|---|
| **Personal** | A computer that operates itself by intent: type intent → the brain clarifies → renders a plain-language plan → **you approve** (the "sudo" step) → the governed pipeline runs it → a plain-language **timeline** reads the evidence back. |
| **Enterprise** | *One person runs the company.* Gateway-per-tenant fleet with **per-tenant independent** log / budget / approval instances (cross-tenant read/write/approve is structurally impossible), operator **maker-checker**, and runtime tenant onboarding/offboarding. |
| **Developer** | The surface that exposes **independent verifiability**: author a tool (registry-backed, deny-by-default), run it through the same governed pipeline, replay the evidence as a deterministic fold, and **verify the chain yourself** with a separately-released binary. |

All three are runnable composition roots over the **same** spine, and (via DVx) share **one**
registry-backed deny-by-default authorize contract.

## What makes it different

- **The spine is a pipeline, not a framework** — ~55 lines, fail-closed, every collaborator injected.
- **Capability × experience is real code** — the Personal loop (intent → clarify → plan → approve →
  govern → effect → timeline) is wired end-to-end, not a slogan.
- **Independent verifiability — "reading ≠ attesting"** — the SDK and CLI **spawn a separately-released,
  checksum-verified verifier across a process boundary** and relay its verdict; the chain hash is *never*
  recomputed in the app. A third party verifies what the operator actually did **without trusting the
  operator** — proven live against a real cross-language chain, and per-tenant.
- **No vendor in the core, enforced by the build** — `dependency-cruiser` errors on any vendor token
  (`hermes|nemoclaw|openshell|agt|spendguard`) outside its adapter; Go `depguard` + Python `import-linter`
  extend it. The OS identity can't quietly collapse into a vendor.
- **A real separate-process Go WORM kernel** — append-only, hash-chained, Ed25519-checkpointed, per-tenant
  partitions, fsync + torn-tail rejection, an offline verifier (incl. WASM) that does **not** import the
  producer, and a conformance suite proving Go matches the TS reference **byte-for-byte**.
- **Proof is visible, not asserted** — `pnpm run verify` is a 13-leg polyglot cascade; the exit code is
  the only accepted proof of "works." Every change landed doc-first → failing test → green gate →
  independent adversarial review → merge.

## Integrations

Agent OS is a **layer above** existing vendors (no forks) — they plug into vendor-neutral ports; the core
stays vendor-free.

| Integration | Role | Status |
|---|---|---|
| **OpenShell** (NVIDIA) | **Body** — the real-computer sandbox (default `ExecutionSubstrate`) | **Live, infra-gated** — real mTLS gRPC gateway, 6 pinned RPCs (`e2e:live-kernel`, `e2e:live-nemoclaw`). The most mature wire. |
| **Hermes** ([Nous Research](https://hermes-agent.nousresearch.com/)) | **Brain** — the agent that proposes work (default, via the Brain Port) | **Live (desktop ACP) — verified, incl. the multi-turn closed loop.** A locally-run desktop Hermes drives Agent OS over ACP (`hermes acp`, JSON-RPC/stdio): `e2e:live-desktop-hermes` is GREEN against the real agent — intent → proposal → governance → **the governed result is fed back over the same ACP session and Hermes continues** (multi-turn closed loop, live-verified), **propose-only** (Hermes never self-executes) + **credential-blind** (its key never leaves `~/.hermes`). Also: an in-repo `HermesBrainShim` + a NemoClaw-sandbox **adopt** path (`e2e:live-hermes`). |
| **NemoClaw** (NVIDIA) | **Hosting** — launches/probes/reconciles the brain inside the sandbox | Live, infra-gated (`e2e:live-nemoclaw`). Documented as single-operator — its *lack* of tenant isolation is exactly what the Enterprise surface adds. |
| **[agentic-spendguard](https://github.com/m24927605/agentic-spendguard)** (SpendGuard) | **Cost gate** — reserve-before-effect budget hard-cap (default `CostGate`) | Live, infra-gated (`e2e:live-spendguard`: real sidecar + Rust ledger + Postgres). |
| **Microsoft Agent Governance Toolkit** (AGT) | **Advisory policy** input | In-repo adapter (`src/policy/adapters/agt`) + tests, **demoted to advisory** — our deny-by-default PDP stays the sole grant authority; the live AGT engine is an injected seam (not bundled, not wired live). |

### Enabling SpendGuard / AGT (config-driven)

The surfaces default to an in-memory budget gate + no advisory policy. To turn the integrations **on**, build the
injection opts from env with `integrationsFromEnv` (from `src/runtime/spendguard`) and pass them into a surface
(`createPersonalShell` / `createDeveloperKit` / `createEnterpriseFleet`). The surfaces themselves stay vendor-free —
this composition root is the only place a vendor is named.

**SpendGuard (cost gate)** — run the real sidecar, then set (all **non-secret** identifiers):

```bash
# 1. bring up the real SpendGuard sidecar (its repo): docker compose -f deploy/demo/compose.yaml up -d sidecar
# 2. point Agent OS at it (set => SpendGuard ON; unset => in-memory budget gate):
export SPENDGUARD_UDS_PATH=/path/to/sidecar.sock
export SPENDGUARD_BUDGET_ID=...        # required when UDS is set
export SPENDGUARD_UNIT_ID=...          # required
export SPENDGUARD_WINDOW_INSTANCE_ID=...   # required (the accounting window)
export SPENDGUARD_TENANT_ASSERTION=... # optional (single-tenant surfaces)
```

```ts
import { integrationsFromEnv, costGateForFromEnv } from "agent-os/runtime/spendguard";
const shell = createPersonalShell(integrationsFromEnv());                 // Personal / Developer
const fleet = createEnterpriseFleet({ costGateFor: costGateForFromEnv() }); // Enterprise: per-tenant gate
```

**Fail-closed by design:** if `SPENDGUARD_UDS_PATH` is set but any required topology key is missing/blank, startup
**throws** — it never silently falls back to the in-memory gate (so you can't believe SpendGuard is enforcing when
it isn't). Honest caveats: needs the external sidecar running; `release()` is unwired (deny-by-default); the real
budget proof is the gated `e2e:live-spendguard`.

**AGT (advisory policy)** — the adapter is in-repo; you inject **your** AGT engine (the `evaluate` seam) and pass it
as an advisory secondary. It can only **narrow** — the PDP stays the sole grant authority (any-deny-wins; a
malformed/throwing advisory = deny):

```ts
import { AgtSecondaryPolicy } from "agent-os/policy/adapters/agt";
const agt = new AgtSecondaryPolicy(myAgtEvaluate);   // myAgtEvaluate = your live AGT engine
const shell = createPersonalShell(integrationsFromEnv(process.env, { secondaries: [agt] }));
```

## Quickstart

```bash
# Node >= 22, pnpm 9.15.4
pnpm install

# The gate — the only accepted proof of "works" (13-leg polyglot cascade:
# typecheck · lint · build · test · deps:check · 3× proto:check · verify:go · verify:py
# · verify:cross-tenant · launcher:check · secret-scan)
pnpm run verify

# Unit + contract tests only (~851 cases) — what a bare checkout shows green
pnpm test
```

**Try the live wires** (opt-in, infra-gated, self-cleaning — each *blocks cleanly* if its infra is absent):

```bash
pnpm run e2e:live-kernel            # TS → real Go WORM kernel round-trip + offline verifier
pnpm run e2e:live-nemoclaw          # host a gateway in a real OpenShell sandbox (the body, mTLS gateway)
pnpm run e2e:live-hermes            # adopt a real Hermes sandbox → status → reconcile (the brain)
pnpm run e2e:live-desktop-hermes    # a local desktop Hermes drives Agent OS over ACP (the brain, propose-only)
pnpm run e2e:live-spendguard        # real SpendGuard sidecar + Rust ledger + Postgres (the cost gate)
pnpm run e2e:live-enterprise        # per-tenant WORM partitions vs the real kernel
pnpm run e2e:live-developer         # the released verifier verifies a kit-signed chain
pnpm run e2e:live-partition-verify  # each tenant independently verifies ITS OWN chain
pnpm run e2e:live-kernel-verify     # the released verifier verifies the REAL kernel chain
```

**Verify an evidence chain as an auditor would** — build the released, checksum-pinned verifier and
check a chain with only the chain bytes + the signer's public key (you don't have to trust the operator):

```bash
pnpm run verifier:release           # builds the standalone + WASM verifier, with SHA-256SUMS
# then: <verifier> --chain <chain.json> --pubkey <key>  → exit 0 = intact, 1 = broken
```

## Status (honest)

- **Built & proven hermetically.** All three surfaces are runnable composition roots; the spine, the 5
  vendor-neutral ports (each with ≥2 implementations + a contract test), the 3 monopolies (deny-by-default
  PDP / credential-blind secret model / Go WORM kernel), the offline verifier, and the
  no-vendor-in-core + cross-tenant gates all pass `pnpm run verify` (~851 tests). 305+ commits.
- **Live, but infra-gated.** The opt-in `e2e:live-*` scripts prove the real wires (OpenShell; NemoClaw;
  SpendGuard; a local **desktop Hermes driving the brain over ACP** + the NemoClaw-sandbox Hermes-adopt path;
  the Go kernel + offline verifier + per-tenant isolation). They live *outside* `verify`, self-clean, and exit
  cleanly when the infra is absent; reproducing them needs your infra.
- **Default runtime is in-memory.** The composition roots default to in-memory log / cost / sandbox fakes,
  so everything runs without external services; the live adapters are injected when you point at real infra.
- **North star vs today.** "Say anything, the whole computer does it" is the vision. What ships is the
  governed spine + the three surfaces + verifiable evidence. Honest gaps are tracked in `docs/slices/`
  (e.g. real STT vendor; a **substrate exec primitive** — the desktop-Hermes closed loop is live-verified, but the
  governed effect's result is a canned stub today because the ExecutionSubstrate port has no run/exec method yet, so
  real command output can't be fed back to Hermes until that lands; **operator-unforgeable trust-root** — the kernel
  process no longer holds the signing key, but a hardware/KMS root that even the operator can't forge is a
  deployment step, not yet wired).

## Built with Looping Engineering

Every slice: **doc-first** → a **failing test** seen to fail → `pnpm run verify` green → an **independent,
fresh-context adversarial code review** → `--no-ff` merge. Only command output counts as proof. A
pre-commit guard runs the full gate and is never bypassed. See [`AGENTS.md`](./AGENTS.md) (the binding
operating contract) and [`docs/`](./docs/).

## License

[MIT](./LICENSE) © 2026 m24927605.
