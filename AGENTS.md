# AGENTS.md — Operating contract for the Agent OS repository

**This file is BINDING for any AI agent** (Claude Code, Codex, Cursor, OpenClaw, …) working in this
repository. It is the authoritative operating contract. If a tool also reads `CLAUDE.md`, that file
only adds tool-specific mechanics — **AGENTS.md wins on any conflict.**

## What Agent OS is (north star)

**Agent OS is a complete product — a computer that operates itself by intent.** You SAY or TYPE what
you want; the whole computer — browser, files, email, calendar, terminal, network, every app — does it.
The skill of "using a computer" is abolished. **Capability × experience is the headline.** It is built
as an OS for UNTRUSTED, AUTONOMOUS agents: a self-evolving **brain** (default **Hermes**, swappable via
the Brain Port) does the work; **OpenShell** is the **body** that operates a real computer; `agent-os`
is the **spine** (orchestration + contracts); and a **supporting safety subsystem** — deny-by-default
policy, credential-blind brokering, commit-before-effect, an independently-verifiable WORM record
("attester ≠ attested actor") — is the **seatbelt** that makes it safe to let an autonomous thing run
your computer/company. The seatbelt is support, NOT the product identity, and never a gate that shrinks
ambition. (Earlier drafts wrongly centered governance as the moat — that is correct engineering, wrong
product center; corrected 2026-06-20.)

Scope and stance (confirmed product decisions):
- **We do NOT build the brain.** Agent OS *hosts* an existing third-party agent as the untrusted brain
  (default Hermes; Claude Code / OpenClaw / Codex swappable behind the same credential-blind Brain Port).
  The brain is the app; Agent OS is the OS that makes its output dependable, complete, and safe.
- **Any autonomous agent, any domain.** Keep the domain model (Task, AgentSession, ToolManifest, …)
  agent-type-agnostic — do not bake in coding-specific assumptions.
- **Experience-first for Personal/Enterprise; SDK/API is the contract spine + the Developer surface.**
  Personal is voice/text intent (easier than a phone, zero learning cost); the SDK/API is how developers
  extend the computer and how components compose, not the end-user surface.

The OS analogy is literal: Brain ≈ the program/userland (does the work), OpenShell ExecutionSubstrate ≈
drivers + process isolation, Policy engine ≈ syscalls/permissions, Approval workflow ≈ sudo, AuditEvent
+ WORM kernel ≈ syslog (tamper-evident), Task/AgentSession ≈ process/scheduler, Credential provider +
Inference routing ≈ device/credential management, the per-surface shell ≈ the desktop you actually touch.

**One core, three surfaces of the same computer — capability × experience first** (founder intent;
governance is included as support, and NONE of the capability/experience ambition is removed). The
shared core = the **capability engine** (Brain Port → intent→plan→tool-call stream, OpenShell execution,
tool/skill ecosystem, workflow/memory) + the **experience layer** + the **supporting safety subsystem**
(evidence kernel + PDP + credential-blind + the `ExecutionSubstrate` abstraction; OpenShell = substrate #1).
The three surfaces differ only in shell:
- **Personal — a computer that operates itself.** A non-technical person speaks/types intent and the
  whole computer operates itself for them — no Windows/Mac/Office/networking skills, easier than a phone,
  minimal learning cost. The computer disappears behind intent.
- **Enterprise — one person runs the whole company.** A fleet of governed brains runs the org's
  workflows: knows internal processes, rigorous workflows, disaster recovery, compliance, self-optimizes,
  evolves, finds and fixes problems, cuts cost, reasons up opportunities, runs experiments.
- **Developer — build and extend on it.** SDK + ToolManifest authoring + a signed skill/agent ecosystem
  on OpenShell, so the computer keeps gaining abilities; everything routes through the same governed path.

> Full product architecture, approach, phased plan, and the immediate P2 slices:
> [`docs/design/three-surface-architecture.md`](./design/three-surface-architecture.md). Hard capabilities
> (reliable arbitrary-app operation, long-horizon autonomy, learning an org, self-optimization) are an
> engineering ROADMAP the architecture grows into — never a reason to narrow the product.

**Guarantee Ladder (honest scoping — never let a weaker surface imply a stronger one's guarantee):**
- **Tier-Hosted** — agent runs in an Agent-OS-managed ExecutionSubstrate (e.g. OpenShell): the full
  set holds *by construction*, including attest-the-negative (over OS-enforced channels).
- **Tier-Brokered** — agent runs elsewhere but all credentials/egress/effects route through the Agent
  OS in-path proxy: credential-blindness + maker-checker + commit-before-effect hold; attest-the-negative
  is bounded to brokered channels.
- **Tier-SDK** — foreign-runtime self-report: a tamper-evident ledger of *what was reported*, explicitly
  NOT proof-of-negative and forgeable upstream of the SDK. Label it as exactly that (honest scoping).

**Supporting-subsystem integrity invariant (NON-NEGOTIABLE — release-blocking, same tier as deny-by-default):**
when the safety subsystem makes a trust claim, the standalone verifier MUST verify signature + chain + gap
**offline, without the Agent OS backend, and without trusting the operator** (release-blocking conformance
suite); any design that re-binds the attester to the operator (operator can rewrite the chain; verifier must
trust our backend) is a ship-blocking failure. This keeps the seatbelt honest — it does NOT make governance
the product, and it never gates the capability/experience work.

> Commercial / admissibility framing (business, NON-engineering, does NOT block the build and is NOT the
> product identity) is tracked in [`docs/roadmap.md`](./roadmap.md) (Guarantee-Ladder pricing discipline,
> SF3 admissibility, SF6 externalized signing root). The founder does not optimize for business; do not
> let it re-center the product.

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

### Pluggable components — NO forced vendor combination (HARD CONSTRAINT — founder, 2026-06-20)

**EVERY external component is swappable; NONE may be hard-coupled into the core.** Agent OS is a
high-flexibility, low-coupling/high-cohesion Agent OS. The combination
`{ OpenShell (substrate) + Hermes (brain) + AGT-derived (policy/governance adapter) + SpendGuard (cost
gate) }` is the **DEFAULT REFERENCE combination — NOT a mandated one.** Hermes is one brain among many,
not the only agent framework. **Agent OS's identity = the OS + its ports + its contracts — never any
vendor.** Each pluggable slot is a vendor-neutral port behind which a vendor lives as ONE adapter:

| Slot | Port | Default adapter | Swappable for |
|---|---|---|---|
| Brain (agent framework) | Brain Port | Hermes | Claude Code / OpenClaw / Codex / custom |
| Execution substrate | ExecutionSubstrate / SandboxAdapter | OpenShell | LocalProcess / other sandbox |
| Policy / governance adapter | Policy Port | AGT-derived | our PDP / other policy engine |
| Cost gate | CostGate Port | SpendGuard | other budget enforcer / none |

**PRODUCT BUILD COMMITMENT (founder mandate, 2026-06-20):** the v1 product is built and shipped on
EXACTLY this combination — Hermes + OpenShell + AGT + SpendGuard — and **ALL THREE surfaces (Personal /
Enterprise / Developer) must be FULLY supported.** This is the committed concrete stack: these four are
the implemented, wired, shipped DEFAULT ADAPTERS. It does NOT contradict pluggability: they live behind
the vendor-neutral ports above, so the invariant still holds (a future swap is a config/adapter change,
the ports/contracts/audit-root are unchanged) — "must use this combination" means *this is what we
build*, NOT *hard-wire and drop the ports*. (If a slot's vendor is ever dropped, the port + a fake impl
remain so the constraint above is still command-verifiable.) Honest scope note: fixing the stack fixes
the INPUTS; it does NOT by itself deliver full three-surface support — the defining top-layer of each
surface is still NEW Agent OS build (Personal zero-skill shell; Enterprise multi-tenant + the durable
operator-independent WORM audit root; Developer governance-native SDK), the four overlapping
policy/credential/audit models must be deduped into one path (PDP-only deny authority, OpenShell
SecretResolver-only credential model, WORM-kernel-only evidence root), and the hardest capabilities stay
a capability roadmap the architecture grows into — never silently descoped.

Non-negotiable for EVERY slot above (and any future third-party tool):

- **Vendor-neutral ports.** Core types, contracts, and module paths MUST NOT name a vendor (no
  `hermes`/`openshell`/`agt`/`spendguard` in core or port names) — vendors live only under their adapter
  module (e.g. `src/runtime/substrate/openshell/`, the brain adapter/shim, `src/policy/adapters/…`,
  `src/cost/adapters/spendguard/`). The audit root (Go WORM kernel + offline verifier) is NOT a pluggable
  slot — it is the OS itself and stays ours.
- **Vendor importable only from its own adapter module.** A vendor import from the core MUST fail
  `pnpm run verify` (TS dependency-cruiser `deps:check` + Python `import-linter` + Go depguard).
- **Proven by a second implementation (not asserted).** Each port ships a vendor-neutral **contract
  test** + **≥2 implementations** (real + a fake/second adapter) that both pass it — e.g.
  `OpenShellSubstrate` + `Fake/LocalProcess`; `HermesBrain` + `FakeBrain`. Flexibility is real only when
  a second impl exists.
- **Swapping is a config/adapter change, never a core rewrite.** The core, PDP, audit spine, and
  contracts are unchanged by swapping any brain / substrate / policy adapter / cost gate.
- **Enforced + blocking** — a vendor leak into the core, a missing contract test, or a port with only
  one implementation is a blocking dimension of the per-slice adversarial review and must fail `verify`.

## Definition of Done (apply to every task)

- [ ] **Test-first**: a failing test existed before the implementation.
- [ ] `pnpm run verify` exits 0 — show the result.
- [ ] **Independent Verifier Pass = PASS** (invariants adversarially probed; findings resolved).
- [ ] secret-scan clean; no secret-like value in any source/log/output.
- [ ] Docs updated if behavior/commands/policies changed.
- [ ] **Low coupling / high cohesion**: no new cross-module or cyclic dependency; the touched module
  is reached only via its public surface (dependency-boundary check green).
- [ ] **Pluggable brain + substrate**: any code touching the brain or execution substrate goes through
  the vendor-neutral port; no vendor (`hermes`/`openshell`) imported outside its adapter module; if a
  port is touched, its contract test + ≥2 implementations stay green (swap = config, not rewrite).
- [ ] **Adversarial code review = PASS** for the slice (a fresh-context reviewer tried to break it;
  findings resolved) — required before merge.
- [ ] Stage review gate run where applicable. **Never claim done without command proof.**
