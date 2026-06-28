# Agent OS — Video Production Briefs

> **Purpose:** production-ready creative briefs for the Agent OS films, written to be handed
> straight to a motion-design / video studio (or a capable text-to-video + edit pipeline) and
> executed **without back-and-forth**. They encode the product truth, narrative, visual system,
> motion design, sound design, and acceptance criteria for each cut.
>
> **Companions:** [`demo-video-script.md`](./demo-video-script.md) (asset list + the *real* on-screen
> lines from the live scripts) and the read-aloud [`demo-recording-cut-sheet.md`](./demo-recording-cut-sheet.md).
> Ground truth for every trace on screen = the real cast logs (`scripts/act-live-gmail.mjs`,
> `scripts/act5-live-browser.mjs`, and the deny runners).
>
> **繁體中文版 (zh-TW):** [`demo-video-briefs.zh-TW.md`](./demo-video-briefs.zh-TW.md).

## The cuts

One product, several audiences, several jobs. Do **not** make one film do them all.

| Cut | Length | Audience | Job |
|-----|--------|----------|-----|
| **Hero** | 60–75s | Top-of-funnel: CISO / Head of AI / exec | Earn attention; one feeling: *"autonomy I could actually leave running."* The **refusal** is the hero moment. No architecture. |
| **Product Demo** | 2–3 min | Hands-on evaluators (eng / platform / security) | Show the governed pipeline end-to-end, **the same gate across every tool family**; make them want to clone it. |
| **Technical / Architecture** | 5–8 min | Security architects, auditors, deep diligence | Prove each invariant is **structural** (process boundaries, fail-closed control flow, a signed append-only chain) — defensible to a security team. |
| **Architecture & Flow** | ~2.5 min | Onboarding / technical intro | Introduce the architecture and the governed pipeline, **labeling each vendor component** (Hermes / NemoClaw / OpenShell / SpendGuard / AGT) with its **code-verified** role. A focused, shorter subset of the Technical cut (Cut 4 below). |

The through-line is shared across all cuts: **"Hermes proposes. Agent OS governs."** Tagline:
**"Autonomy you can actually leave running."**

## Shared specification (inheritance)

The **Demo** and **Technical** briefs inherit the **Hero** brief's visual system (§4), motion design
(§7), sound design (§8), captions (§9), and hard constraints (§10–11). Each lower brief specifies only
what *differs*. Keep palette, type, the two emphasis beats (the ledger **seal** and the **deny**), and
the reveal discipline (each item appears ~0.2s **before** the word that introduces it) consistent.

## Honest status — what exists vs what these briefs are for

A **synthetic animatic** (terminal-style rendered cards + an AI "nova" scratch VO + word-timed reveals,
A/V-synced) exists as a **pre-viz / timing reference**. It is **not** the enterprise deliverable. The
production step these briefs describe requires **real screen footage** (terminal / browser / inbox /
trace), **licensed music + sound design**, and a **final VO**. Use the animatic as the edit/timing
reference; shoot the real thing against these briefs.

---

## Cut 1 — Hero film (60–75s)

```
=====================================================================
AGENT OS — HERO PRODUCT FILM · PRODUCTION BRIEF v2
=====================================================================

0 · PROJECT
  A 60–75s enterprise hero film for Agent OS. One feeling to leave the viewer with:
  "I could let AI agents act on their own here — and still trust, prove, and audit
  every move." Master 16:9, plus 1:1 and 9:16. 30fps (accept 24 if it suits the grade).
  This is a cinematic product film, NOT a slideshow and NOT a screen-recording with a
  voiceover slapped on.

1 · STRATEGY & POSITIONING
  Audience: CISO, Head of AI/Platform Eng, security architects evaluating whether to let
    agents take real actions (send, pay, browse, run) without a human on every click.
  Their fear: a hijacked or hallucinating agent doing something irreversible, leaking a
    credential, or acting with no provable record of who allowed it.
  Competitive frame (imply, don't bash): the alternatives are (a) a human approving every
    action — doesn't scale, or (b) "guardrails" the agent can talk its way around. Agent
    OS is a control plane the agent CANNOT bypass.
  The one idea: separate the thinker from the doer. The brain proposes; the OS governs.
  Through-line (spine of the film): "Hermes proposes. Agent OS governs."
  Tagline (end card): "Autonomy you can actually leave running."

2 · PRODUCT TRUTH  (accurate; never overclaim; if a shot is reconstructed it must still
   be technically faithful)
  Agent OS = a governance layer between an LLM "brain" and the real world. The agent only
  PROPOSES a tool call; Agent OS screens, authorizes, records, then executes. Four
  invariants ARE the product:
    1. Deny by default — unknown / malformed / error ⇒ refused.
    2. Commit before effect — an append-only, tamper-evident record is sealed BEFORE the
       action runs. If the record fails, the effect never happens. No undo by design.
    3. Credential-blind — the agent sees only a placeholder ("resolve:env:<KEY>"); the real
       secret is resolved at network egress, never in the agent, never in any log.
    4. Attester ≠ actor — the process that signs the record is SEPARATE from the one that
       acts, so the agent cannot forge, rewrite, or restore its own history.
  The governed path (keep trace text faithful, in this order):
    screen → authorize (policy · egress · approval; deny by default) → commit (record
    sealed) → effect → boundary.
  Components (only if a longer cut needs them; not required in the hero):
    Hermes = brain (proposes) · OpenShell = execution substrate (sandbox) · NemoClaw =
    agent hosting · Agentic SpendGuard = cost gate (reserve/commit budget) · AGT = advisory
    governor (can only narrow a decision, never grant). All swappable behind neutral ports;
    the governance core (the "spine" + the tamper-proof ledger) is vendor-neutral.

3 · REFERENCES / MOOD  (match this register, do not copy)
  The calm authority of Apple's privacy films; the restraint and product-forward editing
  of Linear and Stripe launch films; the "serious infrastructure" feel of Vanta / Vercel.
  Think: confident, quiet, exact. Closer to a security keynote than an ad.

4 · TONE & VISUAL SYSTEM
  Tone: calm, confident, founder-credible. Cinematic restraint. Let silence do work.
  Palette: near-black base #0a0e14; soft slate text #cdd6f4; semantic accents — green
    #a6e3a1 = allowed / sealed, red #f38ba8 = denied, amber #fab387 = credential, blue
    #89b4fa = system/stage labels. Use accents sparingly, as meaning, not decoration.
  Type: a clean grotesk for titles (e.g. Inter/Suisse); a crisp mono for terminal/trace
    (e.g. SF Mono/JetBrains Mono). Generous margins; never fill the frame.
  Footage policy: the PROOF beats (hook send, allow trace, deny trace, inbox, credential
    egress) MUST be real product capture or a frame-faithful reconstruction. Stylized
    motion-graphics are allowed ONLY for the idea diagram and the closing invariants.

5 · VOICEOVER  (final copy — read verbatim; warm, measured, ~60s total)
  HOOK   "An agent just sent this email. For real, to a real inbox. No human clicked send."
  STAKES "That's where software is going. It's also the risk. An agent can be hijacked by
          a single web page. It can leak the keys you give it. It can do something
          irreversible — and leave no record of who allowed it."
  IDEA   "Agent OS changes the deal. Let the agent act freely — but force every single
          action through one gate it cannot bypass."
  ALLOW  "Watch it send. The tamper-proof record is written first. The email can't leave
          until that record is sealed. And the credential? The agent never even sees it."
  DENY   "Now the same send. But this time, not approved. The gate stops it. No effect.
          No email. Nothing to undo — because nothing happened."
  CLOSE  "Deny by default. Commit before effect. Credential-blind. And the thing that
          records is never the thing that acts. Agent OS. Autonomy you can actually leave
          running."
  Alt hook (A/B option): "This email was sent by an AI agent — unattended. The story
          isn't that it sent it. It's everything Agent OS forced to happen first."

6 · BEAT SHEET  (reference timing from the measured VO; add the holds in §7 → ~64s total)
  # | beat   | in–out (m:ss) | on-screen                                   | sound
  1 | HOOK   | 0:00–0:05     | real terminal send → real inbox receives    | bed in soft
  2 | STAKES | 0:05–0:18     | 3 risks surface one-at-a-time, as spoken    | low tension
  3 | IDEA   | 0:18–0:27     | diagram resolves: Agent → [gate] → effect   | bed lifts
  4 | ALLOW  | 0:27–0:37     | real trace; [commit] seals BEFORE [effect]; | SEAL thunk +
    |        |               | credential placeholder → [REDACTED]@egress  | 0.8s near-silence
  5 | DENY   | 0:37–0:47     | same trace STOPS at approval; denied (red); | music cut to
    |        |               | no commit, no effect; hold on the stillness | ~0.8s silence
  6 | CLOSE  | 0:47–0:60     | 4 invariants land one-per-phrase → wordmark | bed resolves
    |        |               | + tagline + single CTA "try it yourself →"  |

7 · MOTION DESIGN  (this is where a first attempt fails — "abrupt". Fix precisely.)
  - NO hard scene cuts. Between beats: cross-dissolve or match-cut, 8–14 frames, eased
    (cubic in-out). Carry one element across the cut (motion continuity) where possible.
  - Reveals: each line/item fades + rises ~12px over 6–10 frames, ease-out. It appears
    ~0.2s BEFORE the word that introduces it — never earlier, never all at once, never
    after. Sync to the VO word timings (a transcript with word timestamps is provided).
  - Breathing room: hold the final frame of each beat ~0.5–0.8s before transitioning.
    Never let the visual out-run or lag the narration.
  - Camera: slow, intentional ~3–5% pushes toward the key line (the [commit] seal; the
    denied@approval line). No drift, no gratuitous parallax.
  - The SEAL animation (beat 4): when [commit] fires, a brief ledger-row "locks" (a subtle
    fill sweep + a click of weight), and ONLY THEN does [effect] illuminate. The order must
    read unmistakably as commit → then → effect.

8 · SOUND DESIGN & MUSIC
  - Bed: understated, building electronic/orchestral; serious, never poppy. Ducks under VO.
  - Two emphasis beats: at the SEAL (commit) and at the DENY, drop the bed to near-silence
    for ~0.8s, then resume — let those land.
  - SFX: a soft, weighty "lock/seal" thunk on commit; a single low, final tone on the deny;
    quiet keystroke/terminal texture under the live runs. Nothing cartoonish.
  - VO mixed forward and intelligible at all times.

9 · CAPTIONS · ACCESSIBILITY · LOCALIZATION
  - Provide burned-in-optional captions + a clean SRT. Captions reinforce, not duplicate
    verbatim, the VO. Legible at 9:16 mobile sizes.
  - Color is never the only signal (allowed/denied also carry an icon/label).
  - Build text on its own layer so EN can be swapped for other languages without re-edit.

10 · HARD CONSTRAINTS
  - Real product footage for terminal/browser/inbox/trace (or frame-faithful reconstruction).
  - Honesty: claim nothing the product doesn't do; deploy-gated capabilities, if shown,
    are labeled as such.
  - Redact every secret/PII on screen (test email → ••••••••@gmail.com); never show a real
    credential or token, even briefly.
  - Trace text stays faithful to the order in §2. Commit ALWAYS before effect.

11 · AVOID  (the specific failure modes)
  Abrupt hard cuts between scenes · slideware / "cards with a voiceover" feel · items
  appearing before they're narrated or all at once · logo-first open · marketing fluff and
  hype words ("revolutionary", "seamless", "next-gen", "game-changing") · music that fights
  the VO · walls of text · motion for motion's sake · burying the DENY (it is the climax).

12 · MATERIALS PROVIDED / NEEDED
  Provided: final VO script (above) + a nova-voiced scratch track + word-level SRT; real
    captured cast logs for every trace (ground truth for the on-screen text); brand color
    + type spec (§4).
  Needed from production: real screen capture (or reconstruction) of the runs; licensed
    music; final human VO (or approved AI VO); the seal/deny sound design.

13 · DELIVERABLES & DEFINITION OF DONE
  Deliver: 60–75s master 16:9; 1:1 and 9:16 cuts; SRT; a 6–10s teaser cut from HOOK + DENY;
    an editable project so beats can be re-timed.
  Done when: (a) no transition reads as abrupt; (b) every reveal lands within ±0.15s of its
    VO word; (c) the commit-before-effect order is unmistakable on first viewing; (d) the
    DENY is the emotional peak; (e) a security buyer who watches once, muted, still gets
    "the agent can't bypass it, and it's all on the record."
=====================================================================
```

---

## Cut 2 — Product demo film (2–3 min)

```
=====================================================================
AGENT OS — INTRODUCTION & DEMO FILM · PRODUCTION BRIEF  (cut 2 of 3)
=====================================================================

0 · PROJECT
  A ~3 min INTRODUCTION-and-demo for hands-on evaluators. One feeling: "I understand what this
  is and why it matters — and I've now seen it actually work. I want to run it." Master 16:9
  + 9:16. Inherits the visual system, motion, sound, and constraints of the HERO BRIEF v2
  (§4, §7–11). REAL footage for the demo half.
  IMPORTANT — it is an INTRODUCTION *then* a DEMO, in that order. Do NOT cold-open into a
  terminal. PART 1 (~60s) orients the viewer (what world, what problem, what Agent OS IS, the
  promise); only then does PART 2 show it working. A teaser/hero cold-open is a different cut
  (Cut 1). This was the key correction: an "intro & demo" must introduce before it demonstrates.

1 · STRATEGY & POSITIONING
  Audience: eng leads, platform/security engineers running an evaluation.
  Goal: prove the governed pipeline end-to-end, across MORE than one tool family (API +
    browser, + exec if available), and make the invariants tangible by showing them, not
    asserting them. Lower the perceived integration cost ("it's one gate, every tool").
  Keep the through-line: "Hermes proposes. Agent OS governs."
  Tonal shift vs hero: less fear-framing, more "watch it work." Still calm, exact.

2 · PRODUCT TRUTH
  Inherit HERO BRIEF v2 §2 in full. Add for the demo: the SAME control plane wraps every
  tool family — API actions (gmail/drive/calendar), browser (navigate/read/click/type),
  and exec (argv in a sandbox). The point of the demo is that the gate is family-agnostic.

3 · SEQUENCE  (11 scenes, INTRODUCTION-first; ~3:10 + breathing gaps ≈ 3:14)
  PART 1 · INTRODUCTION (orient — ~58s; do NOT cold-open into the demo)
    S1 · THE WORLD (~12s) — agents now ACT, not just chat: send / run / browse / move money,
         increasingly on their own.
    S2 · THE PROBLEM (~18s) — acting unattended is dangerous: hijack, leaked keys, irreversible,
         no record of who allowed it. Today: babysit every action, or run-and-hope.
    S3 · WHAT AGENT OS IS (~17s) — the one-line definition + the shape (Brain proposes →
         Agent OS governs/records/executes → effect); "one control plane it cannot bypass —
         the thinker separated from the doer." (The orientation a cold-open skips.)
    S4 · THE PROMISE (~11s) — the four rules → "autonomy you can actually leave running" →
         "let's watch it work."
  PART 2 · DEMO (show — ~110s)
    S5 · THE GOVERNED PATH (~23s) — a real send; reveal each trace stage as it is named:
         screen → authorize (deny by default) → approval → cost → commit (sealed) → effect.
    S6 · COMMIT BEFORE EFFECT (~13s) — record written first; the email can't leave until it's
         sealed; no log-it-later, no undo. (§8 SEAL beat.)
    S7 · CREDENTIAL-BLIND (~13s) — the agent's arg is a placeholder; resolved to [REDACTED]
         only at egress; never in the agent, never in the log.
    S8 · SAME GATE, THE BROWSER (~17s) — same gate, different family: only allow-listed hosts;
         the read-back is scrubbed, capped, marked untrusted before the agent reads it.
    S9 · THE REFUSAL — THE CLIMAX (~23s) — same send, not approved → denied@approval, no
         commit/effect/email; then a browser call to a non-allow-listed host → denied@policy
         at the network. "Deny by default isn't a setting; it's the default." (§8 DENY beat.)
    S10 · ATTESTER ≠ ACTOR (~13s) — a separate process signs the record; the agent can't
         forge, rewrite, or restore its own history.
  PART 3 · CLOSE (~24s)
    S11 · RECAP + CTA — ~1,800 tests green + an independent verifier; the four rules; wordmark
         + tagline + "clone it · run the demo · point it at your own agent."

4 · VOICEOVER  (final copy — read verbatim; calm, founder-credible. Each on-screen title
   must echo the line it plays under — no title/narration mismatch.)
  S1  "AI agents used to just talk. Now they act — they send email, run commands, browse the
       web, even move money. And increasingly, they do it on their own."
  S2  "That's powerful. It's also dangerous. A single poisoned web page can hijack an agent.
       It can leak the keys you hand it. It can take an action that can't be undone, and leave
       no record of who allowed it. So today, you have two bad options: approve every action
       by hand, or let it run, and hope."
  S3  "Agent OS is a governance layer for AI agents. The agent, the brain, only proposes what
       it wants to do. Agent OS decides, records, and executes, forcing every single action
       through one control plane the agent cannot bypass. The thinker is separated from the doer."
  S4  "Four rules make that safe to trust. Deny by default. Commit before effect.
       Credential-blind. And the recorder is never the actor. The result is autonomy you can
       actually leave running. Let's watch it work."
  S5  "Here, an agent sends a real email. But watch the path it takes. The agent only proposes
       the call. Agent OS screens it for secrets. Checks policy, deny by default. Requires
       approval for anything destructive. Reserves the budget. Commits a tamper-proof record.
       And only then, sends. Every action takes this same path."
  S6  "Look at the order. The record is written first. The email cannot leave until that record
       is sealed. If the record fails, the effect never happens. No log-it-later, and by design,
       no undo."
  S7  "And the credential? The agent never touches it. In its request, the key is just a
       placeholder. The real token is resolved at the last moment, on the way out. Never in the
       agent. Never in the log."
  S8  "It's the same gate for every tool. Now the agent browses, but only the hosts it's allowed
       to reach. And whatever the page returns is scrubbed of secrets, length-capped, and marked
       untrusted, before the agent is ever allowed to read it."
  S9  "Now, the same email, but this time, not approved. The gate stops it. No commit. No effect.
       No email. The connector is never even reached. And a browser call to a host that isn't
       allow-listed dies at the network, before the browser moves. Deny by default isn't a
       setting. It's the default. There's nothing to undo, because nothing happened."
  S10 "And here's the heart of it. The thing that acts is never the thing that signs the record.
       They're separate processes. So a compromised agent cannot forge its own history, rewrite
       it, or even restore it."
  S11 "Every build re-runs the same gate, and an independent verifier checks it with fresh eyes.
       Around eighteen hundred tests, green. Deny by default. Commit before effect.
       Credential-blind. The recorder is never the actor. That's Agent OS. Autonomy you can
       actually leave running. Clone it, run the demo, then point it at your own agent."

5 · FOOTAGE  (PART 1 = clean motion-graphics cards; PART 2 = real-capture priority)
  PART 1 (intro) is motion-graphics: the world, the risks, the definition + the shape diagram,
  the four rules. PART 2 (demo) is REAL capture — split / picture-in-picture with the trace on
  one side and the real RESULT on the other (inbox for S5–S6, Chromium for S8, the "nothing
  happened" stillness for S9). Real cast logs are the ground truth for every trace line.

6 · MOTION · SOUND · CAPTIONS — inherit HERO BRIEF v2 §7, §8, §9. Two near-silence beats: the
  SEAL in S6 and the DENY in S9. Reveal discipline: each item appears ~0.2s before its word,
  timed to a word-level transcript. Production learnings (validated on the built cut):
  (a) NO per-item highlight box — the timed reveal alone marks the current line; a background
      highlight reads as redundant.
  (b) Scenes join with a breathing gap (~0.4s) + a dissolve through the dark background — never
      a hard cut (hard cuts read as "abrupt").
  (c) Every on-screen title must echo the VO it plays under (e.g. S1 title "AI agents don't just
      talk. They act." matches the S1 line; S2 "Powerful. And dangerous." matches the S2 line).

7 · CONSTRAINTS / AVOID — inherit HERO §10–11. Intro&demo-specific: never cold-open into the
  demo (orient first — PART 1 before PART 2); never show two tool families with different-looking
  gates (the whole point is ONE gate); never skip the commit→effect order; keep every trace
  faithful; no title/narration mismatch.

8 · DELIVERABLES & DEFINITION OF DONE
  Deliver: ~3 min master 16:9; 9:16 cut; SRT; chapter markers; an editable project. Done when:
  a first-time viewer is ORIENTED (knows what Agent OS is and why) BEFORE the demo; the "same
  gate, every tool" idea is unmistakable; the DENY is the peak; every title matches its
  narration; A/V stays in sync (< ~1 frame at every reveal); an evaluator finishes wanting to
  clone the repo.
=====================================================================
```

---

## Cut 3 — Technical / architecture film (5–8 min)

```
=====================================================================
AGENT OS — TECHNICAL / ARCHITECTURE FILM · PRODUCTION BRIEF  (cut 3 of 3)
=====================================================================

0 · PROJECT
  A 5–8 min chaptered technical film for deep diligence. One feeling: "the invariants are
  enforced by the architecture, not by convention — I can defend this to my security team."
  Master 16:9 with visible chapter markers. Inherits HERO BRIEF v2 §4, §7–11 (calmer,
  longer holds; this audience tolerates density). Architecture motion-graphics are welcome
  here; back every claim with real code, trace, or test footage.

1 · STRATEGY & POSITIONING
  Audience: security architects, staff engineers, auditors, technical due-diligence.
  Goal: convince a skeptic that each invariant is structural (process boundaries, fail-
    closed control flow, signed append-only records) — not a flag someone can flip off.
  Register: a security keynote / architecture deep-dive. No hype; precision is the pitch.
  Through-line: "Separate the thinker from the doer — and make the separation enforceable."

2 · PRODUCT TRUTH  (full depth; keep every detail technically faithful)
  Topology: BRAIN (LLM, e.g. Hermes — untrusted, proposes) → SPINE (agent-os — the one
    governed edge; the runGovernedToolCall pipeline) → BODY (execution substrate: OpenShell
    sandbox, real browser) ; and a SEPARATE process: the WORM KERNEL (append-only, hash-
    chained, Ed25519-signed ledger — the attester).
  The pipeline (runGovernedToolCall), in order, consuming injected vendor-neutral seams:
    screen (secret/shape) → authorize (PDP policy + egress + approval + host-fs-write folds;
    deny by default) → cost.reserve → COMMIT (WORM append + await receipt) → effect (guarded
    connector) → cost.commit → boundary (record the crossing). Family-agnostic across exec /
    API actions / browser.
  Components behind neutral ports (swap by config, not rewrite): Hermes = brain · OpenShell
    = execution substrate · NemoClaw = agent hosting · Agentic SpendGuard = cost gate
    (reserve/commit ledger) · AGT = advisory governor (any-deny-wins; can only narrow, never
    grant). The governance core (spine + ledger) imports no vendor — enforced by a dependency
    boundary check.
  Credential model: the brain only ever holds placeholderForKey(KEY) = "openshell:resolve:
    env:<KEY>"; the real secret is resolved ONLY at egress; brain, WORM, and projection see
    only the placeholder. Data-out is gated by a returnContentSanitizer (redact secrets +
    size-bound + mark untrusted).
  Recovery: NO undo by design (effects are real). Forward-only snapshot (WORM-sequence-
    anchored, reference-or-hash-only, credential-blind) + restore (forward-only FSM, attester
    ≠ actor, a verifying-anchor phase cross-validates worm-head + memory-version, fail-closed
    pre-initiated) + replay; a DivergenceReport when live state and snapshot disagree.
  Multi-tenant: cost commits are guarded so a reservation from tenant A can never be committed
    under tenant B (fail-closed); gateway-per-tenant.

3 · CHAPTERS  (~6–7 min; each opens with a titled chapter card + a one-line claim it proves)
  C0 · THREAT MODEL (~45s) — name the adversary: prompt injection, credential exfiltration,
       irreversible effects, repudiation ("who allowed this?"), cross-tenant contamination.
       Frame: guardrails the agent can talk around are not a control plane.
  C1 · ARCHITECTURE (~60s) — Brain / Spine / Body / WORM kernel; the neutral-port seams; the
       composition root wires vendors. Map Hermes/OpenShell/NemoClaw/SpendGuard/AGT to ports.
  C2 · THE GOVERNED PIPELINE (~60s) — walk runGovernedToolCall stage by stage on a real trace;
       show the injected seams and the AuthorizeDecision folds (egress, approval, host-write).
  C3 · INVARIANT 1+2 — DENY-BY-DEFAULT & COMMIT-BEFORE-EFFECT (~75s) — fail-closed control flow
       (unknown/malformed/error ⇒ deny; lives in hooks, never a poller); the WORM append +
       receipt that gates the effect. Show the deny path and the seal-before-effect order in code
       and trace.
  C4 · INVARIANT 3 — CREDENTIAL-BLIND (~50s) — placeholderForKey through the brain/WORM/
       projection; resolution only at egress; the returnContentSanitizer on data-out. Show the
       three views (agent / log / egress) of the same call.
  C5 · INVARIANT 4 — ATTESTER ≠ ACTOR (~60s) — the WORM kernel as a separate signed process;
       append-only hash chain + Ed25519; ingest-side redaction backstop + canonical bytes. Why
       the actor cannot forge, rewrite, or restore its own history. Cross the process boundary.
  C6 · RECOVERY WITHOUT UNDO (~55s) — why there is no undo; forward-only snapshot/restore, admin-
       signed, verifying-anchor cross-validation, DivergenceReport. Recovery is forward, signed,
       and provable — not a rollback the agent could trigger.
  C7 · MULTI-TENANCY & ASSURANCE (~55s) — fail-closed cross-tenant guard; gateway-per-tenant;
       then the verify gate (typecheck · lint · build · test · proto checks · go/py · cross-tenant
       · secret-scan) + the independent fresh-context verifier; ~1,800 tests; no-vendor-in-core
       enforced by the dependency boundary check.
  C8 · CLOSE (~30s) — the trust argument in one line: the agent proposes, a vendor-neutral core
       governs, and a separate signer makes it all provable. Pointers: security model, auditor
       guide, composition-root guide, the SDK.

4 · VOICEOVER  (full copy — read verbatim; calm, exact, security-keynote register; let
   diagrams breathe between chapters; ~7–8 min total)
  C0 · THREAT MODEL
   "Give an AI agent the power to act — to send, to pay, to run commands, to browse — and
    you inherit its worst day. A single poisoned web page can turn it against you. It can
    leak a credential you handed it. It can do something that cannot be undone, and leave no
    trustworthy record of what happened, or who allowed it. In a multi-tenant system, one
    tenant's agent must never reach another's. Guardrails an agent can argue its way around
    are not a control plane. You need a layer it cannot bypass. That is the whole design of
    Agent OS."
  C1 · ARCHITECTURE
   "Agent OS separates the thinker from the doer. The brain — an LLM, here Hermes — only
    proposes a tool call; it is treated as untrusted. Between the brain and the real world
    sits the spine: agent-os, the one governed edge every action must pass through. The body
    is where effects run — a sandboxed substrate, or a real browser. And in its own process
    sits the WORM kernel: an append-only, hash-chained, signed ledger — the attester.
    Everything except the spine and the ledger is a vendor behind a neutral port: Hermes the
    brain, OpenShell the execution substrate, NemoClaw the hosting, SpendGuard the cost gate,
    AGT an advisory governor that can only narrow a decision, never grant one. The
    composition root wires them. The core imports no vendor — and a dependency check enforces
    it. Swap any vendor by config, not a rewrite."
  C2 · THE GOVERNED PIPELINE
   "Here is the path every tool call takes — one function, the same for every kind of action.
    Screen: check the call for secrets and shape. Authorize: the policy decision point
    evaluates it, deny by default, folding in the egress allow-list, the approval requirement,
    and any host filesystem write. Reserve the budget. Then the pivot — commit: append a
    record to the WORM ledger and wait for the receipt. Only after the record is sealed does
    the effect run, through a guarded connector. Then commit the cost, and record the boundary
    crossing. Every stage is an injected, vendor-neutral seam. The same pipeline governs an
    exec command, a Gmail send, and a browser navigation. There is no second path, no fast
    lane, no exception."
  C3 · DENY-BY-DEFAULT & COMMIT-BEFORE-EFFECT
   "The first two invariants live in the shape of the code, not in a setting. Deny by default:
    an unknown tool, a malformed request, an error anywhere in the decision — all fall through
    to refuse. No path lets uncertainty resolve to 'allow.' And the decision lives in the
    request path itself, in the gate — never in a background poller that could lag or fail
    open. Commit before effect: the record is written first. The pipeline appends to the
    tamper-proof ledger and waits for the receipt before the connector is ever touched. If the
    ledger does not seal, the effect never runs. Watch a real trace. Allowed: commit, then
    effect, in that order, every time. Denied — a send that wasn't approved — the trace stops
    at the gate. No commit, no effect; the connector is never reached. Nothing to catch after
    the fact, because nothing happened. And nothing to undo, because the effect, by design,
    has none."
  C4 · CREDENTIAL-BLIND
   "The third invariant: the agent never touches a secret. When the brain proposes a call that
    needs a credential, all it holds is a placeholder — resolve, env, key-name. That
    placeholder is what flows through the brain, into the record, into any projection of state.
    The real token is resolved at the last moment, at the network egress, and nowhere else.
    See the same call three ways: in the agent's request, a placeholder; in the audit log, a
    placeholder, redacted; only on the wire, at egress, the real value — then gone. Data coming
    back is governed too: whatever a page returns is scrubbed of secrets, length-capped, and
    marked untrusted before the agent is ever allowed to read it."
  C5 · ATTESTER ≠ ACTOR
   "This is the heart of it. The thing that acts and the thing that signs the record are
    different processes. The WORM kernel runs on its own — an append-only chain, each entry
    hashed onto the last and signed with a key the actor never holds. Records are redacted on
    ingest, before they're hashed, so a secret cannot slip into the chain. Because the actor
    cannot reach the signer, it cannot forge a record, it cannot rewrite history, and — this
    matters — it cannot restore its own past. A compromised agent cannot quietly erase what it
    did, because the evidence is produced by a process it does not control and cannot
    impersonate. Attestation is structurally separated from action. That separation is what
    makes the record trustworthy to an auditor who trusts neither the agent nor the operator."
  C6 · RECOVERY WITHOUT UNDO
   "A fair question: with no undo, how do you recover? Forward-only. Effects are real — an
    email sent cannot be unsent — so Agent OS refuses to pretend otherwise. Recovery is a
    signed, forward operation. A snapshot is a cut of state, anchored to a point in the WORM
    sequence, holding references and hashes, never raw credentials. A restore is a forward-only
    state machine, run by a separate authority — attester is not actor here either — with a
    verifying phase that cross-validates the ledger head and the memory version, and fails
    closed if they disagree. When live state and a snapshot diverge, you get a divergence
    report, not a silent overwrite. Recovery is something an operator proves and signs — never
    a rollback the agent could trigger to cover its tracks."
  C7 · MULTI-TENANCY & ASSURANCE
   "Two more guarantees. Isolation: a budget reserved by one tenant can never be committed
    under another — the cost path checks it and fails closed — and each tenant gets its own
    gateway. And assurance — how you know any of this holds. Every build runs one gate:
    type-check, lint, build, the full test suite, the protocol checks, the Go and Python
    planes, a cross-tenant isolation check, and a secret scan. Its exit code is the only
    accepted proof that it works. On top, an independent verifier re-runs everything with fresh
    context and adversarially probes the invariants before a change is called done. Around
    eighteen hundred tests, green. And the rule that the core imports no vendor isn't a
    guideline — a dependency boundary check fails the build if it's broken."
  C8 · CLOSE
   "So the trust argument, in one line. The agent proposes. A vendor-neutral core governs
    every action through one gate it cannot bypass. A separate process signs the record, so
    everything is provable — even against the agent itself. Deny by default. Commit before
    effect. Credential-blind. The recorder is never the actor. To verify it yourself, start
    with the security model, the auditor guide, and the SDK. Agent OS — autonomy you can
    actually leave running."

5 · VISUAL  (claim → evidence)
  Each chapter pairs a clean architecture/motion-graphic with the real artifact that proves
  it: source (the pipeline, the placeholder helper, the sanitizer), real traces (allow/deny),
  the kernel's signed chain, the verify run, the dependency-boundary check output. Diagrams
  are schematic and accurate (right boxes, right arrows, right order). Chapter cards + a
  persistent small chapter index aid navigation.

6 · MOTION · SOUND · CAPTIONS — inherit HERO §7–9, but calmer: longer holds, slower pushes,
  a quieter bed (or none under dense code). Captions + SRT mandatory at this length; add a
  chaptered table of contents in the description.

7 · CONSTRAINTS / AVOID — inherit HERO §10–11. Technical-film-specific: technical accuracy is
  non-negotiable — every diagram, trace, and term must match the real system (a wrong arrow
  here loses the whole audience); do not dumb down to the point of inaccuracy; do not claim
  deploy-gated capabilities as shipped (label them).

8 · DELIVERABLES & DEFINITION OF DONE
  Deliver: 5–8 min master 16:9; SRT; chapter markers + TOC; per-chapter clips (for docs/sales
  enablement); editable project. Done when: a security architect can map each invariant to a
  structural mechanism (a process boundary, a fail-closed branch, a signed chain) — not a
  promise; nothing on screen is technically wrong; each chapter stands alone as a clip.
=====================================================================
```

---

## Cut 4 — Architecture & Flow film (~2:30)

```
=====================================================================
AGENT OS — ARCHITECTURE & FLOW FILM · PRODUCTION BRIEF  (cut 4)
=====================================================================

0 · PROJECT
  A ~2.5 min introduction to the architecture and the governed pipeline, for onboarding / a
  technical first-look. One feeling: "I get the shape of the system, and I can see exactly what
  each named component does and where." Master 16:9. Inherits the HERO BRIEF v2 visual system,
  motion, sound, captions, constraints (§4, §7–11) and Cut 2's production learnings (no
  cold-open, no per-item highlight, titles echo the VO, breathing-gap dissolves, reveals timed
  to a word-level transcript). A focused, shorter subset of the Technical cut.

1 · STRATEGY
  Audience: new engineers, partners, technical evaluators who want the mental model fast.
  Goal: ORIENT first, THEN walk the architecture and the flow — and crucially, LABEL each vendor
    component with its real role and show WHERE it acts in the pipeline.
  Through-line: "Separate the thinker from the doer — and make the separation enforceable."

2 · PRODUCT TRUTH — COMPONENT ROLES  (CODE-VERIFIED against real source; do not relabel without
   re-checking the source — these were confirmed by reading the adapters + pipeline)
    Hermes Agent       = Brain — proposes the action; UNTRUSTED. Never executes / denies /
                         governs / writes the WORM. (src/runtime/brain/adapters/hermes; port.ts)
    NemoClaw           = Agent Hosting — hosts / launches the agent process; OUTSIDE the
                         pipeline (lifecycle layer). (src/hosting/adapters/nemoclaw)
    OpenShell          = Execution Substrate — the sandbox where the effect runs; resolves the
                         real secret at EGRESS. Holds NO policy / credential-decision / audit.
                         (src/runtime/openshell; src/runtime/substrate/port.ts)
    Agentic SpendGuard = Cost Gate — reserves the budget BEFORE the effect (hard-cap; over-budget
                         = denied) and settles the REAL cost AFTER. Commit cannot erase an
                         already-incurred spend. (src/cost/adapters/spendguard)
    AGT                = Advisory governor (SecondaryPolicy) — folds into authorize; can only
                         NARROW (any-deny-wins); never grants. The PDP stays the sole grant
                         authority. (src/policy/adapters/agt; src/policy/dedup.ts)
    agent-os (Spine)   = the one governed edge (runGovernedToolCall).
    WORM kernel        = Attester — a SEPARATE process; append-only, server-computed hash chain,
                         Ed25519-signed; the actor holds no key (can only append). NOTE:
                         unforgeable at the PROCESS BOUNDARY today; operator-proof (HSM/KMS) is
                         TR2/deployment — do NOT imply it is live.
  Verified pipeline order (commit STRICTLY before effect):
    screen → authorize (PDP, deny by default; AGT advisory folds in here) → approval (only if
    requiresApproval) → cost.reserve (SpendGuard) → commit (WORM: append + await receipt) →
    effect (OpenShell / connector, only after the receipt) → cost.commit (SpendGuard) → boundary.

3 · SEQUENCE  (9 scenes incl. an opening title card; ~2:32)
  A0 · TITLE CARD (~7s) — "Agent OS · Architecture & Flow" fades up from black (~0.8s); VO
       orients (what Agent OS is + that we'll show how it's built and how an action flows). This
       fixes the abrupt cold-open.
  A1 · ONE PRINCIPLE (~8s) — separate the thinker from the doer; one governed edge.
  A2 · THE ARCHITECTURE (~22s) — four parts build in: Brain (untrusted) · Spine (the one gate) ·
       Body (sandbox/browser) · WORM kernel (a separate, dashed box — the attester).
  A3 · VENDOR-NEUTRAL PORTS (~12s) — every part is a vendor behind a neutral port; governance
       lives in the spine + ledger, not the vendor; swap by config.
  A4 · WHAT FILLS EACH ROLE (~23s) — the labeled mapping (Hermes / NemoClaw / OpenShell /
       SpendGuard / AGT → roles, revealed one per name). THE component-labeling scene.
  A5 · THE PATH EVERY ACTION TAKES (~30s) — the 8 stages reveal in order, each annotated with its
       owner (screen=spine · authorize ← AGT advises · approval · cost.reserve ← SpendGuard ·
       commit = WORM · effect ← OpenShell · cost.commit ← SpendGuard · boundary = spine).
  A6 · ALLOW vs DENY (~16s) — allowed → commit, then effect; denied (policy/approval/budget) →
       trace stops, no commit, no effect.
  A7 · ATTESTER ≠ ACTOR (~16s) — agent holds no key, can only append → can't forge / rewrite /
       restore its history; honest footnote: process boundary today, operator-proof = deployment.
  A8 · CLOSE (~16s) — one governed core, vendor-neutral, separately attested; commit before
       effect, deny by default; pointers (concepts.md, security-model.md); "the thinker proposes,
       the OS governs."

4 · VOICEOVER  (final copy — read verbatim)
  A0 "This is Agent OS, a governance layer for AI agents. Here's how it's built, and how a
      single action flows through it."
  A1 "The principle is simple. Separate the thinker from the doer, and force every action through
      one governed edge. Here's the architecture."
  A2 "Four parts. The brain proposes, and it's untrusted. The spine is the one governed edge every
      action must pass. The body is where effects actually run, a sandbox, or a browser. And a
      separate process, the tamper-proof kernel, signs the record. The brain can't act, the body
      can't govern, and the signer stands on its own."
  A3 "Every part is a vendor, plugged in behind a neutral port. The governance doesn't live in any
      vendor. It lives in the spine and the ledger. Swap any piece by configuration, not a rewrite."
  A4 "Here's what fills each role. Hermes is the brain, it proposes. NemoClaw hosts and launches
      that agent. OpenShell is the execution substrate, the sandbox where a command actually runs.
      Agentic SpendGuard is the cost gate, it reserves the budget before, and settles the real cost
      after. And AGT is an advisory governor, it can only narrow a decision, never grant one."
  A5 "Now the path every action takes. The brain proposes a call. The spine screens it for secrets.
      The policy decision point authorizes it, deny by default, and that's where AGT's advice folds
      in. If it's destructive, it needs approval. SpendGuard reserves the budget. Then the kernel
      commits the record, and waits for the receipt. Only then does OpenShell run the effect.
      SpendGuard settles the real cost, and the boundary crossing is recorded."
  A6 "Watch the order. When it's allowed, the record commits, then the effect runs. When it's
      denied, at policy, at approval, or at budget, the trace just stops. No commit. No effect.
      Nothing happened."
  A7 "And the part that acts is never the part that signs the record. They're separate processes.
      The brain and the body hold no signing key, they can only append. So a compromised agent
      cannot forge its own history, rewrite it, or restore it."
  A8 "That's the shape of Agent OS. One governed core, vendor-neutral, separately attested. Commit
      before effect. Deny by default. To go deeper, read the concepts and the security model. The
      thinker proposes. The OS governs."

5 · MOTION · SOUND · CAPTIONS · CONSTRAINTS — inherit HERO §7–11 and Cut 2 §6–7. Open on the title
  card with a slower (~0.8s) fade-up. The component labels (A4) and flow-stage owners (A5) MUST
  match the code-verified roles in §2 (a wrong arrow loses a technical viewer). Keep the
  attester≠actor honesty (process boundary, not HSM). If the TTS glitches on a word (a "破音" was
  caught on "spine"), regenerate that scene's VO and re-check.

6 · DELIVERABLES & DEFINITION OF DONE
  Deliver: ~2.5 min master 16:9; SRT; editable project. Done when: a newcomer can name each
  component's role and point to where it acts in the pipeline; commit-before-effect is unmistakable;
  nothing on screen is technically wrong or overclaimed; the open doesn't feel abrupt.
=====================================================================
```

---

*These briefs are the production spec; the live demos they film are real (`pnpm run e2e:live-gmail`,
`e2e:live-browser`, `e2e:gmail-deny-demo`, `e2e:deny-demo`). Keep every on-screen trace faithful to the
actual driver output. The synthetic animatic is a timing reference only — the films are shot against these.*
