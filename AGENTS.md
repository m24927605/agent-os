# AGENTS.md — Operating contract for the Agent OS repository

**This file is BINDING for any AI agent** (Claude Code, Codex, Cursor, OpenClaw, …) working in this
repository. It is the authoritative operating contract. If a tool also reads `CLAUDE.md`, that file
only adds tool-specific mechanics — **AGENTS.md wins on any conflict.**

## What Agent OS is (north star)

**Agent OS is an operating system for untrusted, autonomous AI agents — a domain-agnostic,
framework-agnostic trust/governance control plane that makes letting an agent act safe by
construction.** It governs from OUTSIDE the agent's trust boundary and IN its action path: every
capability is deny-by-default, every privileged action is auditable and approvable, credentials never
leak, and effects are gated commit-before-effect. Its core, least-commoditizable moat is
**"attester ≠ attested actor"** — it emits a separately-signed, hash-chained, **independently
verifiable WORM system-of-record** that neither the agent nor the operator can forge, bypass, or
rewrite. (It is NOT a faster sandbox / agent-runtime; that market is a commodity price war that
re-binds the attester to the operator and destroys the moat.)

Scope and stance (confirmed product decisions):
- **We do NOT build an agent.** Agent OS *hosts* existing third-party agents (Claude Code, OpenClaw,
  Codex, …) as untrusted "applications" and governs them. The agent is the app; Agent OS is the OS.
- **Any autonomous agent, not only coding agents.** Keep the domain model (Task, AgentSession,
  ToolManifest, …) agent-type-agnostic — do not bake in coding-specific assumptions.
- **API/SDK-first.** The primary surface is a programmatic API/SDK that other systems integrate to
  run agents safely; CLI and UI are secondary consumers of that same API.

The OS analogy is literal: Policy engine ≈ syscalls/permissions, Sandbox ≈ process isolation,
Approval workflow ≈ sudo, AuditEvent ≈ syslog, Task/AgentSession ≈ process/scheduler, Credential
provider + Inference routing ≈ device/credential management.

**One governance core, three surfaces of the same OS** (founder decision 2026-06-20 — we build all
three; they share one core, they are not three separate products). The shared core = the evidence
kernel (WORM + standalone verifier + per-source sequence/gap + outbox + commit-before-effect +
append-only ingest) + the governance plane (deny-by-default policy, credential-blind redaction,
AgentContext, tenant isolation) + the `ExecutionSubstrate` abstraction (OpenShell is substrate #1,
not the product) + the SDK. The three surfaces over it:
- **Personal Agent Workstation surface** — single user, local-first; integrates the user's machine /
  browser / email / calendar / files / terminal; agents run through the same policy gate + audit
  kernel. (Also serves as the internal dogfooding forge; never monetized as a consumer SKU.)
- **Enterprise Agent Governance Plane surface** — multi-tenant (gateway-per-tenant), fleet governance,
  the signed WORM bundle a customer's CISO/TPRM/auditor/insurer can independently verify.
- **Developer surface** — SDK + ExecutionSubstrate + observability + deploy, to build and run agents
  on the platform. (Exposed honestly as a developer top-of-funnel, never sold as a commodity runtime.)

**Guarantee Ladder (honest scoping — never let a weaker surface imply a stronger one's guarantee):**
- **Tier-Hosted** — agent runs in an Agent-OS-managed ExecutionSubstrate (e.g. OpenShell): the full
  set holds *by construction*, including attest-the-negative (over OS-enforced channels).
- **Tier-Brokered** — agent runs elsewhere but all credentials/egress/effects route through the Agent
  OS in-path proxy: credential-blindness + maker-checker + commit-before-effect hold; attest-the-negative
  is bounded to brokered channels.
- **Tier-SDK** — foreign-runtime self-report: a tamper-evident ledger of *what was reported*, explicitly
  NOT proof-of-negative and forgeable upstream of the SDK. Sell it as exactly that.

> Business gate (non-engineering, does NOT block the build): before scaling GTM on the c1/c2/c4
> evidence-grade value, secure SF3 — a design-partner's outside counsel / auditor / E&O underwriter
> confirming **in writing** that a signed, independently-verifiable WORM bundle is preferred-and-admissible
> (an asset, not a discoverable liability). Beachhead motion: c3 Tenant-Sealed Fleet, then c6 Agent Escrow.

Built as a **layer ABOVE NVIDIA OpenShell** (integration **strategy B**; we do **not** fork it):
OpenShell is the kernel + security primitives (sandbox isolation, policy proxy, credential injection,
OCSF audit); Agent OS is the userland + product layer that adds the domain objects OpenShell lacks
(Task, Tool registry, ApprovalRequest, Tenant, AgentSession, timeline, Artifact) and drives OpenShell
via gRPC / SDK / CLI.

Background and decisions:
- `docs/research/decision-integration-strategy.md` — why strategy B.
- `docs/research/openshell.md` — what we reuse from OpenShell vs. build ourselves.
- `docs/research/loops.md` — loop research and the product's 8 security custom loops.
- `docs/dev-loops.md` — the development loop system (full tables).

## Non-negotiable security invariants

- **Deny-by-default** for every capability (file / network / process / inference / credential).
  Unknown ⇒ deny.
- **Fail closed**: malformed input, missing context, or an internal error ⇒ `deny`, never `allow`.
- **Credentials are NEVER** written to workspace files, logs, artifacts, snapshots, traces, or test
  fixtures. Raw secrets never enter persistence or audit payloads.
- **Every privileged decision/action emits a complete, auditable `AuditEvent`** (actor / tenant /
  project / task / sandbox? / action / resource / policy_decision / timestamp / request_id / result).
- **Cross-tenant access is impossible by construction** (enterprise = gateway-per-tenant) and is
  covered by tests.
- **Agent-generated policy changes require review/approval.**
- The agent process is **untrusted**. Treat sandbox escape, credential leakage, policy bypass, and
  cross-tenant access as critical failures.

## Looping Engineering — MANDATORY development methodology

We develop, test, and accept work using closed-loop workflows (borrowed from
[loops.elorm.xyz](https://loops.elorm.xyz/); full mapping in `docs/dev-loops.md`). **These are
requirements, not suggestions:**

1. **Universal gate.** `pnpm run verify` (= `typecheck && lint && build && test && secret-scan`) is
   the single source of truth for "does it work".
2. **Only command output is truth.** NEVER claim something is done/working without the gate's exit
   code (or an equivalent real command) proving it. Self-reported success is not accepted.
3. **Test-first (TDD) for new behavior.** Write a FAILING test (RED) → make it pass (GREEN) →
   refactor. Do **not** write implementation before its test exists and fails.
4. **Every self-paced or scheduled loop MUST declare an iteration cap.** A cap is a safety control,
   not optional — it is the only backstop if an exit condition is mis-specified. **No unbounded or
   background loops.** (If stuck after 3 iterations, stop and re-evaluate the approach.)
5. **Deny-by-default lives in HOOKS (prevention).** Loops and cron are *verification/assurance* only.
   Never rely on a poller to enforce a deny-by-default rule — a poller can only detect a violation
   after the fact; a hook denies it at the moment it happens.
6. **Pre-Commit Guard.** `.githooks/pre-commit` runs `pnpm run verify` and **blocks failing commits**
   (`git config core.hooksPath .githooks`). **Never** skip hooks (`git commit --no-verify` is
   forbidden) and **never** disable, delete, or weaken a test or security check to make a loop go
   green.
7. **Acceptance gate.** Before a task is "done", run an **Independent Verifier Pass**: an independent
   reviewer with **fresh context** that re-runs `pnpm run verify` and **adversarially probes** the
   security invariants (try to break deny-by-default, fail-closed, audit completeness, credential
   non-leak). Its findings drive a fix → re-verify loop until clean.
8. **Guardrails Learning.** If the same failure appears **twice**, record it in `docs/guardrails.md`
   (symptom → root cause → guardrail) **before** continuing.
9. **Slice discipline + mandatory adversarial code review.** Implementation proceeds in small,
   independently-verifiable **slices** (see `docs/standards/slice-spec.md`). **Every completed slice
   MUST pass an adversarial code review** — a reviewer with fresh context whose job is to BREAK it
   (see `docs/standards/adversarial-code-review.md`) — **before it merges**. No slice merges on
   self-review alone.

### Tier map (full tables in `docs/dev-loops.md`)

| Tier | Purpose | Mechanism | Examples |
|---|---|---|---|
| 0 | Prevention | **hooks** | Pre-Commit Guard, Post-Edit Test Guard |
| 1 | Convergence | **capped `/loop`** | TDD, Lint+Typecheck→Build→Test Until Green, Guardrails Learning |
| 2 | Acceptance | independent / review | **Independent Verifier Pass**, PR Self-Review, stage review gates, Ship PR Until Green |
| 3 | Assurance | **cron / schedule** | CI Watcher, Security/Dependency Audit, Deploy Verification |

## Coding standards

- Small, reviewable changes. No broad rewrites unless explicitly necessary.
- Typed schemas (Zod) at every trust boundary; remember TypeScript types are **not** a runtime
  security boundary — validate at runtime.
- Prefer boring, reliable engineering over clever abstractions (YAGNI / DRY).
- Errors must be actionable. No hidden network calls. No global mutable state without justification.
- Make task execution idempotent where possible.
- Never add a dependency without justification.
- Add/update docs when behavior, commands, APIs, policies, or configuration change.

### Low coupling, high cohesion (HARD CONSTRAINT)

Non-negotiable for every module, slice, and component:

- **High cohesion** — one clear responsibility per module; unrelated concerns live elsewhere.
- **Low coupling** — minimal, explicit, one-directional dependencies. A module is used only through
  its **public surface** (`index.*` / a declared interface); **no deep imports into another
  module's internals**.
- **Acyclic, inward-pointing dependencies** (domain ← application ← adapters). **No dependency
  cycles.** The OpenShell adapter, the Go evidence kernel, the SDKs, and the UI communicate only
  through typed contracts (proto / Zod), never each other's internals.
- **Concerns do not leak across layers** (CLI/UI · orchestration · approval · tool registry · policy
  · credential · sandbox adapter · inference · audit · persistence · tenant/IAM).
- **Depend on interfaces, not implementations**; inject dependencies; no hidden global state.
- **Enforced, not aspirational** — illegal or cyclic cross-module dependencies MUST fail
  `pnpm run verify` (a dependency-boundary check), and coupling/cohesion is an explicit, blocking
  dimension of the adversarial code review every slice must pass.

## Definition of Done (apply to every task)

- [ ] **Test-first**: a failing test existed before the implementation.
- [ ] `pnpm run verify` exits 0 — show the result.
- [ ] **Independent Verifier Pass = PASS** (invariants adversarially probed; findings resolved).
- [ ] secret-scan clean; no secret-like value in any source/log/output.
- [ ] Docs updated if behavior/commands/policies changed.
- [ ] **Low coupling / high cohesion**: no new cross-module or cyclic dependency; the touched module
  is reached only via its public surface (dependency-boundary check green).
- [ ] **Adversarial code review = PASS** for the slice (a fresh-context reviewer tried to break it;
  findings resolved) — required before merge.
- [ ] Stage review gate run where applicable. **Never claim done without command proof.**
