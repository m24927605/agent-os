# Enterprise Operator Runbook: Console, Maker-Checker, Tenant Lifecycle & Recovery

> **Audience.** The person *running* an Agent OS Enterprise fleet — the operator on call for Day-2
> operations: reading the governance console, suspending a misbehaving agent, onboarding and
> offboarding tenants, and driving recovery after an incident.
>
> **What this is not.** This is not the provisioning checklist (see
> [`enterprise-deployment.md`](./enterprise-deployment.md)), not the security whitepaper (see
> [`security-model.md`](./security-model.md)), and not the wiring guide (see
> [`sdk/composition-root-guide.md`](./sdk/composition-root-guide.md)). It is the operator's *playbook*
> for the fleet those documents stand up.

Everything below is grounded in code you can read and run today:

- `src/enterprise/bootstrap.ts` — `createEnterpriseFleet`, the Enterprise composition root.
- `examples/surfaces/run-enterprise-fleet.ts` — the runnable reference fleet (`pnpm run example:enterprise`).
- `src/tenant/` — the router, per-tenant store, console projection, and maker-checker primitive.
- `src/orchestration/{snapshot,restore,replay}.ts` — the recovery model.

When a procedure depends on infrastructure that is **not yet wired in-tree**, this runbook says so
explicitly under [Section 5: What is deploy-gated](#5-what-is-deploy-gated-for-real-operations). Do not
assume a capability is live because it is described — confirm it is wired in your composition root.

> **Runnable vs deploy-gated.** Out of the box the reference fleet runs on a **purely in-memory
> backbone** — no kernel process, no Docker, no network, no vendor (`run-enterprise-fleet.ts:7-9`).
> That makes every procedure below *demonstrable* in-repo, but the in-memory seams (WORM log, cost
> gate, signing keys, checker-capability issuance) are **fakes** you replace for production. The
> package is private and in-repo: `npm install agent-os` does **not** resolve. Run from a clone.

---

## 0. Orientation: the governed spine an operator drives

The Enterprise surface is one façade, `EnterpriseFleet`, returned by `createEnterpriseFleet(opts)`
(`src/enterprise/bootstrap.ts:260`). Everything an operator does flows through it, and **every entry
routes first** — an untrusted `ctx` is resolved to *its own* tenant's binding before anything else
happens, and an unrouted/unknown tenant fails closed (`bootstrap.ts:580-616`).

The façade methods, grouped by what an operator uses them for:

| Operator task | Method | Routes first? | Mutates? |
|---|---|---|---|
| Read the fleet / timeline | `console(ctx)` → `fleet()` / `timeline()` | yes | no |
| Inspect a tenant's WORM | `wormLogFor(ctx)` | yes | no |
| Queue an agent action for approval | `submitForApproval(ctx, call)` | yes | no (queues) |
| Approve a queued action (sole pipeline entry) | `approve(ctx, id)` | yes | yes (governed effect) |
| Privileged operator action (e.g. suspend-agent) | `operatorAction(ctx, action, cap)` | yes | yes (maker≠checker) |
| Onboard a tenant | `registerTenant(tenantId)` | n/a (fleet-admin) | yes |
| Offboard a tenant | `deprovisionTenant(tenantId)` | n/a (fleet-admin) | yes |

The governed path for a privileged action is, end to end
(`run-enterprise-fleet.ts:12-16`, `bootstrap.ts:618-670`):

```
route(ctx)                          gateway, fail-closed
  → enforceMakerChecker(ctx, action, cap)   maker≠checker capability gate, deny short-circuits
    → commitBeforeEffect(                    append operator AuditEvent → THAT tenant's WORM
        append → await receipt → effect)     → AWAIT the durable receipt → THEN run the effect
      → tenant-scoped effect                 e.g. suspend-agent
        → console(ctx).fleet()               reflects phase="suspended"
```

The two invariants to keep in your head while operating:

- **Tenant-sealed.** Per-tenant state is *independent, closure-bound instances* — a separate WORM
  log, cost gate, and approval inbox per tenant, never "one shared instance + a `tenantId`
  parameter" (`bootstrap.ts:12-21`, `285-300`). A holder of tenant-A's console/binding has **no
  argument** by which to name tenant-B. Cross-tenant read/write/approve is structurally impossible,
  not merely policy-enforced.
- **Commit-before-effect.** No external effect runs until its AuditEvent has a *durable WORM
  receipt*. If the WORM append fails, the effect is refused (`bootstrap.ts:650-668`).

---

## 1. Reading the governance console / fleet projection

The console is **read-only and single-tenant by construction**. `console(ctx)` routes `ctx`, then
returns a `TenantConsole` *closure-bound* to exactly that tenant's repo
(`src/tenant/console/projection.ts:1-46`, `85-114`). It exposes **only** `fleet()` and `timeline()` —
no mutate method, and neither takes a `tenantId` argument, so seeing another tenant's fleet is
impossible by construction (`projection.ts:9-14`).

### Procedure: open a tenant's console

```ts
import { createEnterpriseFleet } from "./dist/enterprise/index.js";

const fleet = createEnterpriseFleet({ tenants: ["tenant-a", "tenant-b"] });

// A well-formed AgentContext routes to its own tenant; a missing/blank tenantId fails closed.
const ctx = { actorId: "agent:operator", tenantId: "tenant-a", projectId: "p", taskId: "t", requestId: "r" };

const view = fleet.console(ctx);
if (!view.ok) {
  // Fail-closed: unrouted / unknown tenant. `view.reason` is a STATIC code, never an echoed ctx value.
  console.error("console denied:", view.reason);
} else {
  const roster   = await view.console.fleet();    // { tenantId, agents: [{ sandboxId, agentName, phase }] }
  const timeline = await view.console.timeline();  // { tenantId, events: [{ seq, summary }] } ordered by seq
}
```

What you get back (the *minimal data contract*, not UI pixels —
`projection.ts:30-40`):

- **`fleet()`** → the tenant's agent roster: `{ sandboxId, agentName, phase }` per agent, sorted by
  `sandboxId`. The projection lifts **only** these allow-listed fields off each repo entry, so a
  secret-looking value stored alongside an agent never surfaces in a view (`projection.ts:52-62`).
  A non-conforming entry is silently dropped (fail-closed), never half-rendered.
- **`timeline()`** → the tenant's governed events: `{ seq, summary }`, ordered by `seq` ascending.
  Each governed action the pipeline commits writes one `event:<seq>` entry whose summary is
  redacted on the way out (`bootstrap.ts:336-345`).

### What the console does *not* do

- It **does not filter** by tenant — it only ever touches the single repo from
  `store.forTenant(binding)`. Isolation is the binding, not a `WHERE tenant_id = …` clause
  (`projection.ts:16-19`).
- It **does not mutate**. Privileged changes go through `operatorAction` / `approve` (PDP +
  commit-before-effect), never the console (`projection.ts:9-11`).
- An **unregistered binding fails closed** — the underlying store throws rather than returning an
  empty or another tenant's view (`src/tenant/persistence/in-memory.ts:56-61`).

> **Run it.** `pnpm run example:enterprise` builds, then drives `operatorAction` and reads the
> console back: it asserts `fleet()` shows the target agent `phase="suspended"`
> (`run-enterprise-fleet.ts:92-100`).

---

## 2. The maker≠checker operator-action workflow

A privileged action (suspend an agent, and — by the same path — future destructive operations) is
**not** something the operator can do alone. It requires a **checker who possesses a
`CheckerCapability`** bound to `(tenantId, actionIdentity, makerActorId)`, and that capability **cannot
be self-issued by the maker** (`src/tenant/maker-checker.ts:1-32`).

### How separation of duties is enforced (capability *possession*, not a string compare)

`enforceMakerChecker(ctx, action, cap)` is a **deny-by-default pure function**. Every one of five
checks must pass or it denies (`maker-checker.ts:77-119`):

1. `parseAgentContext(ctx)` — malformed/empty ids ⇒ deny `invalid_agent_context`.
2. `cap` is a well-formed `CheckerCapability` (possession; malformed ⇒ deny `invalid_capability`).
3. `cap.tenantId === ctx.tenantId` — a cross-tenant capability does not apply ⇒ deny
   `cross_tenant_capability`.
4. `cap.makerActorId !== ctx.actorId` — the same identity cannot be both maker and checker ⇒ deny
   `maker_is_checker`.
5. `deriveActionIdentity(action) === cap.actionIdentity` — the identity of the action *about to run*
   is **re-derived** and matched; a mismatch ⇒ deny `action_identity_mismatch` (a TOCTOU defence —
   the approval is bound to the enforced identity, `maker-checker.ts:5-17`, `113-116`).

All deny reasons are **static error codes** — never an interpolated `ctx`/`cap` value
(credential-blind, `maker-checker.ts:52-58`).

### Who issues the checker capability — and the honest boundary

**Capability *issuance* is out-of-band.** This module enforces *possession* ("passed in == possessed",
`maker-checker.ts:5-8`); it does **not** ship an issuer. The reference example self-constructs a valid
capability purely to drive the *enforce* side, and is explicit that it builds no issuer
(`run-enterprise-fleet.ts:27-30`, `79-86`):

```ts
import { deriveActionIdentity } from "./dist/tenant/index.js";

const action = { kind: "suspend-agent", resource: "agent:sbx-1" };
const cap = {
  tenantId: ctx.tenantId,                       // must equal the checker's tenant
  actionIdentity: deriveActionIdentity(action), // re-derived & matched at enforce time
  makerActorId: "agent:maker",                  // MUST differ from ctx.actorId (the checker)
  capabilityRef: "cap-ref-opaque",              // OPAQUE reference — never a secret/credential
};
```

> **Operational requirement.** In production, the capability must be **independently issued** by a
> path the checker does not control, delivered to the checker out-of-band, and the `capabilityRef`
> must remain an opaque reference (no secret material). The "who signs / where stored / how
> delivered" issuance path is a deploy-time decision the SDK leaves to you
> (`run-enterprise-fleet.ts:27-31`); `createMakerCheckerApprover` (`src/enterprise/maker-checker-approver.ts`)
> wraps the enforce side into the approve seam and is provided **ready to wire**, but the issuer is yours.

### Procedure: enforce an operator action (e.g. suspend an agent)

```ts
const result = await fleet.operatorAction(ctx, action, cap);
// result.status === "ok"     → AuditEvent committed to THIS tenant's WORM, then the effect ran
// result.status === "denied" → route/maker-checker/commit failure; the effect did NOT run
```

What `operatorAction` does, in order (`bootstrap.ts:618-670`):

1. **Route first** (fail-closed). Unrouted/unknown tenant ⇒ `denied`, with the router's static reason;
   the WORM is never touched.
2. **Maker-checker gate.** `enforceMakerChecker(ctx, action, cap)`; a deny short-circuits **before any
   audit or effect**, returning the primitive's static reason.
3. **Commit-before-effect.** Append the operator AuditEvent to *this tenant's* WORM, **await the
   receipt**, then run the tenant-scoped effect. An append failure ⇒ the effect is **refused** and the
   result is `denied` with reason `commit_before_effect_aborted` (`bootstrap.ts:665-668`).
4. **Effect.** For `suspend-agent` (resource `agent:<sandboxId>`), it writes that tenant's repo entry
   in the exact shape the console projects, so `console(ctx).fleet()` then shows `phase="suspended"`
   (`bootstrap.ts:398-414`).

> An **unknown action kind** fails closed — there is no silent effect; only `suspend-agent` is
> delivered today, and other privileged actions land later behind the **same** route → maker-checker →
> commit-before-effect path (`bootstrap.ts:415-417`).

### Verifying the action was audited

The operator AuditEvent is committed **before** the effect, so the WORM is your proof:

```ts
const count = fleet.wormLogFor(ctx)?.entries().length ?? 0; // ≥ 1 after a committed operator action
```

`wormLogFor(ctx)` routes and returns *that tenant's* append-only log instance (or `undefined` if
unrouted) — exposing the per-tenant independence: tenant-A's log is a different instance from
tenant-B's (`bootstrap.ts:218-222`, `672-678`). The example reads exactly this back
(`run-enterprise-fleet.ts:92`).

### The agent-action approval path (`submitForApproval` → `approve`)

For an *agent's* governed tool call (as opposed to a privileged operator action), the path is
queue-then-approve, and **`approve` is the sole governed-pipeline entry** (`bootstrap.ts:582-608`):

- `submitForApproval(ctx, call)` routes, then queues the call in **that tenant's** inbox.
- `approve(ctx, id)` routes, then approves in **that tenant's** inbox, running the governed pipeline
  (screen → PDP → cost → commit-before-effect → effect → per-tenant WORM).
- A tenant-B `ctx` approving a tenant-A id resolves *B's* inbox, which has **no record** of an
  A-issued id ⇒ deny-by-default. This is a structural miss, not a permission check that could be
  mis-scoped (`bootstrap.ts:295-298`, `606`).

---

## 3. Tenant lifecycle: isolation, onboarding, and the per-tenant seams

### Per-tenant isolation (the load-bearing invariant)

Per registered tenant the fleet builds **independent, closure-bound instances**
(`bootstrap.ts:285-300`, `517-568`):

- a separate `InMemoryAppendOnlyLog` (one per `partitionId`) — the per-tenant **WORM**;
- a separate `CostGate` (one per `tenantId`) — the per-tenant **cost** seam;
- a separate `ApprovalInbox` — the per-tenant approval queue;
- a separate Ed25519 keypair per partition — per-tenant signing material;
- a PDP allow rule whose `tenantId` equals the tenant's id, so even a mis-routed request to a foreign
  rule fails closed (`bootstrap.ts:436-448`).

Collapsing any of these to a single shared instance (e.g. one shared log) would leak tenant-A's
approve→WORM→timeline into tenant-B — exactly what the cross-tenant e2e flips RED
(`bootstrap.ts:18-21`). This is checked in CI by `pnpm run verify:cross-tenant`.

The per-tenant seams an operator (or the composition root) controls, all on
`EnterpriseFleetOpts` (`bootstrap.ts:84-157`):

| Seam | Option | Default (in-memory) | Production injection |
|---|---|---|---|
| WORM sink | `wormSinkFor(binding)` | per-tenant `InMemoryAppendOnlyLog.append` | `createPartitionedIngestSink(transport, binding)` → kernel's per-tenant WORM partition |
| Cost gate | `costGateFor(tenantId)` | per-tenant `new InMemoryCostGate(budget)` | a per-tenant real spend gate (an **independent** gate per tenant) |
| PDP allow | `allowToolInvokePerTenant(tenantId)` | allow-all-tenants | your per-tenant policy |
| Platform admission | `toolRegistry` | none | a platform-wide **deny-only** tool catalog (can only narrow) |
| Advisory secondaries | `secondaries` | `[]` | deny-only advisory adapters (e.g. AGT); fold via any-deny-wins |

Critical property of all these seams: **they can only narrow, never grant**. The per-tenant PDP is the
sole deny authority; a registry, a secondary, or an external cost gate can only *add* a deny
(`bootstrap.ts:123-156`, `484-494`). A foreign or mis-wired rule cannot grant another tenant
(`bootstrap.ts:97`, `436-438`).

> The default WORM sink wraps the synchronous in-memory append: `log.append` returns an
> `AppendReceipt` and the sink resolves it (`bootstrap.ts:540`, `src/audit/kernel/log.ts:110-116`).
> When you inject `wormSinkFor`, the receipt comes from the real kernel partition instead.

### Procedure: onboard a tenant at runtime

`registerTenant(tenantId)` is a **fleet-admin** op (no `ctx`; operator authorization for it is
deferred — see §5). It is **fail-closed validate first, mutate second** (`bootstrap.ts:680-709`):

```ts
const r = fleet.registerTenant("tenant-c");
// r.status === "ok"      → tenant onboarded with its OWN independent WORM/cost/inbox; router rebuilt
// r.status === "denied"  → r.reason is a static code (see below); NO mutation happened
```

Deny conditions (no mutation occurs on any of them):

- empty/whitespace `tenantId` ⇒ `invalid tenant id (deny-by-default)`;
- already registered ⇒ `tenant already registered (deny-by-default)` — the existing tenant's
  binding/log/inbox are untouched;
- a **retired** (previously deprovisioned) id ⇒ `tenant id retired (deny-by-default)`. This is the
  important one: deprovision revokes routing but, by the append-only WORM invariant, **never erases**
  the partition, so re-registering the same id is refused rather than risk silently reusing the old
  tenant's WORM/inbox state (`bootstrap.ts:696-706`).

On success, provisioning builds the tenant's independent deps, **additively** registers its partition
in the shared store (so the console sees it immediately), and **immutably rebuilds** the
`TenantRouter` from the now-larger binding set — preserving the router's no-mutation-API structural
isolation (`TenantRouter` defensively copies; there is no add-binding API to abuse,
`bootstrap.ts:692-708`, `src/tenant/router.ts:31-40`).

> **Static vs dynamic onboarding share one code path.** Tenants passed in `opts.tenants` and tenants
> added via `registerTenant` both run the *same* `provisionTenant` step — provisioning is
> byte-identical (`bootstrap.ts:88-91`, `507-516`).

### Procedure: offboard a tenant

`deprovisionTenant(tenantId)` (`bootstrap.ts:711-724`):

```ts
const r = fleet.deprovisionTenant("tenant-c");
// not registered ⇒ denied "unknown tenant (deny-by-default)"
// otherwise      ⇒ ok: binding removed, router rebuilt WITHOUT it
```

After deprovision, `route(ctx)` for that tenant fails closed — and with it
`submit`/`approve`/`operatorAction`/`console`, all route-first. **The tenant's append-only WORM log is
intentionally NOT erased**: deprovision revokes *routing/action capability*, it does not delete
history (append-only, by design, `bootstrap.ts:719-723`). The log simply becomes unreachable via
`route`. This is also why a deprovisioned id cannot be re-onboarded in-process (see above).

---

## 4. Recovery operations: forward-only restore, no undo

Agent OS recovery is **forward-only by design — there is no undo.** An external effect that has left
the system cannot be unwound; recovery is *restore to a consistent snapshot*, which **appends new
events** rather than rewriting history. The operator's job is to read the divergence, confirm with
full knowledge of what cannot be undone, and authorize a signed restore.

### Why there is no undo, and why the brain cannot self-restore

- **Forward-only.** `restore-to-S` is **not** a log truncation. It is an ordered, fail-closed
  orchestration that emits **two new forward events** — `RestoreInitiated`, then `RestoreCompleted` —
  into the append-only WORM hash-chain and rebuilds the state-layer projection in between. The
  original events stay on the chain; forward continues from the head. There is **no truncate/rewrite
  surface** — the only emit seam is a `RestoreAppender` whose sole capability is `append`
  (`src/orchestration/restore.ts:1-31`, `73-80`).
- **attester ≠ actor — the brain can never self-restore.** A restore whose `sourceId` is a brain
  source (`brain`, `hermes`) is **denied by default at the `validating` phase**, before any append
  (`restore.ts:131-163`). Restore is **admin/approver-signed**: the `RestoreEvent` records the
  admin/approver `actor` that signed it and the non-brain `sourceId` that initiated it
  (`restore.ts:48-65`). This is the moat: the component that *attests* (the WORM/restore authority) is
  not the component that *acts* (the agent brain).

### The restore FSM, phase by phase

`runRestore(deps, snapshot, actor, sourceId)` returns a terminal `RestoreOutcome`; it **never throws
and never partially applies** — every phase is fail-closed (`restore.ts:146-244`). Phases:

```
idle → validating → locked → verifying-anchor → initiated → rebuilding → completed | aborted
```

1. **validating** — attester≠actor deny (brain source ⇒ abort), then `authorize(actor, snapshot)`
   (the PDP seam). A deny, or an authorize hook that *throws*, aborts here. **No append yet.**
2. **locked** — acquire the global cross-ingest checkpoint/lock. A reject aborts here, still pre-append.
3. **verifying-anchor** — the **anchor cross-validation** (below). A mismatch aborts here, still
   pre-`initiated`, so a bad anchor records **no** forward event.
4. **initiated** — emit `RestoreInitiated`, carrying the `DivergenceReport` verbatim.
5. **rebuilding** — rebuild the state-layer projection (DB txn / PITR / brain import / sandbox
   reprovision — all injected). A failure here aborts **without** emitting `RestoreCompleted`, so **no
   half-completed illusion** is ever left on the chain (`restore.ts:220-226`).
6. **completed** — emit `RestoreCompleted`.

### The anchor cross-validation (refuse to restore to a stale/forged snapshot)

A `SnapshotRecord` records, at its WORM `sequence`, the WORM head content address (`wormHeadHash`) and
the brain `memoryVersion` — *specifically* so a restore can **prove** the snapshot is consistent with
the live chain before rebuilding to it (`src/orchestration/snapshot.ts:1-25`, `54-78`). At
`verifying-anchor`, the FSM reads the **live** chain's anchor *at that sequence* (under the global
lock, so it is a consistent read) and **refuses, fail-closed, with no append**, if either the head
hash or the memory version no longer matches — a stale or forged anchor (`restore.ts:182-203`). The
comparison and the fail-closed decision live **in the reviewed FSM**, never delegated.

### The DivergenceReport — read it BEFORE confirming

A snapshot carries `externalEffectsSinceBaseline` — the **DivergenceReport seed**: the external effects
observed since the snapshot baseline, each `{ tool, sideEffect, idempotent }`
(`snapshot.ts:36-47`, `72-73`). The `sideEffect` taxonomy is the crux of the no-undo model
(`snapshot.ts:28-34`):

| `sideEffect` | Meaning for recovery |
|---|---|
| `none` / `read` | reversible by construction |
| `write` | may have a `compensate()` |
| `external` | has **left the system** |
| `irreversible` | can **never** be unwound — accept-and-record |

This report is carried **verbatim** into `RestoreInitiated` and is **never swallowed**
(`restore.ts:60-65`, `205-218`). **The operator must read it before confirming a restore**: restoring
the *state projection* to snapshot S does **not** reach out and undo an `external`/`irreversible`
effect that already happened. Those effects are facts on the ground; the restore re-establishes
internal state around them. Confirm only with full knowledge of what the report says cannot be undone.

### Forensic replay (read-only truth reconstruction)

Before *or* independent of a restore, you can rebuild the truth read-only:
`replayTimeline(events, uptoSequence?)` folds an ordered WORM-derived event projection into a
deterministic `TaskTimeline` with a content-addressed `timelineHash` an independent verifier can
recompute (`src/orchestration/replay.ts:1-38`, `114-184`). It is **pure / read-only** — never re-runs
a tool, never touches the network, never reads a credential — and **fail-closed**: a sequence gap, a
duplicate/non-monotonic sequence, or an out-of-range cut-point throws a typed `ReplayError` rather than
return a "looks complete" shorter timeline (`replay.ts:13-25`, `118-159`). Use it to answer "what was
the state at sequence N?" and to prove the chain to a verifier without mutating anything.

---

## 5. What is deploy-gated for real operations

Be honest about what runs in-repo today versus what your deployment must wire. The reference fleet and
the recovery primitives are real and tested, but the following are **not yet wired in-tree** and are
required before the corresponding Day-2 procedure is live in production:

- **Restore composition-root wiring is not in-tree.** `runRestore` is fully implemented and tested,
  but it is **not** wired into any in-tree composition root — the only non-test caller is its own
  definition (`src/orchestration/restore.ts:151`). All of its `RestoreDeps` are injected interfaces:
  `acquireCheckpoint` (the real global cross-ingest lock), `authorize` (the PDP decision),
  `readLiveChainAnchor` (the R2 read-transport / kernel `ListEntries` + memory-version lookup), the
  `appender` (the R2 ingest client), and `rebuildProjection` (the real DB txn / PITR / brain import /
  sandbox reprovision) (`restore.ts:94-110`). **Before restore is operable, your composition root must
  supply real concretes for every one of these.** The reference Enterprise fleet does not yet expose a
  restore entry point.

- **The capture phase is not in-tree.** `runRestore` consumes a `SnapshotRecord`, but **nothing in the
  non-test tree produces one.** `snapshot.ts` defines the strict `SnapshotRecord` schema and the pure
  `toSnapshotAuditEvent` credential-blind gate, and is explicit that it **never captures constituent
  state** (that is the capture phase) and **never appends to WORM** (that is the R2 ingest client)
  (`snapshot.ts:20-25`). You must build the capture phase that snapshots the unified anchor and emits
  the `SnapshotRecord`s a restore later targets.

- **The live WORM partition sink is a deploy-time injection.** By default each tenant's WORM is the
  in-memory `InMemoryAppendOnlyLog`. Real per-tenant durable WORM requires injecting
  `wormSinkFor = (binding) => createPartitionedIngestSink(transport, binding)` so each tenant's events
  land in the kernel's independent per-tenant partition (its own chain head + Ed25519 key); absent it,
  the fleet is byte-identical to the in-memory default (`bootstrap.ts:109-121`).

- **Checker-capability issuance is out-of-band.** As detailed in §2, the SDK enforces *possession*; it
  ships **no issuer**. The independently-issued capability, its signing/storage/delivery, must be
  provided by your deployment (`run-enterprise-fleet.ts:27-31`).

- **Per-tenant trust-root / signing keys.** The in-memory path generates an Ed25519 keypair *in
  process* per partition (an honest fake). When the live partitioned sink is injected, the **kernel**
  holds the real signing key per partition; a real per-tenant trust-root (KMS/HSM) is a deployment
  concern, not in-tree (`bootstrap.ts:526-531`).

- **Operator authorization for tenant lifecycle is deferred.** `registerTenant` / `deprovisionTenant`
  take no `ctx` today — they are fleet-admin ops whose operator-action authorization is explicitly
  deferred (`bootstrap.ts:227-231`). Gate these behind your own admin authorization until that lands.

In short: **the wiring (route → maker-checker → commit-before-effect → effect; the restore FSM; the
console projection) is real and runnable on in-memory seams. The real adapters — durable WORM
partitions, the restore composition root, the snapshot capture phase, capability issuance, and a real
trust-root — are what you wire across the deploy-gated boundary** described in
[`sdk/composition-root-guide.md`](./sdk/composition-root-guide.md) and provisioned per
[`enterprise-deployment.md`](./enterprise-deployment.md).

---

## See also

- [`security-model.md`](./security-model.md) — the SEATBELT whitepaper: deny-by-default,
  credential-blind, commit-before-effect, attester≠actor WORM. The invariants this runbook operates.
- [`enterprise-deployment.md`](./enterprise-deployment.md) — the provisioning checklist that stands up
  the fleet you operate here.
- [`sdk/composition-root-guide.md`](./sdk/composition-root-guide.md) — how to wire the real adapters
  across the deploy-gated boundary called out in §5.
- [`concepts.md`](./concepts.md) — Agent OS in 5 minutes, for the mental model behind the spine.
