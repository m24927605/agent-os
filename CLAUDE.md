# CLAUDE.md

**[`AGENTS.md`](./AGENTS.md) is the authoritative operating contract for this repo — read it first
and follow it.** This file only adds Claude-Code-specific mechanics for the Looping Engineering
methodology that AGENTS.md mandates. On any conflict, AGENTS.md wins.

## Run the gate

- `pnpm run verify` — the universal feedback gate (`typecheck && lint && build && test && secret-scan`).
  Its exit code is the only acceptable proof of "works". Never substitute your own judgement.
- The Pre-Commit Guard is wired via `git config core.hooksPath .githooks`. **Never bypass it**
  (`--no-verify` is forbidden).

## Map the loop tiers → Claude Code mechanisms

- **Tier 1 — convergence (capped `/loop`):** use the `/tdd` skill for test-first Red→Green→Refactor
  and `/investigate` for debugging. Always keep an explicit iteration cap.
- **Tier 2 — acceptance (Independent Verifier Pass):** spawn an independent agent with **fresh
  context** (Task/Agent tool) that re-runs `pnpm run verify` and adversarially probes the security
  invariants; then `/review` on the diff. Do this before declaring any task done.
- **Stage review gates (per the global CLAUDE.md → Codex):** run at stage transitions, caps built in
  (≤5 iterations/stage; 3 consecutive fails ⇒ switch to a global fix strategy; 5 fails ⇒ stop and
  notify):
  - Task: `BASELINE=$(git rev-parse HEAD) && CODEX_REVIEW_ITERATION=1 ~/.claude/hooks/codex-review.sh task $BASELINE --project-dir $PWD`
  - Final: `CODEX_REVIEW_ITERATION=1 ~/.claude/hooks/codex-review.sh final branch:main --project-dir $PWD`
- **New feature exploration:** run `~/.claude/hooks/codex-brainstorm.sh` first (per the global
  CLAUDE.md), review its output, then build.
- **Tier 3 — assurance:** schedule with cron / `/schedule` once there is CI / a deploy target.

## Hard rules (restated from AGENTS.md — do not violate)

- **Test-first.** No implementation before a failing test exists and is seen to fail.
- **Only command output counts.** Never claim done without `pnpm run verify` green **and** an
  Independent Verifier PASS.
- **Never** skip the pre-commit hook; **never** disable/weaken a test or security check to go green.
- **Every `/loop` has an iteration cap.** Deny-by-default belongs in hooks, never in a poller.
- **Deny-by-default & fail-closed** are the law: unknown / malformed / error ⇒ deny.
- **Credentials never** touch workspace files, logs, artifacts, snapshots, traces, or fixtures.
