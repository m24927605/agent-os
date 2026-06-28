# Build a Tool Family / ActionBinding End-to-End

> **Audience:** third-party tool authors using the Agent OS Developer SDK.
> **Goal:** take a capability from *a manifest* all the way to *a governed, credential-blind tool* the
> kernel can run — without ever holding a secret, without ever building a retargetable command, and
> with a WORM record committed *before* the effect runs.
> **Prerequisites:** read [*Agent OS in 5 Minutes*](../concepts.md) and the
> [*Composition Root Guide*](./composition-root-guide.md) first — this tutorial assumes you know what
> the single governed edge (`runGovernedToolCall`) is and that Agent OS is a **library, not a service**.
> **The one rule of this repo:** *only command output is truth.* `agentos manifest lint` exiting `0`
> is the single proof your manifest is legal; `pnpm run verify` green is the single proof the wiring
> holds.

This is the flagship "build a tool" walkthrough. The
[manifest-authoring doc](./tool-manifest-authoring.md) tells you how to declare *one* manifest; this
doc walks the whole arc: choosing the right binding family, authoring the manifest, writing the
binding (with the credential **placeholder** model and the composer-fixed endpoint), wiring the
governance primitive a seal-punching tool needs (or watching the registry refuse it), running it
through the governed pipeline to see the WORM event, and — optionally — advertising it to an
autonomous brain.

Every code shape below is a **real shape from the repo**. Where a tool is shown, it is the actual seed
tool you can read in source (e.g. `gmail.send` in
[`action-seed-tools.ts`](../../src/runtime/brain/adapters/hermes/action-seed-tools.ts)).

---

## 0. Honest scope (read this first)

- **`agent-os` is a private, in-repo package right now.** `npm install agent-os` does **not** resolve
  yet. Use the in-repo clone path: `git clone … && pnpm install`, then run the repo's own scripts and
  reference the source files cited here.
- **The seed tools live in the Hermes vendor-adapter zone**
  (`src/runtime/brain/adapters/hermes/`) and are re-exported via the hermes barrel. They are the
  *worked examples* this tutorial reads from. Your own family lives wherever you compose it; the
  governance contracts it must satisfy (`ToolManifest`, the binding shape, the capability-containment
  gate) are the neutral `src/tools` + the binding ports.
- **In-repo-runnable vs deploy-gated.** The manifest lint, the registry admission gate, the binding's
  fail-closed gates, the credential-blind input guard, and the governed pipeline + WORM record all run
  **now**, in memory, with zero external dependencies. The *real* send/fetch reaching a live API, the
  real OAuth/`SecretResolver`-at-egress credential resolution, and the released attestation verifier
  are **deploy-gated** — each is flagged explicitly below.

---

## 1. Choose the binding family

A tool *manifest* is family-agnostic — every tool, whatever it does, declares the same ten fields and
registers in the same `ToolRegistry`. What differs is the **binding**: the composer-held object that
turns a brain's *declared params* into a real effect. There are three binding families today; pick by
*what the effect actually is*.

| If your effect is… | Use | Binding port | The effect builds… | Worked examples |
|---|---|---|---|---|
| **A program invoked with an argv vector** (a CLI, `git`, `curl`) | **`ExecToolBinding`** | [`exec-closed-loop.ts`](../../src/runtime/brain/adapters/hermes/exec-closed-loop.ts) | a pure argv **string vector** run via `execve` (never `sh -c`) | [`exec-seed-tools.ts`](../../src/runtime/brain/adapters/hermes/exec-seed-tools.ts) — `exec.echo`, `exec.run`, `git.commit`, `net.fetch` |
| **A non-argv app/API call** (Gmail, Drive, Calendar — a `{service, method, params}` descriptor) | **`ActionBinding`** | [`action-closed-loop.ts`](../../src/runtime/brain/adapters/hermes/action-closed-loop.ts) | a structured **descriptor** (no command string at all) | [`action-seed-tools.ts`](../../src/runtime/brain/adapters/hermes/action-seed-tools.ts) — `gmail.send`, `drive.read`, `calendar.events.create` |
| **Driving a real browser page** (navigate/read/click/type) | the **browser family** | [`browser-closed-loop.ts`](../../src/runtime/brain/adapters/hermes/browser-closed-loop.ts) | a structured page command | [`browser-seed-tools.ts`](../../src/runtime/brain/adapters/hermes/browser-seed-tools.ts) — `browser.navigate`, `browser.click` |

### Why these are *separate* families, not one generalization

The exec seam is the product's **highest-risk** surface: it is the one place an untrusted brain's
input could become a command. `ActionBinding` is a deliberate *sibling*, not a generalization of it —
generalizing the exec seam to cover non-argv APIs would mutate the argv-purity logic for a capability
that does not even have an argv. The no-shell guarantee is in fact *stronger* for an action: an action
is a `{service, method, params}` descriptor — there is **no command string, no argv, no `sh -c`** to
parse — so the entire class of shell/argv injection is structurally impossible, not merely guarded.

> **Rule of thumb.** If you would have written `child_process.spawn(argv)`, you want an
> `ExecToolBinding`. If you would have written `await api.gmail.send({to, …})`, you want an
> `ActionBinding`. If you would have driven a `Page`, you want the browser family.

The rest of this tutorial builds an **ActionBinding** end-to-end (the `gmail.send` shape), then shows
the exec variant at each step so you can author either.

---

## 2. Author the manifest (the ten fields + the two guardrails)

Every tool starts with a `ToolManifest` — the agent-agnostic, vendor-neutral declaration of *what the
tool does to the world*. The schema is owned by
[`src/tools/manifest.ts`](../../src/tools/manifest.ts); the full field reference and the canonical
template are in [`tool-manifest-authoring.md`](./tool-manifest-authoring.md). Here is the actual
`gmail.send` manifest (from `action-seed-tools.ts`):

```ts
export const gmailSendManifest = {
  name: "gmail.send",
  version: "1.0.0",
  description: "send an email via the Gmail API (egress + approval gated)",
  action: "tool:invoke",
  resourcePattern: "gmail/send",
  sideEffect: "destructive" as const,   // sending is irreversible
  idempotent: false,                    // re-running re-sends
  // FORCED true by the manifest superRefine (destructive => requiresApproval). A destructive action
  // can NEVER escape the approval gate; set it true to satisfy parseToolManifest.
  requiresApproval: true,
  bundleRefOnly: false,
  containment: "network-egress" as const, // it punches the sandbox seal to the network
};
```

The fields that **drive the gates** (the rest are identity/metadata):

- **`sideEffect`** (`none | read | write | destructive`) — the strongest effect on the world. Drives
  the pipeline's `requiresApproval`/`external` flags and the capability-containment classifier.
- **`containment`** (`in-sandbox | network-egress | host-fs-write`) — *where the effect is allowed to
  reach*. This is the single source of truth for whether the tool **punches the sandbox seal** and
  thus which fail-closed primitive it needs (§4). It is **required, with no default** — a manifest
  that omits it fails parse, because an unclassified capability is an unknown blast radius.
- **`idempotent` / `requiresApproval`** — bound by the two cross-field guardrails below.

### The two guardrails (`.superRefine`)

`manifest.ts` enforces two cross-field invariants. Violate either and `parseToolManifest` throws and
`agentos manifest lint` exits `1`:

- **Guardrail A — `sideEffect: "none"` ⇒ `idempotent: true`.** A no-effect tool that claims it cannot
  be safely re-run is contradictory.
- **Guardrail B — `sideEffect: "destructive"` ⇒ `requiresApproval: true`.** A destructive tool can
  **never** be authored to skip human approval. This is exactly why `gmail.send` *must* set
  `requiresApproval: true` — the schema would reject it otherwise.

### Lint it (the only proof of legality)

Save your manifest to JSON and lint it (full flow in
[`developer-quickstart.md`](./developer-quickstart.md) §3):

```bash
node dist/cli/main.js manifest lint your-tool-manifest.json
# ok your.tool@1.0.0      → exit 0: structurally legal AND both guardrails satisfied
```

A `destructive` manifest with `requiresApproval: false` exits `1` with the Guardrail B message on
stderr — fail-closed, never silently accepted.

### Exec variant

The exec manifests are identical in shape — `exec.echo` is `sideEffect: "read"`,
`containment: "in-sandbox"`; `git.push` is `sideEffect: "destructive"` +
`containment: "network-egress"` (so Guardrail B forces `requiresApproval: true`). See
`echoManifest` / `gitPushManifest` in `exec-seed-tools.ts`.

---

## 3. Write the binding (strict args, the credential **placeholder**, the composer-fixed endpoint)

The manifest declares *what*; the binding implements *how* — and it is where the credential-blind and
no-injection guarantees are actually built. The brain proposes **only a registered tool name + the
declared params**. It never supplies the service, the method, the host, the argv, or a credential. The
**composer** holds the binding and fixes all of that.

Here is the actual `gmailSendBinding` (`action-seed-tools.ts`), annotated:

```ts
export const gmailSendBinding: ActionBinding = {
  // (1) COMPOSER-FIXED endpoint. The brain never supplies these — there is NO retarget surface.
  service: "gmail",
  method: "send",

  // (2) STRICT argSchema. `.strict()` is REQUIRED: a smuggled extra channel (a `bcc`, a raw `params`)
  // FAILS validation and never reaches the connector.
  argSchema: z
    .object({
      to: z.string().min(1),
      subject: z.string(),
      body: z.string(),
    })
    .strict(),

  // (3) Build the structured params body in ONE place from the VALIDATED args. Pure: a plain record,
  // never a command string. A `"; rm -rf /"` value is inert DATA in a structured field.
  toParams: (a) => {
    const v = a as { to: string; subject: string; body: string };
    return { to: v.to, subject: v.subject, body: v.body };
  },

  // (4) The credential PLACEHOLDER — never a literal secret. Keyed by the CONSTANT NAME, so the
  // descriptor env is { AGENTOS_GMAIL_OAUTH_KEY: "openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY" }.
  toCredentialEnv: () => toCredentialEnv(GMAIL_OAUTH_KEY_ENV),

  // (5) The REQUIRED projector — safe-derived governance fields ONLY (host + class + flags), NEVER the
  // params. NON-VACUITY: remove the host => no networkHosts => the network-egress gate denies.
  actionProjector: () => actionProjection("gmail", "send", GMAIL_HOST, ["send"]),
};
```

### (a) Composer-fixed `service`/`method` ⇒ no retarget surface

`service` and `method` are string literals in the binding. The brain cannot change which API endpoint
is hit — it can only choose *which registered tool name* to call. There is no field through which an
endpoint, host, or URL can be injected. (For exec, the analog is `argvPrefix` — `["git", "commit",
"-m"]` for `gitCommitBinding` — the program and every fixed flag are composer-owned; the brain never
supplies `argv[0]`.)

### (b) Strict `argSchema` ⇒ no smuggled second channel

`.strict()` (no unknown keys) is not optional. It is the gate that makes a smuggled `argv` /
`; rm -rf /` / `bcc` extra key **fail validation** before the effect is ever reached. The schema is
also the *only* place the params' shape is defined, so the param **keys** are always composer-declared
field names (`to`/`subject`/`body`), never attacker-chosen.

### (c) The credential **placeholder** model — never a real secret in the binding

A binding **never** carries a credential. `toCredentialEnv` emits only a **placeholder** in OpenShell's
grammar via `placeholderForKey(KEY)`
([`src/credential/inject.ts`](../../src/credential/inject.ts)):

```ts
placeholderForKey("AGENTOS_GMAIL_OAUTH_KEY")
// → "openshell:resolve:env:AGENTOS_GMAIL_OAUTH_KEY"   (a REFERENCE, never a value)
```

The shared `toCredentialEnv(authKey)` helper is **fail-closed**: the key must be an uppercase
C-identifier (`SAFE_ACTION_ENV_KEY = /^[A-Z][A-Z0-9_]*$/`) **and** must not be a control name
(`FORBIDDEN_ACTION_KEYS` — `HTTP_PROXY`, `HOME`, `PATH`, …); anything else returns `{}` (no env at
all). The placeholder's real value is resolved by OpenShell's `SecretResolver` **at the sandbox egress
boundary** — agent-os only ever *assembles* the placeholder string. (The exec analog is the binding's
`toEnv?`; `net.fetch` uses the identical `SAFE_ENV_KEY`/`FORBIDDEN_AUTH_KEYS` discipline via
`netFetchAuthEnv`.) This resolution is **deploy-gated**: until it lands, an action is
unauthenticated-to-allowlisted.

> **The input guard backstops this.** Even if you wrote a literal secret into params or env by mistake,
> `bindingWrappedActionEffect`'s credential-blind input guard (§5) detects it and denies *before* the
> connector is reached.

### (d) The projector for egress / host-write

The `actionProjector` (REQUIRED for actions) emits a credential-blind `GovernanceProjection` carrying
**only safe-derived fields** — the composer-fixed provider host (`networkHosts`), a coarse
`operationClass`, and `destructiveFlags` — and **never** the params:

```ts
function actionProjection(service, method, host, destructiveFlags): GovernanceProjection {
  return {
    version: 1,
    operationClass: `action:${service}.${method}`,
    argv0: `${service}.${method}`, argc: 0, argvRedacted: [], truncated: false,
    usesShellInterpreter: false,
    networkHosts: [host],            // the composer-fixed provider host the egress fold gates
    destructiveFlags: [...destructiveFlags],
    writeTargets: [],                // an action punches the network seal, not the host disk
  };
}
```

`networkHosts` is the **exact** value the egress gate decides on. This is why removing the host is a
non-vacuity failure: no `networkHosts` ⇒ the network-egress fail-closed gate denies (the destination is
unknown). For an exec tool that punches the seal, the projector is `governanceProjector?` — e.g.
`net.fetch` overrides `networkHosts` to the bare `new URL(url).hostname`; a `host-fs-write` tool would
project `writeTargets`.

---

## 4. Wire the required primitive — or the registry refuses to register it

This is the capability-breadth spine: **build the fail-closed governance primitive *before* you open
the capability that needs it.** A tool's `containment` (and a `destructive` `sideEffect`) determines
which primitive(s) it requires, and the registry **refuses to register** a tool whose primitive is not
wired. The classifier and gate live in
[`src/tools/capability-containment.ts`](../../src/tools/capability-containment.ts):

```ts
requiredPrimitives(manifest):
  in-sandbox     -> []                      // rides the sandbox seal; needs NO primitive
  network-egress -> ["egress-allowlist"]    // punches the seal to the network
  host-fs-write  -> ["host-write-target"]   // punches the seal to the host disk
  + if sideEffect === "destructive", add "approval"   // destructive must go through approval
```

So `gmail.send` (network-egress **and** destructive) requires **both** `egress-allowlist` **and**
`approval`. The gate is `assertRegisterable(manifest, wired)`, which the `ToolRegistry` calls at every
registration seam:

```ts
export function assertRegisterable(manifest, wired = WIRED_PRIMITIVES): void {
  const missing = requiredPrimitives(manifest).filter((p) => !wired.has(p));
  if (missing.length > 0) {
    throw new Error(
      `capability "${manifest.name}" requires unwired governance primitive(s) [${missing.join(", ")}] — ` +
      `refused (deny-by-default at registration)`,
    );
  }
}
```

### See the deny (deny-by-default at registration)

`WIRED_PRIMITIVES` is **empty by default**. So a composition that has wired *nothing* and tries to
register `gmail.send` is refused — the registry throws before the manifest can ever enter:

```ts
import { ToolRegistry } from "agent-os/tools";          // production import shape (in-repo today)

const reg = new ToolRegistry();                         // wired = WIRED_PRIMITIVES (empty)
reg.register(gmailSendManifest);
// throws: capability "gmail.send" requires unwired governance primitive(s)
//         [egress-allowlist, approval] — refused (deny-by-default at registration)
```

This is not a runtime deny — it is a **composition-time admission** gate. A seal-punching tool whose
primitive is unwired *cannot enter any registry*, so it can never even reach the PDP. (The PDP —
`authorizeToolInvoke` — remains the sole *runtime* deny authority.)

### Wire it, and the same tool registers

Pass a `wired` set that contains the required primitives and the same tool registers cleanly:

```ts
const wired = new Set(["egress-allowlist", "approval"] as const);
const reg = new ToolRegistry(undefined, wired);
reg.register(gmailSendManifest);                        // OK — both primitives wired
```

The seed factories encode exactly this ordering. `seedActionRegistry(wired)` /
`seedActionBindings(wired)` (in `action-seed-tools.ts`) register `gmail.send` and
`drive.files.delete` **only** when both `egress-allowlist` and `approval` are wired, and the read/write
actions (`drive.read`, `calendar.events.list`) only when `egress-allowlist` is wired — a partial wiring
is refused on the destructive tool first (the strongest deny-by-default signal). The exec analog is
`seedRegistry(wired)` / `seedBindings(wired)`: the 14 in-sandbox tools register under *any* wired set
(they require no primitive), while `net.fetch` registers only with `egress-allowlist` and `git.push`
only with both.

> **Wire the `approve` seam too.** Wiring `"approval"` into the registry's set is what lets a
> destructive tool *register*. Separately, you must inject an `approve` seam into
> `runGovernedToolCall` — otherwise the call is `denied@approval` at runtime. See
> [`composition-root-guide.md`](./composition-root-guide.md) §4 (contract 3).

---

## 5. Run it through the governed pipeline + see the WORM event

Registration makes a tool *exist*; the binding makes it *executable*; but a tool only *runs* by going
through the single governed edge, `runGovernedToolCall`
([`composition-root-guide.md`](./composition-root-guide.md) §1). You wrap your connector/substrate with
the binding family's effect wrapper and inject *that* as the pipeline's `effect` seam. For an action:

```ts
import {
  bindingWrappedActionEffect,
  FakeActionConnector,            // the in-repo test double; real MCP/OAuth connector is deploy-gated
} from "…/hermes";

const effect = bindingWrappedActionEffect(connector, seedActionBindings(wired));
// inject `effect` into runGovernedToolCall alongside screen/authorize/approve/cost/appender
```

`bindingWrappedActionEffect` runs **three fail-closed gates before the connector is ever called**
(mirrored by `bindingWrappedExecEffect` for exec):

1. **No binding for the tool ⇒ deny.** `bindings.get(toolCall.tool) === undefined` →
   `{ ok: false }`, connector **not** called. This is deny-by-default, parallel to the registry: a tool
   name with no composer binding never executes.
2. **`argSchema.safeParse` fails ⇒ deny.** Any unknown/extra/missing key → `{ ok: false }`, connector
   **not** called. The smuggled-channel attack dies here.
3. **Credential-blind input guard ⇒ deny.** The built params + env are screened by the recursive
   `defaultExecSecretDetector`; a **literal secret** in any nested field →
   `{ ok: false, detail: "credential-blind: raw secret in action params/env — use a placeholder, not a literal" }`,
   connector **not** called. A detector throw is treated as "secret present" (fail-closed).

Only a fully validated, credential-blind proposal builds the descriptor —
`{ service, method, params, env? }` — and reaches `connector.invoke`. The descriptor is assembled in
**one place**; `service`/`method` are the composer-fixed literals.

### The WORM event (commit-before-effect)

The pipeline commits a WORM event **before** the effect runs (`src/commitgate/guard.ts` awaits the
appender, then runs the effect on the next line — the un-recorded-effect guard). What it records from
your projection is the **boundary summary** (`boundarySummaryFromProjection`,
[`src/orchestration/pipeline.ts`](../../src/orchestration/pipeline.ts)) — the safe allow-list only:

- `networkHosts` (userinfo-stripped, host-only — the very thing the egress gate decides on)
- `writeTargets` (safe path metadata — the host-write gate's subject)
- `operationClass` (a coarse bucket)
- `destructiveFlags` (intersected with a known flag set)

It **never** records `argvRedacted` or `argv0`. For `gmail.send` that is
`{ networkHosts: ["gmail.googleapis.com"], operationClass: "action:gmail.send", destructiveFlags:
["send"], writeTargets: [] }` — no `to`, no `subject`, no `body`, no credential. That is the
credential-blind, attester≠actor record an auditor later re-derives.

> **The whole spine in one run.** The reference example `pnpm run example:developer`
> ([`developer-quickstart.md`](./developer-quickstart.md) §4) drives a manifest through
> *screen → registry-backed authorize → cost → commit-before-effect → effect → WORM* and prints
> `decision: "executed"`. Copy that composition root and swap in your binding family's effect.

### Adopter contracts you must not break

When you wire your own effect, you own these seams — get them wrong and you reopen a hole
([`composition-root-guide.md`](./composition-root-guide.md) §4):

- The **appender must reject** (or never resolve) to signal a failed WORM append — never resolve a
  falsy receipt, or the effect runs unrecorded.
- The **`AuthorizeDecision` is the sole deny authority** — secondaries only narrow (any-deny-wins).
- **Wire `approve`**, or destructive tools are `denied@approval`.
- **Recovery is forward-only** — an executed external effect is irreversible; recovery is
  snapshot/restore/replay, never undo.

---

## 6. (Optional) advertise it to the brain — deny-by-default

So far the tool runs when *your code* calls `runGovernedToolCall`. To let an **autonomous brain**
discover and propose it, you advertise the family to the brain (the MCP server auto-advertises every
`seedBindings()`/`seedActionBindings()` key and auto-governs every `tools/call` via
`runGovernedToolCall`). Exposing "send an email / delete a file" to an untrusted brain is a deliberate
security posture, so the action family is **deny-by-default off**:

```bash
AGENTOS_ADVERTISE_ACTIONS=true   # the ONLY values that turn it on are exactly "true" or "1"
```

`actionAdvertiseFromEnv` (in
[`exec-mcp-server-bin.ts`](../../src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.ts)) is
fail-closed: unset / blank / `"TRUE"` / `"yes"` / `"true "` / `"false"` all read as **off**. With it
off, the bin is byte-identical to a pure-exec bin — no action manifests, no bindings, no allow rules;
an action `tools/call` is denied at authorize (neither registered nor allow-ruled). The browser family
has the same switch, `AGENTOS_ADVERTISE_BROWSER` (the heaviest posture in the system, same fail-closed
rule).

Advertising does **not** relax any gate. An advertised action still goes through the same registration
admission (§4), the same three binding gates (§5), the PDP, the approval stage, and commit-before-effect.
And for a *live* connector there is a second master switch — `AGENTOS_ACTION_LIVE` plus a test-account
allowlist (`AGENTOS_ACTION_TEST_ACCOUNT`) — that keeps a real connector deny-all until explicitly
enabled and structurally able to act only on an allowlisted test account
([`action-guard.ts`](../../src/runtime/brain/adapters/hermes/action-guard.ts)). That live transport is
deploy-gated/blocked today.

---

## 7. The checklist (author a new family member)

Adding a tool is exactly **a manifest + a binding + registration** — no gate is widened:

1. **Manifest** — ten fields; pick `sideEffect` + `containment` honestly; satisfy both guardrails;
   `agentos manifest lint` exits `0`.
2. **Binding** — composer-fixed endpoint (`service`/`method` or `argvPrefix`); **strict** `argSchema`;
   pure `toParams`/`toArgv` building the descriptor/argv in one place; credential **placeholder** only
   (`toCredentialEnv`/`toEnv`, never a literal); a projector for any seal-punching tool
   (`actionProjector` required; `governanceProjector?` for exec).
3. **Primitive** — wire `egress-allowlist` / `host-write-target` / `approval` as the manifest requires,
   *before* registering — or `assertRegisterable` refuses it (deny-by-default).
4. **Register + bind** — into the `ToolRegistry` (deny-by-default) and the parallel bindings map.
5. **Run** — through `runGovernedToolCall`; confirm the boundary WORM event is credential-blind.
6. **Verify** — `pnpm run verify` green **and** an independent verifier pass before declaring done.

---

## 8. Where to go next

- **Manifest field reference + the canonical template:**
  [`tool-manifest-authoring.md`](./tool-manifest-authoring.md).
- **Wire a whole surface (the seven seams + the deploy-gated boundary):**
  [`composition-root-guide.md`](./composition-root-guide.md).
- **First three governed moments in 15 minutes:** [`developer-quickstart.md`](./developer-quickstart.md).
- **Independently verify the evidence chain (the attester≠actor moat):**
  [`verifier-release.md`](./verifier-release.md).
