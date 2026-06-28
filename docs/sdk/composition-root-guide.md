# Composition Root Guide — How to Actually Run a Surface

> **Audience:** developers and platform/enterprise integrators adopting Agent OS.
> **Prerequisite:** read *Agent OS in 5 Minutes* (concepts) first. This guide is the **#1 thing you
> need to go from "cloned the repo" to "a governed agent surface running in my process."**

Agent OS is a **library, not a service**. There is no `agent-os serve` that magically governs your
agent. Instead, you write a small **composition root** that wires the governance kernel's injected
seams to your real adapters, and route **every** agent effect through the one governed edge. This
guide shows you exactly how, using three runnable reference roots you can copy.

---

## 1. The one rule that makes the guarantees hold

The kernel's guarantees (deny-by-default, credential-blind, commit-before-effect, attester≠actor)
hold **only if you route every effect through the single governed edge** — `runGovernedToolCall`
(`src/orchestration/pipeline.ts`). The three surface factories below do this for you; if you build
your own surface, you MUST do the same and never call a substrate/connector directly.

`runGovernedToolCall` reads exactly **seven injected seams** plus an `AuthorizeDecision`. It never
references a specific tool family — that is what makes it extensible (exec / action / browser / your
own family all compose the same edge):

| Seam | What you inject | Production note |
|---|---|---|
| `screen` | credential screen over the call args | use the repo's `redactSecrets`-based detector |
| `authorize` | the PDP decision (allow/deny + `requiresApproval`/`external`/`projection`) | **sole deny authority** — see §4 |
| `approve` | the approver for `requiresApproval` allows | wire it, or destructive tools are `denied@approval` |
| `cost` | the `CostGate` (`reserve`/`commit`/`release`) | in-memory budget → SpendGuard for real spend |
| `estimateTokens` | per-call token estimate | your model's tokenizer |
| `appender` | the WORM **commit-before-effect** sink | the Go-kernel ingest appender — see §4 |
| `effect` | the actual tool execution (dispatch by family) | exec substrate / action connector / browser |

You almost never wire these seven directly — the **surface factories do it** and expose a small
human/agent-facing facade. Start there.

---

## 2. The three surfaces and their factories

| Surface | Factory | Facade you drive | Reference example |
|---|---|---|---|
| **Personal** | `createPersonalShell(opts)` | `receive → previewAndSubmit → approve → timeline` | [`examples/surfaces/run-personal-shell.ts`](../../examples/surfaces/run-personal-shell.ts) |
| **Developer** | `createDeveloperKit(opts)` | `authorTool → runTool → replayFold` | [`examples/surfaces/run-developer-kit.ts`](../../examples/surfaces/run-developer-kit.ts) |
| **Enterprise** | `createEnterpriseFleet(opts)` | `operatorAction (maker≠checker) → wormLogFor / console` | [`examples/surfaces/run-enterprise-fleet.ts`](../../examples/surfaces/run-enterprise-fleet.ts) |

Every factory **defaults to a fully in-memory composition** (in-memory WORM log with a generated
ed25519 key, `FakeSandboxAdapter`, `InMemoryCostGate`). That default lets you run a real governed
flow end-to-end with **zero external dependencies** — which is exactly what the reference examples do.
Production = swap the fakes for real adapters across the **same injected port shapes** (§3).

### Run the examples

```bash
pnpm install
pnpm run example:personal      # build + run the Personal composition root
pnpm run example:developer     # build + run the Developer composition root
pnpm run example:enterprise    # build + run the Enterprise composition root
```

Each prints a concise **governed-outcome** summary and exits 0. For example, Personal prints:

```json
{ "surface": "personal", "decision": "executed", "timelineEventCount": 1,
  "completed": true, "headline": "已完成：tool:invoke personal:backup", "usedInMemoryDefaults": true }
```

`decision: "executed"` means the intent was screened, policy-allowed, approved, **committed to the
WORM before the effect ran**, executed, and recorded on the timeline — the full seatbelt, in memory.

---

## 3. The minimal composition root, surface by surface

Copy the matching example, then replace the in-memory seams below with your real adapters. The port
**shapes do not change** — that is the deploy-gated boundary.

### Personal

```ts
import { createPersonalShell } from "agent-os/personal";

const shell = createPersonalShell({
  allowToolInvoke: true,        // ← or the PDP denies@policy (empty allow set)
  // PRODUCTION SEAMS (defaults are in-memory):
  // wormSink:   createIngestAppender(...).append,   // the Go-kernel WORM ingest (commit-before-effect)
  // readEntries: <ListEntries reader>,              // read-back for timeline()
  // costGate:   <your CostGate / SpendGuard adapter>,
  // sandbox:    <your real ExecutionSubstrate>,
  // secondaries:[<advisory adapters, e.g. AGT>],    // any-deny-wins, never relaxes a deny
});

const r = await shell.receive("backup my notes", ctx);
const submit = shell.previewAndSubmit(r.intent);
await shell.approve(submit.id);
console.log(await shell.timeline());
```

**Replace for production:** WORM sink (`wormSink`), WORM read-back (`readEntries`), `costGate`,
sandbox adapter, the policy allow-set (`allowToolInvoke` → real `AllowRule`s). Optional:
`toolRegistry`, `secondaries`.

### Developer

```ts
import { createDeveloperKit } from "agent-os/developer";

const kit = createDeveloperKit(/* rules?, toolRegistry?, costGate?, sandbox? */);
const reg  = kit.authorTool(myManifest);          // registry is deny-by-default
const run  = await kit.runTool(reg, { bundle });  // governed execution
const fold = kit.replayFold();                    // deterministic recompute (the recompute spine)
```

**Replace for production:** PDP allow `rules`, the shared `toolRegistry`, `costGate`, sandbox adapter.
For **real attestation**, run the released independent verifier via `verifyEvidenceChain(pubkeyPath,
env)` (`AGENTOS_VERIFIER_BIN` + your trust-root `publicKeyPem()`) — this is the attester≠actor moat;
the example uses `replayFold` to exercise the recompute spine without shipping a binary.

### Enterprise

```ts
import { createEnterpriseFleet } from "agent-os/enterprise";

const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });
const out = await fleet.operatorAction(ctx, { kind: "suspend-agent", resource: "agent:sbx-1" }, checkerCap);
console.log(fleet.console(ctx).fleet());
```

**Replace for production:** per-tenant WORM sink (`wormSinkFor`), per-tenant `costGateFor`, per-tenant
allow (`allowToolInvokePerTenant`), sandbox adapter, and **out-of-band checker-capability issuance**
(the example self-issues a capability only to drive the enforce side; in production the checker
capability is issued by a separate maker≠checker authority). Optional: platform `toolRegistry`,
`secondaries`.

---

## 4. Load-bearing adopter contracts (get these wrong and you reopen a hole)

These are the seams where an adopter can silently break a core guarantee. The kernel enforces its own
boundaries, but it cannot protect **your** adapters.

1. **The appender contract is the un-recorded-effect guard.** `commit-before-effect`
   (`src/commitgate/guard.ts`) `await`s `appender.append(event)` and runs the effect **only** on the
   next line. To signal a **failed** WORM append you MUST **reject** (or never resolve). **Never
   resolve a falsy receipt on a soft failure** — a resolved promise, even empty, lets the effect run.
   A custom appender against a real kernel must honor this or you reopen the "log it later" /
   un-recorded-effect hole.

2. **`AuthorizeDecision` is the sole deny authority.** Fold all secondary advisories into the
   authorize closure (`combineDecisions` is **any-deny-wins, PDP-sovereign**). `requiresApproval` and
   `external` are additive flags the authorize closure sets from the tool manifest
   (`sideEffect: "destructive"` ⇒ `requiresApproval`; `containment: network-egress/host-fs-write` ⇒
   `external`). A secondary can only **narrow**, never grant.

3. **Wire `approve`, or destructive tools are denied.** If a manifest sets `requiresApproval` and you
   did not inject an approver, the call is `denied@approval` (correct fail-closed default — but a
   wiring step you must not forget).

4. **The projection is opaque + pre-redacted; never route the raw projection to your own sinks.** The
   pipeline records only `boundarySummaryFromProjection`'s allow-list (networkHosts / writeTargets /
   operationClass / flags) — never `argvRedacted`/`argv0`. The raw `GovernanceProjection`'s
   `argvRedacted` is only **shape**-redacted; the kernel protects the boundary WORM, but not the
   other places **you** might log it.

5. **Thread timeouts from the composition root.** There is no default timeout on the append or the
   effect. For a real (network) WORM and real egress effects, wrap them with `withTimeout` so a
   stalled kernel/effect degrades to `denied@commit`/`release` instead of hanging the agent loop.

6. **Recovery is forward-only — there is no undo.** An executed external effect is irreversible;
   recovery is snapshot/restore/replay (`src/orchestration/`), not rollback. `settlement`/`boundary`
   failure markers are alert-and-re-drive signals, not transactional rollbacks. (See the recovery
   model docs.)

---

## 5. The honest deploy-gated boundary

The examples are **fakes that show the wiring**. To go to production you must stand up the real
adapters behind the same ports — and some of those are genuinely external infrastructure:

| Seam | In-memory (example) | Production (you provide) |
|---|---|---|
| WORM sink + read-back | `InMemoryAppendOnlyLog` + generated ed25519 | the Go kernel ingest + a **real KMS/HSM trust-root** (TR2) |
| Sandbox / substrate | `FakeSandboxAdapter` | a real zero-cred / egress-controlled sandbox (exec + browser) |
| CostGate | `InMemoryCostGate` | the SpendGuard ledger adapter (with `release()` — deploy-gated) |
| Tenancy | single process | per-tenant gateways/stores + PDP-scoped sessions |
| Attestation verifier | `replayFold` recompute | the released independent verifier binary (attester≠actor) |

None of this changes your composition-root code shape — you inject a different adapter behind the same
port. That is the point of the seam design: **the governance is in the spine, not the adapter.**

---

## 6. Where to go next

- **Tool authors:** [`tool-manifest-authoring.md`](./tool-manifest-authoring.md) — author a `ToolManifest` (the `sideEffect`/`containment` fields drive the gates above).
- **Auditors:** [`verifier-release.md`](./verifier-release.md) — independently verify the evidence chain (the attester≠actor moat).
- **Enterprise security review:** the SEATBELT trust story + the deploy-gated checklist (Security/Trust whitepaper).
