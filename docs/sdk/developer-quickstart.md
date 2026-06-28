# Developer Quickstart: Lint a Manifest, Run a Tool, Verify the Chain

> **Audience:** developers evaluating Agent OS for the first time.
> **Goal:** go from a fresh clone to three governed first-value moments in **under 15 minutes** —
> (1) lint a tool manifest, (2) run a tool through the governed kit, (3) independently recompute the
> evidence chain.
> **The one rule of this repo:** *only command output is truth.* Every command below was run to
> confirm its exit code; if a command exits non-zero, the gate bit you on purpose (fail-closed).

Agent OS is a **library, not a service** — there is no `agent-os serve`. You compose a governed agent
surface inside your own process. This quickstart drives the **Developer** surface, whose distinctive
first-value is **independent verifiability**: you don't have to trust the operator, you *recompute*
the audit trail yourself.

---

## 0. Honest scope (read this first)

- **`agent-os` is a private, in-repo package right now.** `npm install agent-os` does **not** resolve
  yet. Everything below uses the **in-repo path**: clone, `pnpm install`, run the repo's own scripts.
  The `import { createDeveloperKit } from "agent-os/developer"` form you'll see in
  [`composition-root-guide.md`](./composition-root-guide.md) is the *production* import shape; this
  quickstart runs the same code via the in-repo reference example
  ([`examples/surfaces/run-developer-kit.ts`](../../examples/surfaces/run-developer-kit.ts)).
- **The kit defaults to a fully in-memory composition** (in-memory WORM log with a generated ed25519
  key, a fake sandbox, an in-memory cost gate). That is real governance end-to-end with **zero
  external dependencies** — but the adapters are fakes that show the wiring. Going to production means
  swapping the fakes for real adapters behind the same ports; that boundary is deploy-gated and is
  documented in [`composition-root-guide.md`](./composition-root-guide.md) §5.
- **Step 3 has two layers.** The kit's `replayFold()` is a pure in-process recompute you can run right
  now. The *real attestation* boundary (`attester ≠ actor`) is the **separately released verifier
  binary**, which you build via a deploy-gated release step — see
  [`verifier-release.md`](./verifier-release.md). This quickstart is explicit about which is which.

---

## 1. Prerequisites (~2 minutes)

| Requirement | Version | Check |
|---|---|---|
| Node.js | `>= 22` (from `package.json` `engines`) | `node --version` |
| pnpm | `9.15.4` (the repo's `packageManager`) | `pnpm --version` |

> The example file is run directly with `node` (Node ≥ 22 strips TypeScript types natively), so you do
> **not** need a separate `ts-node`.

```bash
git clone <your-repo-remote> agent-os
cd agent-os
pnpm install
```

`pnpm install` resolves the two runtime dependencies (`@grpc/grpc-js`, `zod`) plus the dev toolchain.
No network calls happen at runtime in this quickstart.

---

## 2. Build the CLI (~1 minute)

The `agentos` CLI ships as a compiled `dist/cli/main.js`. Build it once:

```bash
pnpm run build
```

That runs `tsc -p tsconfig.build.json` and emits `dist/`. You can now invoke the CLI two ways:

```bash
node dist/cli/main.js <subcommand> ...     # what this guide uses (explicit, no install step)
# or, if you link the package locally:  agentos <subcommand> ...   (the bin name is `agentos`)
```

Run it with no arguments to see the exact, real usage line (it exits **2** — fail-closed, never a
silent 0):

```bash
node dist/cli/main.js
# usage: agentos <manifest lint <file> | verify --chain <f> --pubkey <f> | doctor | setup [--config <path>] [--print] [--non-interactive]>
# exit code: 2
```

---

## 3. First value #1 — lint a tool manifest (~3 minutes)

A **ToolManifest** is a vendor-neutral declaration of one tool's side-effect semantics. The governance
core reasons about it; you declare the contract once and never carry a credential. The schema is owned
by `src/tools/manifest.ts` and has **ten required fields** — it is `.strict()`, so any unknown field
is rejected and any missing field fails the parse. (For the full field reference and the canonical
template, see [`tool-manifest-authoring.md`](./tool-manifest-authoring.md).)

### A tiny valid manifest

Save this as `echo-manifest.json`. It is a read-only tool in the `dev:` namespace — the namespace the
kit's default allow rule grants, so the same manifest also runs in step 4.

```json
{
  "name": "dev:echo",
  "version": "1.0.0",
  "description": "Echo a payload back. A read-only developer demo tool.",
  "action": "dev.echo",
  "resourcePattern": "dev:echo:*",
  "sideEffect": "read",
  "idempotent": true,
  "requiresApproval": false,
  "bundleRefOnly": true,
  "containment": "in-sandbox"
}
```

Lint it:

```bash
node dist/cli/main.js manifest lint echo-manifest.json
# ok dev:echo@1.0.0
# exit code: 0
```

Exit **0** means structurally legal *and* both cross-field guardrails satisfied. `ok <name>@<version>`
is printed to stdout.

### Watch the gate bite (fail-closed)

The schema enforces two guardrails. **Guardrail B:** a `destructive` tool must set
`requiresApproval: true`. Make a deliberately broken manifest — `destructive` but skipping approval:

```json
{
  "name": "dev:delete",
  "version": "1.0.0",
  "description": "Delete something destructive without approval.",
  "action": "dev.delete",
  "resourcePattern": "dev:delete:*",
  "sideEffect": "destructive",
  "idempotent": false,
  "requiresApproval": false,
  "bundleRefOnly": true,
  "containment": "in-sandbox"
}
```

```bash
node dist/cli/main.js manifest lint broken-manifest.json
# invalid: [
#   {
#     "code": "custom",
#     "path": [ "requiresApproval" ],
#     "message": "sideEffect \"destructive\" implies requiresApproval: true"
#   }
# ]
# exit code: 1
```

Exit **1**, with the reason on stderr. The broken manifest is **never** silently accepted. Set
`"requiresApproval": true` and the same command exits 0. (A missing file or non-JSON input also exits
**1** with a clear stderr message — fail-closed by construction.)

> **Other guardrail (A):** if `sideEffect` is `"none"`, then `idempotent` must be `true`. Both
> guardrails live in `src/tools/manifest.ts`; the lint is the single source of truth for legality.

---

## 4. First value #2 — run a tool through the governed kit (~3 minutes)

Now run a tool *through the full governance spine* — not just lint its contract. The reference
composition root ([`examples/surfaces/run-developer-kit.ts`](../../examples/surfaces/run-developer-kit.ts))
authors a manifest into the kit's deny-by-default registry, then runs it through the governed
pipeline: **screen → registry-backed authorize → cost → commit-before-effect → effect → WORM**.

```bash
pnpm run example:developer
```

This script does `pnpm run build && node examples/surfaces/run-developer-kit.ts`. It prints a
credential-blind governed-outcome summary and exits **0**:

```json
{
  "surface": "developer",
  "decision": "executed",
  "registeredToolCount": 1,
  "sandboxCreated": true,
  "replayStepCount": 1,
  "replayDeterministic": true,
  "usedInMemoryDefaults": true
}
```

What each field proves:

- **`decision: "executed"`** — the call was screened for secrets, allowed by the registry-backed PDP,
  reserved against the cost gate, **committed to the WORM *before* the effect ran**, executed, and
  recorded. The full seatbelt, in memory.
- **`registeredToolCount: 1`** — exactly one tool was authored into the deny-by-default registry. An
  *unregistered* tool would be denied before the PDP is even consulted.
- **`sandboxCreated: true`** — the (fake) sandbox effect actually ran (proof it wasn't short-circuited).
- **`replayStepCount: 1` / `replayDeterministic: true`** — the WORM was folded twice and produced the
  same `timelineHash` (step 5's recompute spine).

### The real API shape (when you adopt the kit)

The example wires the kit so you can copy it. The actual facade (`src/developer/bootstrap.ts`):

```ts
import { createDeveloperKit } from "agent-os/developer";   // production import shape (in-repo today)

const kit = createDeveloperKit();                  // in-memory defaults: registry, WORM (ed25519), cost
const binding = kit.authorTool(manifest);          // register into the deny-by-default registry
const outcome = await kit.runTool({                // governed execution
  tool: binding.name,
  context: { actorId, tenantId, projectId, taskId, requestId },
  args: { bundle: kit.bundleRefFor("dev:echo:payload") },   // credential-blind: a `bundle://` REFERENCE, never a secret
});
// outcome.status === "executed"  (or "denied" with { stage, reason } if a gate refused)
```

> **Credential-blind by construction:** `bundleRefFor(...)` returns a `bundle://<pattern>` *reference*,
> never a literal credential. The screen stage rejects any real secret that slips into `args`.

---

## 5. First value #3 — independently recompute / verify the chain (~3 minutes)

This is the Developer surface's distinctive guarantee: **reading is not attesting.** You re-derive the
audit trail yourself rather than trusting the operator's word.

### 5a. In-process recompute — `replayFold()` (runs now, no binary)

The kit folds its own WORM into a deterministic timeline. You already exercised this in step 4
(`replayStepCount` / `replayDeterministic`). In code:

```ts
const a = kit.replayFold();
const b = kit.replayFold();
console.log(a.timelineHash === b.timelineHash);   // true — deterministic recompute
```

`replayFold()` is a **pure TS fold** over the same WORM entries the commit-before-effect appender
wrote. It proves the recompute spine without any external binary. It does **not** recompute the signed
chain hash — that is deliberately the released verifier's job, across a process boundary.

### 5b. Real attestation — the released verifier binary (deploy-gated)

The `attester ≠ actor` moat is a **standalone verifier binary** that depends only on the chain-verify
logic, never on the producer. An auditor trusts that small binary instead of your platform. It is
**not** shipped in this zero-dep quickstart — you build it via a release step that requires a Go
toolchain:

```bash
pnpm run verifier:release          # builds dist/verifier/* (deploy-gated; needs Go) — see verifier-release.md
```

Once you have a verifier binary, the CLI relays its verdict verbatim. Point `AGENTOS_VERIFIER_BIN` at
the built binary and hand it the auditor's public key:

```bash
AGENTOS_VERIFIER_BIN=./dist/verifier/verifier-darwin-arm64 \
  node dist/cli/main.js verify --chain chain.json --pubkey auditor-pub.pem
# exit 0 = chain intact | exit 1 = chain broken (reorder/tamper/gap/bad signature) | exit 2 = bad input
```

The Ed25519 public key is supplied by *you, the auditor*, at verification time — the verifier never
pins or externalizes the trust root (that is a later phase). The full release/usage/WASM story is in
[`verifier-release.md`](./verifier-release.md).

**Fail-closed proof:** if the verifier binary is absent or unrunnable, the CLI exits **2** and
**never** reports the chain as intact:

```bash
AGENTOS_VERIFIER_BIN=/no/such/verifier \
  node dist/cli/main.js verify --chain chain.json --pubkey auditor-pub.pem
# error: cannot run verifier '/no/such/verifier': spawnSync /no/such/verifier ENOENT
# exit code: 2
```

The kit exposes the same flow programmatically: `kit.publicKeyPem()` gives an auditor your WORM's
public trust-root, and `kit.verifyEvidenceChain(pubkeyPath)` spawns the released verifier and relays
its 0/1/2 (fail-closed: an absent binary returns `{ ok: false }`, never `{ ok: true }`).

---

## 6. What you just proved

In under 15 minutes, with zero external services:

1. **Lint** — a manifest's legality is enforced by a strict, guardrailed schema; bad input fails closed
   (exit 1), good input exits 0.
2. **Run** — a tool only executes if it is *registered* (deny-by-default) **and** *allowed* (PDP), and
   it is **committed to the WORM before the effect runs**.
3. **Verify** — you recompute the audit trail yourself (`replayFold`), and the real `attester ≠ actor`
   attestation is a separate binary that relays a fail-closed 0/1/2 verdict.

---

## 7. Where to go next

- **Run a surface for real (the #1 adoption doc):**
  [`composition-root-guide.md`](./composition-root-guide.md) — the seven injected seams, the three
  surface factories, and the deploy-gated boundary where you swap the in-memory fakes for real
  adapters (Go-kernel WORM ingest, real sandbox, SpendGuard cost gate, KMS/HSM trust-root).
- **Author your own tools:** [`tool-manifest-authoring.md`](./tool-manifest-authoring.md) — the full
  field reference, the two guardrails, and the canonical template.
- **Independently verify as an auditor:** [`verifier-release.md`](./verifier-release.md) — building the
  reproducible, versioned, cross-platform + WASM verifier and its honest trust semantics.

> **Out of scope for this quickstart (intentionally):** `agentos doctor` / `agentos setup` are
> preflight + wizard commands for the *autonomous-execution (Hermes)* path — they check reachability
> of external services (OpenShell, the Go kernel) and are not needed for the in-memory Developer kit
> demonstrated here. See the composition-root guide before wiring those.
