# Agent OS

> A computer that operates itself by intent — governed while it does.

![TypeScript](https://img.shields.io/badge/core-TypeScript-3178c6)
![Go](https://img.shields.io/badge/evidence%20kernel-Go-00add8)
![Python](https://img.shields.io/badge/agent%20shim-Python-3776ab)
![verify](https://img.shields.io/badge/gate-pnpm%20run%20verify%20(14--leg)-2ea44f)
![evidence](https://img.shields.io/badge/evidence-attester%E2%89%A0actor%20WORM-6f42c1)

Agent OS turns plain-language intent into real actions on a real computer, with a fail-closed safety
layer that makes it safe to leave an autonomous agent running. A swappable brain proposes the work;
`agent-os` (the spine) governs and records every action through one ordered pipeline; a real sandbox
(the body) runs it. One core, three surfaces: Personal, Enterprise, Developer.

The autonomous loop is live end to end (infra-gated); what's left is deployment, not code — see
[Status](#status).

## Watch

**Introduction & demo** (~3 min) — what it is, then the governed pipeline in action: a real action allowed, the same one refused, and the evidence. ([download](./docs/videos/agent-os-intro-and-demo.mp4))

https://github.com/user-attachments/assets/384b5241-0932-42a3-a6d3-538aaf8a54cd

**Architecture & flow** (~2.5 min) — the parts, the components, and the path every action takes. ([download](./docs/videos/agent-os-architecture-and-flow.mp4))

https://github.com/user-attachments/assets/1451830c-9b2e-47a1-b959-584fd67c6169

## Quick start

```bash
# Node >= 22 · pnpm 9.15.4
pnpm install

pnpm run verify            # the 14-leg gate — the only accepted proof of "works"
pnpm test                  # the TypeScript unit + contract suite (~1808 cases)

pnpm run example:personal  # run the self-operating computer end to end (in-memory defaults)
```

Verify an evidence chain the way an auditor would, with only the chain bytes and the signer's public key:

```bash
pnpm run verifier:release  # build the standalone + WASM verifier (with SHA-256SUMS)
# <verifier> --chain <chain.json> --pubkey <key>   →  exit 0 = intact, 1 = broken
```

The opt-in, infra-gated live integration wires are listed in the [Developer Quickstart](./docs/sdk/developer-quickstart.md).

## Features

- **Deny by default** — unknown, malformed, or errored requests are refused; the brain only proposes, it never grants.
- **Commit before effect** — the tamper-evident record is sealed before an action runs; if the record fails, the effect never happens. No undo by design.
- **Credential-blind** — the brain only ever holds a placeholder; the real secret is resolved at the network egress, never in the agent or any log.
- **Attester ≠ actor** — a separate Go process signs an append-only, hash-chained (Ed25519) evidence chain. You verify it yourself with a released, checksum-pinned verifier, without trusting the operator.
- **No vendor in the core** — vendors plug into neutral ports; the build fails if a vendor name leaks into core code (`dependency-cruiser`, Go `depguard`, Python `import-linter`).

## Architecture

```
            you (intent)                          you / auditor (verify)
                 │                                          ▲
                 ▼                                          │  spawn the released,
        ┌─────────────────┐  proposes   ┌──────────────────┴───────────┐  process-isolated
        │ BRAIN  (Hermes, │ ──────────► │ SPINE — agent-os              │  verifier (offline)
        │ swappable)      │ tool calls  │ runGovernedToolCall:          │
        └─────────────────┘             │  screen ▸ authorize ▸ approval│
                                        │  ▸ cost ▸ commit ▸ effect     │
        ┌─────────────────┐  effects    │                               │
        │ BODY — OpenShell│ ◄────────── │                               │
        │ (real sandbox)  │             └───────────────┬───────────────┘
        └─────────────────┘                             │ append (await receipt)
                                                        ▼
                                        ┌───────────────────────────────┐
                                        │ WORM evidence kernel (Go,      │
                                        │ separate process, Ed25519,     │
                                        │ hash-chained, per-tenant)      │
                                        └───────────────────────────────┘
        SEATBELT — the fail-closed safety wrapper around all of it (the four invariants above).
```

A brain-proposed tool call becomes a real effect only after one ordered, fail-closed pipeline
(`src/orchestration/pipeline.ts`): screen (credential-blind), authorize (deny-by-default policy),
approval (when a tool requires it), cost.reserve, commit-before-effect (append the record and await
the receipt), effect, then cost.commit. Collaborators are injected as vendor-neutral ports, so the
core names no vendor. Full mental model: [Agent OS in 5 minutes](./docs/concepts.md).

## Surfaces

All three are runnable composition roots over the same spine and share one registry-backed,
deny-by-default authorize contract.

| Surface | What you get |
|---|---|
| **Personal** | Type intent, the brain clarifies, you get a plain-language plan, you approve, the governed pipeline runs it, and a timeline reads the evidence back. |
| **Enterprise** | A gateway-per-tenant fleet with per-tenant log / budget / approval (cross-tenant read/write/approve is structurally impossible), operator maker-checker, and runtime tenant on/offboarding. |
| **Developer** | Author a tool, run it through the same pipeline, replay the evidence as a deterministic fold, and verify the chain yourself with a separately-released binary. |

## Integrations

Agent OS is a layer above existing vendors (no forks): they plug into neutral ports. Turning the
optional ones on is config-driven — see [Configuration](./docs/configuration.md).

| Integration | Role | Status |
|---|---|---|
| **OpenShell** (NVIDIA) | Body — the real-computer sandbox | Live, infra-gated |
| **Hermes** ([Nous Research](https://hermes-agent.nousresearch.com/)) | Brain — proposes the work (default) | Live — desktop ACP, incl. the multi-turn closed loop; propose-only, credential-blind |
| **NemoClaw** (NVIDIA) | Hosting — launches and reconciles the brain in the sandbox | Live, infra-gated (single-operator; tenant isolation is what Enterprise adds) |
| **[agentic-spendguard](https://github.com/m24927605/agentic-spendguard)** | Cost gate — reserve-before-effect budget hard-cap | Live, infra-gated (UDS gRPC to an external sidecar) |
| **Microsoft AGT** | Advisory policy | In-repo adapter, advisory-only — the deny-by-default PDP stays the sole grant authority |

## Documentation

Start with the one that fits you:

- **Adopt** — [Adopting Agent OS](./docs/adoption.md): which path fits you — turnkey, connect an existing agent (MCP), or embed as a library.
- **Everyone** — [Agent OS in 5 Minutes](./docs/concepts.md): the mental model (brain / body / spine, the four invariants, the one governed edge).
- **Individual** — [Personal Quickstart](./docs/personal-quickstart.md): run the self-operating computer and watch a governed intent flow end to end.
- **Developer** — [Developer Quickstart](./docs/sdk/developer-quickstart.md), then [Composition Root Guide](./docs/sdk/composition-root-guide.md), [Build a Tool Family](./docs/sdk/build-a-tool-family.md), [Tool Manifest Authoring](./docs/sdk/tool-manifest-authoring.md), [Verifier Release](./docs/sdk/verifier-release.md).
- **Enterprise** — [Security, Trust & Compliance Whitepaper](./docs/security-model.md), then [Deployment Checklist](./docs/enterprise-deployment.md), [Operator Runbook](./docs/enterprise-operator-runbook.md), [Auditor Guide](./docs/auditor-guide.md).
- **Reference** — [Environment & Configuration](./docs/configuration.md): every `AGENTOS_*` switch and `agent-os.config.json`.
- **Video** — [Production Briefs](./docs/demo-video-briefs.md) ([繁中](./docs/demo-video-briefs.zh-TW.md)) and the built cuts in [`docs/videos/`](./docs/videos/).

Also: [`AGENTS.md`](./AGENTS.md) (the operating contract) and the per-slice build records in [`docs/slices/`](./docs/slices/).

## Status

- **Built and verified.** All three surfaces, the spine, the vendor-neutral ports, the evidence kernel and its offline verifier, and the no-vendor and cross-tenant gates pass `pnpm run verify`.
- **Autonomous loop live (infra-gated).** A real Hermes Desktop discovers and calls Agent OS's governed tools, including `exec.run`, over a real OpenShell sandbox; every call routes through the single governed edge and lands in the shared, independently-verifiable WORM chain. Reproducing the live wires needs your own infrastructure.
- **In-memory by default.** Composition roots default to in-memory log / cost / sandbox; live adapters are injected when you point at real infrastructure.
- **What remains is deployment, not code.** An operator-unforgeable trust root (KMS / HSM), zero-credential sandbox provisioning, CI/CD, an observability backend, and real multi-tenant provisioning. Tracked in [`docs/slices/`](./docs/slices/).

## Contributing

Built with Looping Engineering: doc-first, then a failing test seen to fail, then `pnpm run verify`
green, then an independent fresh-context adversarial review, then merge. Only command output counts as
proof, and a pre-commit guard runs the full gate (never bypassed). See [`CONTRIBUTING.md`](./CONTRIBUTING.md)
and the binding [`AGENTS.md`](./AGENTS.md).

## License

[MIT](./LICENSE) © 2026 m24927605.
