# Contributing to Agent OS

> **Read [`AGENTS.md`](./AGENTS.md) first — it is the authoritative operating contract.** This guide is
> the English on-ramp into that contract for an external contributor: how to set up, how the loop
> actually runs, and the rules that never bend. On any conflict, AGENTS.md wins.

Agent OS is a governance kernel — the whole product is a seatbelt. So the bar for changes is high and
**enforced by tooling, not trust.** The good news: the tooling tells you exactly when you're done.

---

## 1. Before you write code

- Read **[Agent OS in 5 Minutes](./docs/concepts.md)** (the mental model) and the section of
  **[`AGENTS.md`](./AGENTS.md)** on the security invariants + the Looping methodology.
- Skim the standards you'll be held to: [`docs/standards/`](./docs/standards/) —
  [`looping-engineering.md`](./docs/standards/looping-engineering.md),
  [`slice-spec.md`](./docs/standards/slice-spec.md),
  [`adversarial-code-review.md`](./docs/standards/adversarial-code-review.md),
  [`test-and-acceptance.md`](./docs/standards/test-and-acceptance.md),
  [`engineering-standards.md`](./docs/standards/engineering-standards.md).

## 2. Setup

```bash
git clone <your-repo-url> && cd agent-os
# Node >= 22, pnpm 9.15.4
pnpm install
git config core.hooksPath .githooks   # ⚠️ REQUIRED — wires the Pre-Commit Guard
pnpm run verify                        # confirm a clean baseline (must exit 0)
```

`agent-os` is a private/in-repo package today (`npm install agent-os` does not resolve) — develop from
the clone. To see a surface run end-to-end: `pnpm run example:personal` / `example:developer` /
`example:enterprise`.

## 3. The one rule: only command output is truth

`pnpm run verify` is the single source of truth for "does it work." It is a 13-leg polyglot cascade:

```
typecheck · lint · build · test · deps:check · proto:check ×3 · verify:go · verify:py
· verify:cross-tenant · launcher:check · secret-scan
```

**Never** claim something works without the gate's exit code proving it. Self-reported success is not
accepted — not from a human, not from an AI agent.

## 4. The development loop

Work proceeds in small, independently-verifiable **slices** (see
[`slice-spec.md`](./docs/standards/slice-spec.md)). For each slice:

1. **Spec it** (for anything non-trivial): scope, invariants, test plan, rollback, honest deploy-gated
   boundary. Small spec for a fix; a full one for a feature.
2. **Test-first (RED).** Write the failing test *before* the implementation and **see it fail**. No
   implementation before a failing test exists. For a test that locks existing behavior, prove
   non-vacuity with a **mutation** (break the code → the test goes RED → revert).
3. **Make it pass (GREEN), then refactor.**
4. **`pnpm run verify` exits 0.** Show the result.
5. **Independent adversarial review (required before merge).** A reviewer with **fresh context** whose
   job is to *break* it: re-run `pnpm run verify`, adversarially probe the security invariants
   (try to defeat deny-by-default / fail-closed / credential non-leak / audit completeness), and run
   **non-vacuity mutations** on the new tests. Findings drive a fix → re-verify loop until clean.
   **No slice merges on self-review alone.** (For a low-risk additive change you may self-review with a
   documented non-vacuity mutation; security-critical changes always get a fresh-context reviewer.)
6. **Merge.** Branch off the default branch, open a PR, merge only when verify is green **and** the
   review is PASS.

**Caps:** any self-paced/scheduled loop declares an iteration cap. If you're stuck after **3
iterations**, stop and re-evaluate the approach — don't grind.

## 5. The Pre-Commit Guard (do not fight it)

`.githooks/pre-commit` runs `pnpm run verify` and **blocks failing commits**. This is the prevention
tier — deny-by-default lives in hooks, not in a poller.

- **Never** bypass it (`git commit --no-verify` is **forbidden**).
- **Never** disable, delete, or weaken a test or a security check to make the gate go green. That is
  the one unforgivable move here — a green-but-hollow gate is worse than a red one.
- If the same failure shows up **twice**, record it in `docs/guardrails.md` (symptom → root cause →
  guardrail) before continuing.

## 6. Security invariants you must never break

These are non-negotiable (see [`AGENTS.md`](./AGENTS.md) + [`docs/security-model.md`](./docs/security-model.md)):

- **Deny-by-default / fail-closed** — unknown / malformed / error ⇒ deny, everywhere.
- **Credential-blind** — credentials never touch source, logs, artifacts, snapshots, traces, or test
  fixtures. Use the placeholder model (`openshell:resolve:env:<KEY>`); the real secret is resolved only
  at the egress boundary. Build any test secret at runtime so secret-scan stays clean.
- **Commit-before-effect** — the WORM record is durable *before* the effect runs; signal a failed
  append by rejecting, never by resolving a falsy receipt.
- **Attester ≠ actor** — the thing that acts never signs its own record; the brain can never
  self-attest or self-restore.
- **Authorization is the PDP** — allow/deny policy rules *are* the authz model. There is deliberately
  **no separate RBAC layer** (`src/iam` is identity-only); this is intentional design, not a gap.

## 7. Coding standards (enforced)

- **Low coupling / high cohesion** — no new cross-module or cyclic dependency; a module is reached only
  via its public surface. The dependency-boundary check (`deps:check`) **fails the build** on a
  violation, including **no vendor in core**.
- **Pluggable brain + substrate** — anything touching the brain or execution substrate goes through the
  vendor-neutral **port**; no vendor (`hermes` / `openshell`) is imported outside its adapter module. A
  port keeps **≥2 implementations + a contract test** (swap = config, not rewrite).
- **Zod at every trust boundary** — validate at runtime; TypeScript types are not a runtime security
  boundary.
- **Be honest about deploy-gated** — if something needs real infra (KMS trust-root, sandbox,
  multi-tenant), say so; never let an in-memory fake read as production-ready.
- YAGNI / DRY; small reviewable changes; no broad rewrites; no hidden network calls; errors are
  actionable.

## 8. Definition of Done (every task)

- [ ] Test-first: a failing test existed before the implementation.
- [ ] `pnpm run verify` exits 0 — result shown.
- [ ] Independent Verifier / adversarial review = **PASS** (invariants probed; findings resolved) — before merge.
- [ ] secret-scan clean; no secret-like value in any source/log/output.
- [ ] Docs updated if behavior / commands / policies changed.
- [ ] Low coupling / high cohesion (dependency-boundary check green).
- [ ] Pluggable: ports' contract tests + ≥2 implementations stay green if a port is touched.
- [ ] Never claim done without command proof.

## 9. Commits & PRs

- Conventional, scoped commit subjects (`feat(brain):`, `fix(kernel):`, `docs:`, `test(cost):`).
- The body explains *why* + the verification (what RED proved, the mutation that proved non-vacuity,
  the review verdict). Reference the slice spec where one exists.
- Keep PRs slice-sized and independently reviewable.

## 10. Where the deeper playbook lives

- **The contract:** [`AGENTS.md`](./AGENTS.md).
- **Standards:** [`docs/standards/`](./docs/standards/) (looping, slice-spec, adversarial review, test/acceptance, engineering).
- **How surfaces are built:** [`docs/sdk/composition-root-guide.md`](./docs/sdk/composition-root-guide.md), [`docs/sdk/build-a-tool-family.md`](./docs/sdk/build-a-tool-family.md).
- **Build records (per-slice history):** [`docs/slices/`](./docs/slices/) — how each capability was actually built, reviewed, and merged.
- **Design notes:** [`docs/design/`](./docs/design/). **Guardrails (recurring failures):** `docs/guardrails.md`.

Welcome — build carefully, prove everything, and let the gate tell you when you're done.
