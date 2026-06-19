# Agent OS

A secure, policy-governed agent runtime, built as a **layer above [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)** (integration strategy B — we do not fork OpenShell). Two target modes: a local-first **Personal Agent Workstation** and a multi-tenant **Enterprise Agent Runtime Platform**.

Core principles: deny-by-default for every capability, credentials never persisted to the sandbox/logs/artifacts, and every privileged action is auditable.

## Status

Early scaffold. The first slice is the security core of the product/orchestration layer:

- `src/iam` — branded identity primitives (TenantId, ProjectId, TaskId, ActorId, RequestId…).
- `src/policy` — `PolicyRequest` / `PolicyDecision` and a **deny-by-default, fail-closed** evaluator.
- `src/audit` — a complete, schema-validated `AuditEvent` and **redaction-safe** serialization.

The OpenShell runtime adapter (CLI/SDK/gRPC) lands in a later task under `src/runtime/openshell`.

## Develop

```bash
pnpm install
pnpm run verify   # typecheck + lint + build + test + secret-scan (the universal gate)
pnpm test         # unit tests only
```

A `pre-commit` guard runs `pnpm run verify` and blocks commits that don't pass
(`git config core.hooksPath .githooks`). Never skip it.

## Docs

- [docs/dev-loops.md](./docs/dev-loops.md) — the Looping Engineering process we develop with.
- [docs/research/](./docs/research/) — OpenShell foundation analysis, loop research, and the
  [integration-strategy decision record](./docs/research/decision-integration-strategy.md).
