# Agent OS in 5 Minutes: Concepts & Mental Model

> The front door. Read this first, then read the
> [Composition Root Guide](./sdk/composition-root-guide.md) to actually run a surface.
> Target read time: ~5 minutes.

## What Agent OS is, and the problem it solves

An AI agent that can *act* in the real world — run a shell command, send an email, click a
button in a browser — is powerful and dangerous in the same breath. The moment an autonomous,
untrusted "brain" can touch your files, your network, or your company's systems, you need an
answer to one question: **how do you let it act, but force every single action through one place
where it can be screened, authorized, budgeted, and recorded — before it happens?**

Agent OS is that one place. It is **a computer that operates itself by intent**: you say what you
want, a swappable agent proposes the work, and a small governance kernel routes every proposed
action through a single fail-closed gate before any real effect runs. The agent is treated as
**untrusted** at all times — Agent OS is the operating system that makes its output dependable
and safe.

Agent OS is a **library, not a service**. There is no daemon that magically governs your agent;
you wire a small composition root and route every effect through one function. That is the whole
trick, and it is what the rest of this doc explains.

## The vocabulary

Agent OS borrows the operating-system metaphor literally:

| Term | What it is | OS analogy |
|---|---|---|
| **Brain** | The agent / LLM that **proposes** the work — turns your intent into tool calls. Default is **Hermes**, swappable behind a vendor-neutral Brain Port. It never executes anything itself. | the program / userland |
| **Body** (substrate) | Where effects actually run — a real sandboxed computer. Default is **NVIDIA OpenShell**; swappable behind the `ExecutionSubstrate` port. | drivers + process isolation |
| **Spine** | `agent-os` itself: the **governance kernel** — one small, ordered, fail-closed orchestration pipeline plus vendor-neutral contracts that route every proposed action to a real effect. | syscalls + the scheduler |
| **WORM ledger** | A separate-process, append-only, hash-chained, cryptographically-signed evidence kernel (written in Go). Every privileged decision and effect lands here as a tamper-evident record. WORM = write-once, read-many. | syslog (tamper-evident) |
| **Tool families** | The kinds of effects a brain can propose, namespaced by family: **`exec.*`** (run commands in the body, e.g. `exec.run`, `exec.ls`), **`action.*`** (structured connector actions, e.g. sending mail), and **`browser.*`** (drive a real browser, e.g. `browser.navigate`, `browser.read`, `browser.click`). | the apps the userland can invoke |

The brain **proposes**; the spine **governs**; the body **executes**; the WORM ledger **records**.
No step is skippable.

## The four SEATBELT invariants (and why each matters)

The "seatbelt" is the safety subsystem that makes it *safe* to let an autonomous agent run your
computer or your company. It is load-bearing support, never the headline. Four invariants are
non-negotiable and fail-closed:

1. **Deny-by-default.** Every capability (file / network / process / inference / credential) is
   denied unless explicitly allowed. Unknown, malformed, or error ⇒ **deny**, never allow.
   *Why:* an untrusted brain that finds a gap should hit a wall, not an open door. There is one
   sole grant authority (the policy decision point); nothing else can say "yes."

2. **Credential-blind.** Raw secrets are **never** written to workspace files, logs, artifacts,
   snapshots, traces, or audit payloads. The brain's key never leaves its own home; the kernel
   brokers credentials without ever seeing or recording them. *Why:* the most damaging leak from
   an autonomous agent is a leaked credential — so credentials are structurally absent from every
   surface an attacker (or a careless log) could read.

3. **Commit-before-effect.** The audit record is appended to the WORM ledger — and the receipt is
   awaited — **before** the real effect runs. If the record can't be durably written, the effect
   never happens. *Why:* there must be **no un-recorded effect**. You can always read back exactly
   what was about to happen, even if the effect itself later fails.

4. **Attester ≠ actor (WORM).** The thing that *attests* to what happened (the evidence kernel +
   its offline verifier) is a separate process from the thing that *did* it (the operator running
   the agent). A third party can verify the chain — signature, hash-chain, no gaps — **offline,
   without the Agent OS backend, and without trusting the operator**. *Why:* "reading the log" is
   not the same as "proving the log wasn't rewritten." If the operator could forge or rewrite the
   record, the record would be worthless. (Honest scope: see the caveat below.)

## The one governed edge

Every brain-proposed tool call flows through exactly one function —
`runGovernedToolCall` in [`src/orchestration/pipeline.ts`](../src/orchestration/pipeline.ts) — a
short, fail-closed pipeline. Each stage short-circuits to **denied** on any failure; the real
effect runs *only* after every gate passes **and** the audit receipt is in hand.

```
  brain proposes a ToolCall
            │
            ▼
  ┌───────────────────────────────────────────────────────────┐
  │ runGovernedToolCall  (fail-closed — any gate denies)        │
  │                                                             │
  │  1. screen        credential-blind structural check         │
  │  2. authorize     PDP decision (sole deny authority)        │
  │  3. approval      ONLY if the allow needs it (e.g. destructive) │
  │  4. cost.reserve  budget hard-cap, reserved before effect   │
  │  5. commit ───►   append AuditEvent to WORM, AWAIT receipt  │ ──► WORM ledger
  │  6. effect        the real effect runs (body / connector)   │     (Go, separate
  │  7. cost.commit   settle the actual cost                    │      process,
  │  8. boundary      external effects: a distinct WORM record  │ ──►  hash-chained,
  │                                                             │      signed)
  └───────────────────────────────────────────────────────────┘
            │
            ▼
  outcome: { status: "executed", receipt, ... }  |  { status: "denied", stage, reason }
```

The pipeline names no vendor and reaches into no module's internals — every collaborator (the
screen, the authorize decision, the cost gate, the WORM appender, the effect) is **injected** by
the composition root. That is what keeps the OS identity from quietly collapsing into any one
vendor, and it is enforced by the build, not by etiquette.

## The three surfaces, one core

All three are runnable composition roots over the **same** spine — they differ only in the shell
the human or operator touches:

- **Personal** — a computer that operates itself by intent: type intent → the brain clarifies →
  renders a plain-language plan → **you approve** (the "sudo" step) → the governed pipeline runs
  it → a plain-language timeline reads the evidence back.
- **Enterprise** — *one person runs the company*: a gateway-per-tenant fleet with per-tenant
  independent log / budget / approval instances (cross-tenant access is structurally impossible)
  and operator maker-checker.
- **Developer** — the surface that exposes independent verifiability: author a tool, run it
  through the same governed pipeline, replay the evidence as a deterministic fold, and verify the
  chain yourself with a separately-released binary.

## Next steps

1. **You are here** — concepts & mental model.
2. **[Composition Root Guide](./sdk/composition-root-guide.md)** — go from "cloned the repo" to
   "a governed surface running in my process," using three runnable reference roots.
3. **Quickstart** — clone, install, and run the gate (see the repo README):

   ```bash
   # Node >= 22, pnpm 9.15.4
   pnpm install
   pnpm run verify   # the universal gate — the only accepted proof of "works"
   ```

   Then run the reference composition roots:

   ```bash
   pnpm run example:personal      # the Personal governed flow, zero external deps
   pnpm run example:developer     # the Developer kit + replay fold
   pnpm run example:enterprise    # the Enterprise per-tenant fleet
   ```

Related SDK docs: [Tool Manifest Authoring](./sdk/tool-manifest-authoring.md) (how to author a
deny-by-default tool) and [Verifier Release](./sdk/verifier-release.md) (how the offline,
operator-independent verifier is built and pinned).

---

### Honest caveats (this project's credibility is its honesty)

- **`agent-os` is currently a private/in-repo package.** `npm install agent-os` does **not**
  resolve externally yet. Every quickstart uses the in-repo path: `git clone` → `pnpm install` →
  the repo's own scripts.
- **Defaults are in-memory.** The surface factories default to an in-memory WORM log, a fake
  sandbox, and an in-memory cost gate. The real body (OpenShell), brain (Hermes), cost gate
  (SpendGuard), and Go kernel are **injected** when you point at real infra; the live wires are
  opt-in and infra-gated (they block cleanly when their infra is absent).
- **Attester ≠ actor is real to the process boundary today, but not yet operator-unforgeable.**
  Per-tenant signing keys are currently held in the kernel process (attester == operator *to the
  process boundary*). A trust root the operator genuinely cannot forge (KMS / HSM /
  remote-attestation) is a **deployment step**, not yet wired. This is the headline remaining work
  and it needs a deployment environment, not more in-repo code.
- The remaining gaps (real KMS/HSM trust root, zero-credential sandbox provisioning, CI/CD,
  observability, real multi-tenant provisioning) are **deployment-environment work, not missing
  code** — tracked in `docs/slices/`. See the README's *Status (honest)* section for the full,
  current picture.
