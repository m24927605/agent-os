# Agent OS

**An operating system for untrusted, autonomous AI agents.** Agent OS hosts existing third-party agents (Claude Code, OpenClaw, Codex, …) — it does **not** build its own agent — and lets *any* autonomous agent do real work (processes, files, network, credentials, inference) under deny-by-default policy, with every privileged action auditable, approvable, and credential-safe.

It is **API/SDK-first** (CLI/UI are secondary consumers of the same API) and is built as a **layer above [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)** (integration strategy B — we do not fork OpenShell). Two deployment modes: a local-first **Personal Agent Workstation** and a multi-tenant **Enterprise Agent Runtime Platform**.

Core principles: deny-by-default for every capability, credentials never persisted to the sandbox/logs/artifacts, and every privileged action is auditable.

## Status

Early scaffold. The first slice is the security core of the product/orchestration layer:

- `src/iam` — branded identity primitives + the `AgentContext` aggregate (the OCSF AgentContext mapping start; fail-closed, and the single source of identity for every `AuditEvent`).
- `src/policy` — `PolicyRequest` / `PolicyDecision` and a **deny-by-default, fail-closed** evaluator.
- `src/audit` — a complete, schema-validated `AuditEvent` (identity drawn from `AgentContext`) and **redaction-safe** serialization.
- Dev gate `pnpm run verify` includes `deps:check` (dependency-cruiser) enforcing low coupling / high cohesion.

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
