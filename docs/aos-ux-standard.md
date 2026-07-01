# AOS-UX — Agent OS Fail-Closed UX Conformance Standard (v1)

A concrete, repeatable, partly-automatable standard for **measuring Agent OS's user experience** — designed so
UX becomes a *gate* (a regression guard in `pnpm run verify`), not an opinion. Produced by a Staff+ UX panel
(UX Researcher / Developer Advocate / Product Manager / SRE).

**Core principle (fail-closed honesty).** A UX metric must never require leaking a secret or weakening
fail-closed. The automatable-now signals are reported **separately** from the human/deploy-gated ones, so a
strong CLI score is never inflated by uncollected perceived-usability data.

## The 7 dimensions

1. **Effectiveness & Activation** — did the persona reach the honest goal-state, in how few commands.
2. **Efficiency** — the cost of safety in commands/seconds; no hang under all-services-down.
3. **Failure Clarity & Recovery** — does every refusal NAME the fix, and is it legible + recoverable.
4. **Fail-Closed Honesty & Integrity** — no fake-green; exit-code truthfulness; drift gate; deny-by-default;
   offline verifier (attester ≠ actor).
5. **Learnability & Discoverability** — find the next action; self-documenting config; the two-plane secrets model.
6. **Credential-Blind Trust & Observability** — no secret ever leaks; every denial carries a reason; audit completeness.
7. **Perceived Usability & Persona-Fit** — SUS/SEQ per persona; minimal surface per profile; the Personal zero-skill packaged path.

## Scoring rubric

Each dimension is scored **1–5**. The standard reports a per-dimension score plus **two overalls**: the mean of
the **5 automatable-now dimensions** and, separately, the **2 human/deploy-gated dimensions** (never merged).

| Level | Meaning |
|-------|---------|
| 1 | no measurement + known failures |
| 2 | ad-hoc/manual evidence only; gaps unguarded |
| 3 | metric defined and passes today, but not wired as a regression guard |
| 4 | metric passes AND is an automated CI gate, with one named residual gap |
| 5 | fully automated gate, green, zero known gaps, adversarially probed (injected-fault matrix) |

A dimension that depends on a human/live-stack signal is **capped at 3** until that data is collected. Any
release-blocking invariant (no-fake-green, credential-blind, tampered-chain-never-0) scoring below 5 forces the
whole standard's headline to **"regression"** regardless of other scores.

## Metric suite

`auto` = capturable now from CLI exit codes / output / artifacts (no infra, no human, no secret).

| # | Metric | Dim | auto | Target |
|---|--------|-----|------|--------|
| 1 | No-fake-green honesty | D4 | ✅ | exit 0 iff all required PASS; a single false-green is release-blocking |
| 2 | Error-message-actionability rate | D3 | ✅ | 100% of FAIL/error lines name a fix (config field / command / flag) |
| 3 | Config-validation error legibility | D3 | ✅ | 0 raw JSON dumps; each names the field in prose (**fixed** — was setup.ts:296) |
| 4 | Scaffold-to-valid zero-edit round-trip | D1 | ✅ | 100% across personal\|enterprise\|developer |
| 5 | Commands-to-first-honest-outcome (CFHO) | D1 | ✅ | ≤3 to honest verdict; ≤4 to in-memory governed outcome; 0 non-zero exits en route |
| 6 | Drift-gate correctness | D4 | ✅ | 100% drift classes caught; 0 false positives on comment/whitespace edits |
| 7 | Offline-verifier truthfulness (attester≠actor) | D4 | ✅ | 100% correct 0/1/2; tampered chain returning 0 is release-blocking |
| 8 | Credential-blind output integrity | D6 | ✅ | 0 secret-value leaks across all paths — release-blocking |
| 9 | Refuse-if-exists slip-protection | D3 | ✅ | 100% — no silent overwrite anywhere |
| 10 | Per-command latency & no-hang | D2 | ✅ | p95 < 1s local; doctor < (probes × 750 ms)+1s; zero hangs |
| 11 | Help / command discoverability coverage | D5 | ✅ | 100% commands in `--help`; unknown → exit 2 + `--help` pointer |
| 12 | Config self-doc & explain-map completeness | D5 | ✅ | 100% schema fields described; 0 field→env drift |
| 13 | Self-heal rerun convergence (monotonic) | D3 | ✅ | strictly monotonic to 0; ≥90% unaided human recovery (human part) |
| 14 | Deny-reason presence & audit completeness | D6 | ✅ | 100% denies carry a reason; 5 classes distinct; partial event throws |
| 15 | Minimal-surface-per-persona | D7 | ✅ | exact section set per profile; 0 extra sections |
| 16 | Personal zero-skill packaged-path existence | D7 | ✅ | exists + reachable without CLI (**TODAY: FAILS** — only a dev-mediated example) |
| 17 | SUS + SEQ + fail-closed trust rating / persona | D7 | ❌ human | Operator/Dev SUS ≥68, Personal ≥80; SEQ ≥5.5/7; trust ≥4.2/5 — none collected |
| 18 | Two-plane secrets mental-model retention | D5 | ❌ human | ≥80% can articulate "KEY NAMES in config; values in env, resolved at egress" |

## Current score (2026-07-01, honest)

| Dim | Score | Note |
|-----|-------|------|
| D2 Efficiency | **5/5** | local ~0.17s; doctor bounded by TCP timeout, no hang |
| D4 Fail-Closed Honesty | **5/5** | live no-fake-green; drift gate; deny-by-default; offline verifier |
| D1 Effectiveness/Activation | **4/5** | 3-command CFHO; self-validating scaffold. Gap: doctor-GREEN is deploy-gated |
| D3 Failure Clarity/Recovery | **4/5** | field-aware hints; legible config errors (fixed). Gap: full human-recovery number |
| D5 Learnability | **4/5** | `--help`, 100% schema descriptions, `--explain --resolved`. Gap: secrets-model retention (human) |
| D6 Credential-Blind Trust | **3/5** | credential-blindness ~5/5; gap: **no `agentos audit why <requestId>`** query |
| D7 Perceived Usability/Persona-Fit | **1/5** | minimal-surface tested; gap: **no SUS collected; no Personal packaged app** |

**Automatable-now mean ≈ 4.4/5** (strong operator/developer CLI surface). **Human/perceived: essentially
uncollected** — honestly deferred, never inferred from the guard.

## Measurement protocol

Run **quarterly + on every PR touching `src/cli`, the renderer, policy, or the verifier.**

- **(A) Clean-room conformance harness** (auto): fresh dir, per profile run `setup --init` → `config render` →
  `config check` → `setup --explain --resolved` → `doctor`; record exit codes, per-command `time -p`, command
  count, files written.
- **(B) Fault matrix** (auto): injected DoctorProbes + bad configs drive every FAIL/error branch (kernel down,
  unregistered, drift, unknown key, wrong type, secret-shaped value, init-exists, unknown command, malformed
  render.lock); assert exit-code class, error-actionability, monotonic self-heal, no fake-green.
- **(C) Credential-blind sweep** (auto): sentinel on every known secret KEY + a secret-shaped config value; run
  all commands, scan all stdout/stderr + artifacts → 0 hits.
- **(D) Offline trust** (auto): the released verifier with the backend stopped, against intact/tampered/bad-input → 0/1/2.
- **(E) Infra lane** (deploy-gated, separate report, never inferred from A–D): with live Hermes+OpenShell+kernel,
  time clone→doctor-green + the live governed action (`e2e:live-*`).
- **(F) Human lane** (deploy-gated): moderated usability test, ≥5 users/persona, on T1 first-run / T2
  change-one-setting / T3 recover-from-failed-doctor; collect SUS/SEQ/trust + secrets-model retention +
  unaided-recovery rate.

Record every metric with its target into a **dated scorecard**; diff against the previous run to surface regressions.

## The automatable guard (shipped)

Lanes **(A)–(D)** are live as a single named guard: [`src/cli/aos-ux-conformance.test.ts`](../src/cli/aos-ux-conformance.test.ts),
which runs inside `pnpm run verify` — a **UX regression fails the gate**. It asserts metrics 1–5, 8, 11, 15
directly; the rest are guarded in the sibling CLI specs (`doctor.test.ts`, `config.test.ts`, `main.test.ts`,
`config-json-schema.test.ts`). Metric 16 (Personal packaged path) is intentionally **not** asserted as a gate
(it is RED by design — a product decision, below).

## Deferred (needs a decision + investment)

Five genuine decisions, not UX polish:

1. **Personal packaged path** — build an install → intent → approve → timeline app that needs no CLI/clone for
   the zero-skill persona (the biggest activation gap; the CLI is a *failure mode* for that persona).
2. **Deploy/infra lane** — stand up a standing Hermes+OpenShell+kernel lane so doctor-green / live action / MTTR
   become measurable (else keep them a separate manual report).
3. **Telemetry** — opt-in, credential-blind (KEY-name-presence-only) telemetry to convert conformance into real
   activation/retention numbers.
4. **`agentos audit why <requestId>`** (+ per-tenant rollup) to close the observability surfacing gap.
5. **Persona bars** — confirm the target split (Operator/Developer SUS ≥68, Personal ≥80) and fund the moderated
   usability test that is the only way to collect metrics 17–18.
