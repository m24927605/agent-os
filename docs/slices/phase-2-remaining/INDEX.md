# Phase 2 Remaining + Beyond — 未完成工作的主分解索引（DRAFT）

> 2026-06-21。本索引把**所有未完成的工程項目**分解成 ITEM → 小 slice,作為 doc-first 的規劃骨架。
> 每個 ITEM 將有一份**設計文件**(`docs/design/<item>.md`) + 一組**小 slice 文件**(本目錄 `<slice-id>.md`,依
> [`slice-spec.md`](../../standards/slice-spec.md))。方法論見 [`looping-engineering.md`](../../standards/looping-engineering.md):
> doc-first、小 slice、RED 先行、Independent Verifier Pass(獨立 Opus 4.8 reviewer)、5 回合上限 → Staff+ 升級。
> 已完成的 P2-A~I 見 [`../phase-2/INDEX.md`](../phase-2/INDEX.md)。**AGENTS.md 勝出。only command output is truth。**

## 0. 狀態
- **設計文件 + 小 slice 文件**:由 doc-authoring workflow 產出後逐一補連結並標 READY-TO-BUILD。
- 任一 slice 開工前必須:該 ITEM 設計文件 + 該 slice 文件齊備、且通過一次**文件對抗式 review**。

## 1. ITEM 清單、slice 分解、依賴、agent 指派

> writer/reviewer 依 [`looping-engineering.md`](../../standards/looping-engineering.md) §5;reviewer 一律獨立 Opus 4.8。

| ITEM | 設計文件 | 第一刀 slice 群（小） | Depends-on | 預設 writer |
|---|---|---|---|---|
| **R1 live OpenShell substrate adapter** | design/adapter-openshell-substrate.md | connect-node client + pinned proto/image-digest · CreateSandbox · GetSandbox/Watch · ExecSandbox · GetSandboxProviderEnvironment(placeholder) · 對 P2-A SandboxAdapter contract 過測 | P2-A | Backend Architect |
| **R2 TS→Go 真實 ingest client（sync-commit）** | design/ingest-client-sync-commit.md | connect proto AppendService client · canonicalize→redact→Append→await Receipt wrapper · (sourceId,sequence) dedup · 接 commitgate appender(取代 in-memory) · outbox(capped) | P1 kernel, P2-C | Backend Architect |
| **R3 ToolManifest registry + PDP tool:invoke** | design/tool-manifest-registry.md | Zod-strict ToolManifest(9 欄) · registry · PDP `tool:invoke` 規則(未註冊→deny) · sideEffect/idempotent 欄 | P2-E | Minimal Change Engineer |
| **R4 CredentialLease lifecycle** | design/credential-lease.md | `.strict()` CredentialLease(bundleRef-only) · mint→inject→use→revoke→expire FSM · 接 SecretResolver placeholder · raw-secret parse-fail 測試 | P2-A | Security Engineer |
| **R5 Task/AgentSession FSM + resume ledger** | design/task-agentsession-fsm.md | XState Task FSM · AgentSession · resume ledger(append-only) · crash 後 resume 無重複 effect(content-hash dedup) · 接 P2-I pipeline | P2-I | Backend Architect |
| **R6 inference routing gate** | design/inference-routing-gate.md | per-model deny-by-default · egress allowlist(interim) · 接 PDP · 接 CostGate(model→成本) | P2-E, P2-G | Security Engineer |
| **R7 Personal 零技能殼** | design/personal-shell.md | IntentGateway(文字,先) · clarify-or-fail-closed(≤3 問) · 白話 plan preview · ApprovalInbox · TaskTimeline(從 WORM 重建) · docker-compose launcher · 語音(後) | P2-I, R2 | Frontend Developer |
| **R8 Enterprise 多租脊椎** | design/enterprise-multitenant.md | gateway-per-tenant(連線/namespace 邊界) · per-tenant Postgres · per-tenant kernel partition(per-tenant Merkle+key) · operator console · capability-possession maker-checker · **release-blocking 跨租 conformance** | P2-F, R2 | Backend Architect |
| **R9 Developer SDK** | design/developer-sdk.md | Python credential-blind shim(import-linter 禁 secret import) · TS SDK · CLI · ToolManifest authoring · standalone+WASM verifier release artifact | R3 | Backend Architect |
| **R10 時光旅行** | design/time-travel-snapshot-replay.md（已存在,補 slice） | Forensic Replay fold 引擎(P1.5,先) · SnapshotRecord schema · Restore FSM + RestoreEvent(forward-append) · kernel snapshot-safe checkpoint RPC · verifier 認 RestoreEvent · brain memory 版本化 | P2-I, R2 | Backend Architect |
| **R11 真實 vendor adapter（腦/hosting/成本/policy）** | design/vendor-adapters.md | NemoClaw hosting adapter(over P2-H port) · Hermes brain shim(credential-blind,over P2-D port) · SpendGuard cost adapter(over P2-G port) · AGT policy secondary adapter(over P2-E) | P2-D,G,H,E; R1 | Backend Architect |
| **R12 tracked follow-ups** | design/follow-ups.md | CostGate `release(reservationId)`(commit-abort 釋放預留) · AgentHosting 存在性 oracle 消除(caller 面統一 reason、真因只進 audit) | P2-G, P2-H | Minimal Change Engineer |

## 2. ITEM 層 DAG（無 cycle）
```
R1 -> { P2-A }
R2 -> { P1-kernel, P2-C }
R3 -> { P2-E }
R4 -> { P2-A }
R5 -> { P2-I }
R6 -> { P2-E, P2-G }
R7 -> { P2-I, R2 }
R8 -> { P2-F, R2 }
R9 -> { R3 }
R10 -> { P2-I, R2 }
R11 -> { P2-D, P2-G, P2-H, P2-E, R1 }
R12 -> { P2-G, P2-H }
```
> 建議先後:**R2(真實 ingest)與 R1(真實 substrate)** 把骨架接上真實世界(最高 de-risk 價值);R3/R4/R5/R6
> 補治理深度;R7/R8/R9 三 surface 最上層;R10 時光旅行;R11 真實 vendor;R12 收尾。R10 的 Forensic Replay 子 slice
> 零 kernel 改動、可極早做。

## 3. 每個 ITEM 的文件交付清單（doc-first 才開工）
對每個 R*:① 設計文件(grounded 真實 repo) → ② 一組小 slice 文件(slice-spec 範本,size budget 受限) →
③ 文件對抗式 review(完整性、slice 夠小、驗收指令可驗、DAG 無 cycle、無 silent scope)PASS → 才進實作。
實作再走 [`looping-engineering.md`](../../standards/looping-engineering.md) §6 的每-slice 流程。
