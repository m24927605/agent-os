# Personal Quickstart: Run the Self-Operating Computer

> Go from a fresh clone to a real, governed agent outcome in one command. You type an intent, see
> a plain-language plan, approve it, and watch the effect land on a tamper-evident timeline — the
> full Agent OS "seatbelt" running locally, with no secrets and no external services.

**After this guide you will have:** run the Personal surface end-to-end and seen a governed outcome
print `decision: "executed"` with a WORM-backed `已完成` (completed) timeline event — proof the intent
was screened, policy-allowed, approved, committed to the audit log *before* the effect ran, executed,
and recorded.

**Time to first value:** about 2–3 minutes (most of it is the one-time `pnpm install`).

---

## What "Personal surface" means

Agent OS is a **governed** computer that operates itself by intent. The Personal surface is the
individual-facing path through that governance core. You drive a small facade:

```
文字 (receive)  →  白話計畫 (preview)  →  核可佇列 (previewAndSubmit)  →  核可 (approve)
   → 治理管線 (screen → policy → cost → commit-before-effect → effect) → 時間軸 (timeline 已完成)
```

Every effect goes through **one** governed edge. Nothing runs until it has been screened for
credentials, allowed by policy, budgeted, and **written to the audit log first**. That ordering — the
commit happening *before* the effect — is what makes the timeline a trustworthy record rather than an
after-the-fact note.

---

## Prerequisites

- [ ] **Node.js 22 or newer** — the repo's `engines` field requires `node >=22`.
- [ ] **pnpm** — the repo pins `pnpm@9.15.4` via `packageManager`. Install with `corepack enable`
      if you don't have it.
- [ ] **Git** — to clone the repo.

There is **nothing else to install or configure**. The Personal example composes a purely in-memory
backbone: no kernel process, no Docker, no vendor, no network, no filesystem, no API keys. Because it
is credential-blind by construction, you will never be asked for a secret.

> **Heads-up — this is an in-repo package.** Agent OS is currently a private, in-repo package
> (`"name": "agent-os"`, `"private": true`, `"version": "0.0.0"`). `npm install agent-os` does **not**
> resolve from a public registry yet. This quickstart uses the in-repo path: clone, install, run the
> repo's own script. The `import { createPersonalShell } from "agent-os/personal"` form you'll see in
> the composition-root guide is the *intended* public shape; today it resolves only inside this repo.

---

## Step 1: Clone and install

Clone the repository and install dependencies. The install is the only slow step; everything after it
is fast.

```bash
git clone <your-repo-url> agent-os
cd agent-os
pnpm install
```

> **If you see `Unsupported engine` or a Node version error:** you are on Node < 22. Switch with
> `nvm use 22` (or your version manager of choice) and re-run `pnpm install`.

---

## Step 2: Run the Personal surface

One command. It builds the TypeScript, then runs the reference composition root.

```bash
pnpm run example:personal
```

Under the hood this is `pnpm run build && node examples/surfaces/run-personal-shell.ts` (from the
repo's `package.json` scripts) — `build` compiles to `dist/`, and the example runs the compiled output.

You should see a governed-outcome summary like this, followed by an `OK` line:

```json
[personal] governed outcome: {
  "surface": "personal",
  "decision": "executed",
  "timelineEventCount": 1,
  "completed": true,
  "headline": "已完成：tool:invoke personal:backup",
  "usedInMemoryDefaults": true
}
[personal] OK — executed governed outcome with a WORM-backed 已完成 timeline event.
```

The process exits `0`. That `decision: "executed"` plus `completed: true` is your first governed
outcome. The next section explains what each field means and what just happened.

> **If `decision` is `"denied"` instead of `"executed"`:** the example seam that injects the policy
> allow rule was turned off (`allowToolInvoke: false`). With an empty allow set the policy engine
> **denies by default** — which is the system working correctly, not a bug. The shipped example sets
> `allowToolInvoke: true`, so a clean run executes. See [Why it can deny](#why-it-can-deny-the-default-is-no).

---

## Step 3: Read the governed flow you just ran

The example in [`examples/surfaces/run-personal-shell.ts`](../examples/surfaces/run-personal-shell.ts)
drives the `PersonalShell` facade (built by `createPersonalShell` in
[`src/personal/bootstrap.ts`](../src/personal/bootstrap.ts)) through five steps. Here is each step,
what it does, and why it matters.

### 1. `receive(text, ctx)` — intent, not a command

```ts
const received = shell.receive("backup notes archive", ctx);
// received.status === "intent"
```

Your free text is screened for credentials **first** (so a secret never reaches the parsed intent),
then a deterministic gateway turns it into a validated `StructuredIntent`. The outcome status is one
of `intent`, `needs-clarification`, or `denied` — the system tells you up front whether it understood
you, needs more detail, or refused. Nothing has *happened* yet; this is only understanding.

### 2. `preview(intent)` — the plain-language plan (白話計畫)

```ts
shell.preview(received.intent);
```

Before any commitment, the surface renders a human-readable plan: a title, an ordered list of steps
(one per target), and a coarse scope summary. This is the "here's what I'm *about to* do, in plain
words" moment — your chance to read the plan before you authorize it. (It is informational; the next
step re-renders the same plan as it queues the call.)

### 3. `previewAndSubmit(intent)` — the approval queue (核可佇列)

```ts
const submitted = shell.previewAndSubmit(received.intent);
// submitted.status === "pending"; submitted.id is the queued call's id
```

The intent becomes a concrete governed call and is **queued, pending your approval**. It returns a
pending id. **Still nothing has executed.** This is the approval gate: the system parks the work and
waits for an explicit human yes.

### 4. `approve(id)` — the single governed entry (核可 → 治理管線 → effect)

```ts
const decided = await shell.approve(submitted.id);
const decision = decided.status; // "executed" on the happy path; "denied" if a gate refused
```

Approval is the **sole** path to the effect. It drives the one governed pipeline, in order:

1. **screen** — credential screen over the call (credential-blind: a secret anywhere is caught).
2. **policy** — the policy decision (the **sole deny authority**; deny-by-default).
3. **cost** — reserve against the budget (an over-budget call is denied here).
4. **commit-before-effect** — the audit event is `await`ed into the WORM log **first**.
5. **effect** — only *after* the commit succeeds does the actual effect run.

If any gate refuses, the pipeline short-circuits to `denied` and **the effect never runs**. The
commit-before-effect ordering is the load-bearing invariant: there is no "do it, then log it" window
in which an unrecorded effect could slip out.

### 5. `timeline(taskId)` — the tamper-evident record (時間軸)

```ts
const events = await shell.timeline(ctx.taskId);
const completed = events.some((e) => e.headline.startsWith("已完成"));
```

The timeline reads back the **same** append-only WORM log the pipeline committed into and folds it
into plain-language events. A completed governed effect renders with a `已完成：…` headline; a refused
one renders `被拒絕：…`; an error renders `發生錯誤：…`. Because the record is written *before* the
effect and the chain sequence is **never renumbered or invented**, the timeline is a tamper-evident
account of what the computer actually did on your behalf — not a log it could have rewritten afterward.

---

## Why it can deny (the default is "no")

The Personal example flips one seam on for you: `createPersonalShell({ allowToolInvoke: true })`
injects a `personal:*` allow rule so the happy path executes. Turn it off and the allow set is empty —
and the policy engine **denies by default**. That is the whole posture of the system: unknown,
malformed, or unauthorized intents are refused, and a refusal is still a first-class, recorded outcome
(`decision: "denied"`, with a `被拒絕` timeline event). Seeing a deny is not a failure of the demo; it
is the seatbelt holding.

---

## What's in-memory here (and what production swaps in)

This example is an honest **fake that shows the wiring**. Every external dependency is replaced by an
in-memory default so you can run a real governed flow with zero setup:

| Seam | In this example | Production (you provide) |
|---|---|---|
| WORM sink + read-back | in-memory append-only log with a generated ed25519 key | the kernel's WORM ingest + a real KMS/HSM trust-root |
| Sandbox / substrate | `FakeSandboxAdapter` | a real zero-credential, egress-controlled sandbox |
| Cost gate | `InMemoryCostGate` (default budget) | your real spend gate |
| Policy allow-set | `allowToolInvoke: true` injects one `personal:*` rule | your real policy `AllowRule`s |

The shape of each injected port **does not change** between this example and production — you swap the
adapter, not the composition-root code. `usedInMemoryDefaults: true` in the output is the example
telling you, honestly, that it ran entirely on those fakes.

---

## A note on the "one Docker command" experience

A packaged, single-command Personal app (e.g. "run one Docker container and you have a governed
personal assistant") is **part of the adoption vision, not something that exists today.** There is no
such container or installer in this repo yet. The real, supported path right now is the
`pnpm run example:personal` flow above. Treat any "just run the container" phrasing elsewhere as
**future / deploy-gated**, not a current capability.

---

## Next steps

- **Wire real adapters:** [`docs/sdk/composition-root-guide.md`](./sdk/composition-root-guide.md) —
  how to replace each in-memory seam (WORM sink, read-back, cost gate, sandbox, policy allow-set) with
  your real adapters across the same injected ports. Start there to take Personal beyond the demo.
- **Author a tool:** [`docs/sdk/tool-manifest-authoring.md`](./sdk/tool-manifest-authoring.md) — the
  `sideEffect` / `containment` fields that drive the approval and policy gates.
- **Verify the evidence chain:** [`docs/sdk/verifier-release.md`](./sdk/verifier-release.md) — the
  independent verifier (the attester ≠ actor moat) that lets an auditor recompute the WORM record
  without trusting the actor that produced it.
