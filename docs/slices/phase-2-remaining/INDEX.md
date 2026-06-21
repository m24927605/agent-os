# Phase 2 Remaining + Beyond — 未完成工作的主分解索引（DRAFT）

> 2026-06-21。本索引把**所有未完成的工程項目**分解成 ITEM → 小 slice,作為 doc-first 的規劃骨架。
> 每個 ITEM 將有一份**設計文件**(`docs/design/<item>.md`) + 一組**小 slice 文件**(本目錄 `<slice-id>.md`,依
> [`slice-spec.md`](../../standards/slice-spec.md))。方法論見 [`looping-engineering.md`](../../standards/looping-engineering.md):
> doc-first、小 slice、RED 先行、Independent Verifier Pass(獨立 Opus 4.8 reviewer)、5 回合上限 → Staff+ 升級。
> 已完成的 P2-A~I 見 [`../phase-2/INDEX.md`](../phase-2/INDEX.md)。**AGENTS.md 勝出。only command output is truth。**

## 0. 狀態（2026-06-21 更新）
- ✅ **R1（live OpenShell substrate adapter）完成**:S1–S6 全 merge 入 main(`src/runtime/openshell/`)。每刀 doc-first +
  RED-first + Backend Architect/Opus4.8 writer + 獨立 Opus4.8 reviewer(S3 跑 2 回合);整合層 fresh-context 對抗式
  Tier-2 驗證(Reality Checker)= PASS——獨立重跑 `pnpm run verify` exit 0(**261 tests + 1 env-gated skip**)、6 個
  per-slice fail-closed 不變量 mutation 皆非 vacuous、connect-node+proto stub **命令實證封閉**於 `src/runtime/openshell/`
  (往 core 注入 → depcruise exit 2)、credential-blind、grounded 真實 proto(無 Start/Stop → noop shim 誠實)。
  **誠實邊界(spec 劃定、已揭露,非假綠)**:目前 production transport **僅 `Health` RPC 綁到真 gRPC descriptor**;
  lifecycle/readiness/exec/provider-env 的邏輯+fail-closed 已對**注入 transport double** 完整測試並過 P2-A contract,
  但真實 RPC round-trip 綁定延到 R7/R8 組合期;`PINNED_SANDBOX_IMAGE` 仍為 shape-enforced 的 placeholder digest。
- ✅ **R2（TS→Go 真實 ingest）完成**:S1–S7 全 merge 入 main。每刀 doc-first + RED-first + agency-agents writer
  (Backend Architect/Opus4.8) + 獨立 Opus4.8 reviewer;另跑一道**整合層 fresh-context 對抗式 Tier-2 驗證**(Reality
  Checker)= PASS——獨立重跑 `pnpm run verify`+`depcruise` 皆 exit 0(171 tests),5 個 per-slice 不變量 mutation 皆
  非 vacuous,無弱化測試,grpc dep 命令強制封閉於 `src/runtime/ingest/`、fail-closed,S7 commit-before-effect 仍守住。
  下一個 de-risk 目標:**R1 live OpenShell substrate adapter**。

- **全部 12 個 ITEM 的設計文件 + 58 個小 slice 文件已撰寫並通過文件對抗式 review**（每 ITEM verdict =
  FIXED-THEN-PASS：reviewer 抓到並修掉 barrel 違規、slice 切太大、捏造/過時引用後才放行；無 blocking 殘留）。
  設計文件在 `docs/design/`;slice 文件在本目錄 `P2R-R<n>-S<m>-*.md`(58 份,各含 RED plan + 指令可驗 DoD +
  獨立 Opus 4.8 reviewer)。
- **READY-TO-BUILD**:任一 slice 現可開工——開工時走 [`looping-engineering.md`](../../standards/looping-engineering.md)
  §6 每-slice 流程(RED→實作→verify→Independent Verifier Pass 5 回合→Staff+ 升級→`--no-ff` merge)。
- 文件 review 抓到的**系統性風險(實作時注意)**:跨 module 只能走 `src/<module>/index.ts` barrel(多個 slice 曾誤踩
  不存在的 barrel / 深 import);R12-S2 會**依 migration 指示改動既有跨租測試(非弱化)**;R2/R4/R5 少數 slice 貼近
  size 上限,實作時若超界即再拆。

## 1. ITEM 清單、slice 分解、依賴、agent 指派

> writer/reviewer 依 [`looping-engineering.md`](../../standards/looping-engineering.md) §5;reviewer 一律獨立 Opus 4.8。

| ITEM | 設計文件 | 第一刀 slice 群（小） | Depends-on | 預設 writer |
|---|---|---|---|---|
| **R1 live OpenShell substrate adapter** | design/adapter-openshell-substrate.md | connect-node client + pinned proto/image-digest · CreateSandbox · GetSandbox/Watch · ExecSandbox · GetSandboxProviderEnvironment(placeholder) · 對 P2-A SandboxAdapter contract 過測 | P2-A | Backend Architect |
| **R2 TS→Go 真實 ingest client（sync-commit）** | design/ingest-client-sync-commit.md | connect proto AppendService client · canonicalize→redact→Append→await Receipt wrapper · (sourceId,sequence) dedup · 接 commitgate appender(取代 in-memory) · outbox(capped) | P1 kernel, P2-C | Backend Architect |
| **R3 ToolManifest registry + PDP tool:invoke** | design/tool-manifest-registry.md | Zod-strict ToolManifest(9 欄) · registry · PDP `tool:invoke` 規則(未註冊→deny) · sideEffect/idempotent 欄 | P2-E | Minimal Change Engineer |
| **R4 CredentialLease lifecycle** | design/credential-lease.md | `.strict()` CredentialLease(bundleRef-only) · mint→inject→use→revoke→expire FSM · 接 SecretResolver placeholder · raw-secret parse-fail 測試 | P2-A | Security Engineer |
| **R5 Task/AgentSession FSM + resume ledger** | design/task-agentsession-fsm.md | XState Task FSM · AgentSession · resume ledger(append-only) · crash 後 resume 無重複 effect(content-hash dedup) · 接 P2-I pipeline | P2-I | Backend Architect |
| **R6 inference routing gate** | design/inference-routing-gate.md | per-model deny-by-default ✅S1 DONE · egress allowlist ✅S2 · PDP ✅S3 · CostGate(model→成本) reserve hook + 四關 any-deny-wins ✅S4 DONE | P2-E, P2-G | Security Engineer |
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
