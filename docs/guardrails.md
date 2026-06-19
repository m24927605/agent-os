# Guardrails

Recurring failures and the guardrails that prevent them.

**Rule (Guardrails Learning Loop):** if the same failure appears **twice**, add an entry here —
symptom → root cause → guardrail — **before** continuing. See `AGENTS.md` and `docs/dev-loops.md`.

| Date | Symptom | Root cause | Guardrail (how we prevent recurrence) |
|------|---------|------------|----------------------------------------|
| 2026-06-19 | Cyclic deps / cross-module deep imports could erode low coupling unnoticed | HARD CONSTRAINT A was eye-enforced only | `deps:check` (dependency-cruiser: `no-circular`, `inward-only-domain-pure`, `not-to-internal`) is wired into `pnpm run verify` (SLICE-P0-003); violations exit non-zero. `src/iam/ids` is interim-allowlisted until the iam barrel-migration slice. |
