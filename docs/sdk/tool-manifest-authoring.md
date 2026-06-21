# Authoring a ToolManifest

> SLICE-P2R-R9-S4. Audience: third-party tool authors using the Agent OS Developer SDK.
> The schema, its fields, and its consistency guardrails are owned by **R3** (`src/tools`); this
> document and the template only **consume** that contract. **only command output is truth** — the
> single proof that your manifest is legal is `agentos manifest lint <file>` exiting `0`.

A **ToolManifest** is an agent-agnostic, vendor-neutral declaration of one tool's side-effect
semantics. It is how you tell Agent OS what a tool *does* — so the governance core (PDP → lease →
commit-before-effect → sandbox) can reason about it. You declare the contract once; you never carry a
credential and you never bypass governance.

## TL;DR — copy, edit, lint

1. Copy the template [`src/sdk/templates/tool-manifest.example.json`](../../src/sdk/templates/tool-manifest.example.json)
   to your tool's directory.
2. Change the values (keep all nine fields; unknown fields are rejected — the schema is `.strict()`).
3. Lint it:
   ```
   agentos manifest lint path/to/your-tool-manifest.json
   ```
   - exit `0` → structurally legal **and** both guardrails satisfied.
   - exit `1` → invalid (unknown/missing field, wrong type, or a guardrail violation). The reason is
     printed to stderr; the broken manifest is **never** silently accepted (fail-closed).

You can also load the canonical example programmatically from the SDK:

```ts
import { exampleToolManifest, loadExampleToolManifest } from "agent-os/sdk/templates";

const manifest = loadExampleToolManifest(); // validated via R3 parseToolManifest, throws on violation
```

## The nine fields (see R3 design §2.1 and `src/tools/manifest.ts`)

| Field | Type | Meaning |
|---|---|---|
| `name` | non-empty string | Stable identifier for the tool (e.g. `github-create-issue`). |
| `version` | non-empty string | Manifest/tool version (e.g. `1.0.0`). |
| `description` | non-empty string | Human-readable summary of what the tool does. |
| `action` | non-empty string | The action the tool performs (e.g. `github.issues.create`). |
| `resourcePattern` | non-empty string | Pattern of resources the tool may touch (e.g. `github:repo:acme/*`). |
| `sideEffect` | `"none" \| "read" \| "write" \| "destructive"` | The strongest effect this tool can have on the world. |
| `idempotent` | boolean | `true` if re-running the action is safe (no duplicate effect). |
| `requiresApproval` | boolean | `true` if a human must approve before the effect commits. |
| `bundleRefOnly` | boolean | `true` if the tool references credentials **only** by bundleRef (never inline). Keep this `true` — the SDK is credential-blind by construction; a bundleRef such as `"github:PAT:prod"` is a *reference*, never a secret. |

All string fields are trimmed and must be non-empty. Any field not in this list causes a parse
failure (`.strict()`) — unknown fields are an attack surface, not a convenience.

## The two consistency guardrails

The manifest is more than a shape check. R3 enforces two cross-field invariants; violating either
fails the lint:

- **Guardrail A — no side effect must be safely replayable.**
  If `sideEffect` is `"none"`, then `idempotent` **must** be `true`. A no-effect tool that claims it
  cannot be safely re-run is contradictory and is rejected.

- **Guardrail B — destructive actions must go through approval.**
  If `sideEffect` is `"destructive"`, then `requiresApproval` **must** be `true`. A destructive tool
  can never be authored to skip human approval.

These guardrails are why the template is a *trustworthy* starting point: copying it and only changing
benign values keeps you on the legal side of both rules.

### A deliberately broken manifest (to see the gate bite)

Take the template and make it destructive while skipping approval:

```json
{
  "name": "github-delete-repo",
  "version": "1.0.0",
  "description": "Delete a repository.",
  "action": "github.repos.delete",
  "resourcePattern": "github:repo:acme/*",
  "sideEffect": "destructive",
  "idempotent": false,
  "requiresApproval": false,
  "bundleRefOnly": true
}
```

`agentos manifest lint` on this file exits `1` (Guardrail B: `sideEffect "destructive" implies
requiresApproval: true`). Fix it by setting `"requiresApproval": true`, and the same command exits
`0`.

## Where this fits

The authoring template is the author-experience layer of the Developer SDK (R9). It consumes R3's
`parseToolManifest` through the SDK author barrel (`src/sdk/index.ts`) and is validated by the
`agentos manifest lint` CLI (R9-S3). It adds no schema logic of its own — see
[`docs/design/developer-sdk.md`](../design/developer-sdk.md) §2.2 (S4) for the design.
