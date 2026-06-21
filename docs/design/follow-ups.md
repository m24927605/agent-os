# R12 — Tracked Follow-ups（CostGate `release` + AgentHosting reason 統一）設計文件（DRAFT）

> ITEM **R12** of [`docs/slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md)。
> 方法論：[`docs/standards/looping-engineering.md`](../standards/looping-engineering.md)（doc-first、小 slice、RED 先行、
> Independent Verifier Pass / 獨立 Opus 4.8 reviewer、5 回合 → Staff+ 升級）。slice 範本：
> [`docs/standards/slice-spec.md`](../standards/slice-spec.md) §6 + §10。**AGENTS.md 在任何衝突上勝出。only command output is truth。**
>
> Depends-on（ITEM 層）：**P2-G**（CostGate port，已 DONE）、**P2-H**（AgentHosting port，已 DONE）。見
> [`docs/slices/phase-2/INDEX.md`](../slices/phase-2/INDEX.md)。

## 0. 什麼是「tracked follow-ups」

R12 收尾兩個在 P2-G / P2-H 實作 + Independent Verifier 過程中被**明確記錄、刻意延後**的工程缺口。它們不是新功能，而是把
兩條既有不變量補強到「邊界乾淨、無 side-channel」：

1. **P2-G follow-up（成本）**：CostGate 目前能 `reserve`（hold）與 `commit`（settle），但**沒有 `release(reservationId)`**。
   當一次 commit-before-effect 序列在「reserve 已成功、但 effect 之前被 abort」時，被 hold 的預留**永遠卡住**（`held`
   不歸還），等同於**預算洩漏**：一個不斷 reserve-then-abort 的 agent 會把租戶預算逐步鎖死，hard-cap 被慢性侵蝕。
   → 補 `release(reservationId)`，並把 commitgate 的 abort 路徑接上 release，讓 abort 釋放被 hold 的預留。

2. **P2-H follow-up（hosting）**：`InMemoryAgentHosting.requireOwned` 對 caller **回傳兩種不同的 deny reason**——
   `"unknown sandbox (deny-by-default)"`（不存在）與 `"cross-tenant: sandbox is hosted by another tenant
   (deny-by-default)"`（存在但屬於別租）。這個差異是一個**存在性 oracle（existence/ownership side-channel）**：
   tenant-B 可藉由「reason 是哪一種」探測「某 sandboxId 是否存在於別的租戶」，違反跨租隔離的**機密性**（不只完整性）。
   → caller 面**統一**為單一不可區分的 reason（`"unknown sandbox"`），**真正的跨租真因只進 audit event**（attester
   視角可見、actor / caller 視角不可見），對齊 attester≠actor 的核心 moat。

兩者都 SMALL、低耦合、可被 `pnpm run verify` 的 exit code 證明，且各自能 RED-first。

---

## 1. 動機與真實世界 grounding（verified-from-code）

### 1.1 成本：`release` 是 reserve/commit 狀態機缺的第三條邊（grounded in SpendGuard）

預設真實 adapter SpendGuard 的 ledger 契約**已經把 `Release` 當成一級 RPC**，且預留狀態機含 `RELEASED`：

- `release(reservationId)` 的真實對應 RPC 與其語義：
  `/tmp/agentic-spendguard/proto/spendguard/ledger/v1/ledger.proto:54-55`
  ——註解原文：「**Release held reservation (TTL expired / runtime error / run aborted).**」`rpc Release(ReleaseRequest)
  returns (ReleaseResponse);`。這直接證明「run aborted ⇒ 釋放 held 預留」是 SpendGuard 既有的設計意圖，不是我們發明的。
- 預留狀態機含 `RELEASED`（與 `RESERVED` / `COMMITTED` / `OVERRUN_DEBT` 並列）：
  `/tmp/agentic-spendguard/proto/spendguard/ledger/v1/ledger.proto:125-133`（`enum State { ... RESERVED=1; COMMITTED=2;
  RELEASED=3; OVERRUN_DEBT=4; }`）。
- `Release` 的 request/response message：
  `/tmp/agentic-spendguard/proto/spendguard/ledger/v1/ledger.proto:212`（`message ReleaseRequest`）、`:233`
  （`message ReleaseResponse`）、`:241`（`message ReleaseSuccess`）。
- `OVERRUN_DEBT`（`:130`）對應我們 port 既有的 `commit overrun` 設計（見 `src/cost/port.ts:29-36`、`src/cost/in-memory.ts:78`），
  確認「`commit` 不可事後 deny、超支記為 debt」這條已落地的不變量與 SpendGuard 一致；`release` 補的是**另一條** abort 路徑。

我方 port 現況（缺口確認，verified-from-code）：

- `interface CostGate` 只有 `reserve` / `commit`，**無 `release`**：`src/cost/port.ts:47-50`。
- `InMemoryCostGate` 維護 `held` 與 `reservations: Map<reservationId, estimatedTokens>`：`src/cost/in-memory.ts:22-25`；
  `reserve` 成功時 `this.held += estimatedTokens` 並寫入 `reservations`（`:44-46`）；`commit` 成功時 `reservations.delete`
  + `this.held -= reserved`（`:73-74`）。**但若一次 reserve 後不 commit（abort），`held` 永不歸還** ⇒ 預算洩漏。
- abort 來源（verified-from-code）：`commitBeforeEffect` 在 append 失敗 / timeout 時回 `{status:"aborted"}` 而**不**呼叫
  effect：`src/commitgate/guard.ts:57-74`（`:67-69` 的 catch → `aborted`）。R12-S1 要把這條 abort 路徑與 cost `release` 接起來。

### 1.2 Hosting：caller 面 reason 差異是存在性 oracle（grounded in NemoClaw）

我方 port 現況（缺口確認，verified-from-code）：

- `InMemoryAgentHosting.requireOwned` 對 caller **回兩種可區分 reason**：
  `src/hosting/in-memory.ts:99-111`——unknown sandbox → `"unknown sandbox (deny-by-default)"`（`:101`）；存在但跨租 →
  `"cross-tenant: sandbox is hosted by another tenant (deny-by-default)"`（`:107`）。兩個 reason 同時出現在**回傳給 caller 的
  `reason` 欄位**與 **audit `event.reason`**（`denyEvent` 同時填兩處：`src/hosting/port.ts:73-80`）。
  ⇒ tenant-B 可用「收到哪一種 reason」推斷某 sandboxId 是否被別租持有 → 跨租機密性洩漏。
- 注意 `hostAgent` 的跨租分支同樣明說真因給 caller：`src/hosting/in-memory.ts:39-47`（`:41` reason）。R12-S2 一併處理。
- `NullAgentHosting` 本就對所有情況回單一 `DENY_REASON`（`src/hosting/null.ts:14`），**不洩漏**——R12-S2 是把 InMemory 的
  caller 面對齊到「同樣不可區分」這條已存在於 Null 的安全姿態（DRY：統一姿態，不是新發明）。

NemoClaw 為什麼是這個缺口的 grounding（verified-from-code）：NemoClaw 是 hosting 預設 adapter，其 status 探測**刻意把細緻的
內部 lifecycle 狀態直接攤給 caller**：

- `probeGatewayHealth` 把 `named_unreachable` / `named_unhealthy` / `connected_other` / `missing_named` 等內部狀態映成
  caller 可見 reason：`/tmp/nemoclaw/src/lib/status-command-deps.ts:302-326`（reason 映射表 `:310-313`）。其中 `connected_other`
  甚至**回填 active gateway 名稱**（`:312`：`` `connected to '${lifecycle.activeGateway ?? "unknown"}', not '${expectedGateway}'` ``）——這正是
  single-operator 工具「對自己人透明」的合理設計。
- 但 NemoClaw **明示自己 single-operator、不隔離租戶**（我方 port 註解已記錄此 gap：`src/hosting/port.ts:7-11`）。一旦進
  Enterprise 多租，NemoClaw 那種「把內部狀態原樣回給 caller」的習慣**就是 oracle**。NemoClaw 自己也有「不確定就別亂報」的
  良性先例：`/tmp/nemoclaw/src/lib/status-command-deps.ts:322-324`（「我們也不能在真的判斷不出來時硬說它 unhealthy」），
  R12-S2 把這條謹慎原則**升格為跨租安全不變量**：caller 面對「unknown vs 別租」一律不可區分，真因只進 audit。

> **verified-from-code vs inferred 標註**：以上 SpendGuard `Release` RPC / `RELEASED` 狀態、NemoClaw status reason 攤平、
> 我方 port/adapter 的 `held` 不歸還與雙 reason，皆 **verified-from-code（附 file:line）**。「NemoClaw 在多租下會構成
> oracle」是 **inferred**（NemoClaw 本身單租、無多租概念，是我們把它放進 Enterprise 語境後的推論）。

---

## 2. 架構與設計（what / why）

### 2.1 R12-S1 — CostGate `release(reservationId)` + commit-abort 接線

> **狀態：DONE（slice/p2r-r12-s1-costgate-release-commit-abort）。** port 第三條邊 `release` + Null/InMemory
> 實作 + `runGovernedToolCall` abort 分支接線皆已落地；SpendGuard adapter 的真實 `release_session` RPC 仍 deny-all
> 留給 **R11**（見 §4 capability gate）。

**新增 port 第三條邊**，補完 reserve/commit/release 三態（auth / capture / **void**，對齊 Stripe-style 與 SpendGuard `Release`）：

```
                reserve(ok)            commit(committed|overrun)
   (no hold) ───────────────▶ RESERVED ─────────────────────────▶ SETTLED   held -= reserved
                                  │
                                  │ release(reservationId)   ← 新增（abort/TTL/runtime-error 路徑）
                                  ▼
                               RELEASED   held -= reserved，settled 不動
```

- **`release` 語義**：把一個**仍 RESERVED**的預留歸還——`held -= reserved`、`reservations.delete(reservationId)`、`settled`
  **不變**（沒有真實花費發生）。回 `ReleaseResult`，帶 `phase:"release"` 的 `CostEvent`。
- **冪等 / fail-closed**：`release` 一個**未知或已被 commit/release 的 reservationId** → `denied`（deny-by-default），**不可**把
  `held` 扣成負數、**不可**重複歸還（double-release 攻擊）。壞 ctx → fail-closed denied（與既有 `reserve`/`commit` 一致，
  沿用 `contextOrError` / `denyReserve`-風格 builder：`src/cost/port.ts:57-79`）。
- **commit-abort 接線**：`commitBeforeEffect`（`src/commitgate/guard.ts:57-74`）目前 abort 時**只**回 `{status:"aborted"}`，不通知
  cost。接線的**真實落點是既有 composition 函式** `runGovernedToolCall`（`src/orchestration/pipeline.ts:53-106`）——它**已經**
  reserve→commitBeforeEffect→commit，且 abort 分支 `src/orchestration/pipeline.ts:90-93` 的 inline 註解已**明確記錄此缺口**
  （原文：「the reservation remains held (CostGate has no release op yet — tracked follow-up in the slice spec §8); we do NOT
  cost.commit」）。R12-S1 就是把這條既存 abort 分支接上 `cost.release(reservationId)`（**修改既有函式，非新建 helper**），歸還預留。
  **注意 commitgate 本身 imports NOTHING from other src modules**（`src/commitgate/guard.ts:13` 明示），故**不可**讓 commitgate
  直接 import cost；接線只在 orchestration 層（pipeline.ts，已 import `cost`/`commitgate` 的 barrel：`pipeline.ts:16-17`），維持
  commitgate 的零耦合姿態（見 §3 低耦合）。

> **為何不在 `commit` 內部「自動 release」**：`commit` 與 `release` 是**互斥的兩條終結邊**；把它們耦進同一呼叫會讓 caller
> 無法表達「我 reserve 了但這次根本沒打 provider」。保持兩條獨立邊，符合 SpendGuard ledger 把 `Commit*` 與 `Release` 分開的
> RPC 設計（`ledger.proto:54-65`）。

### 2.2 R12-S2 — AgentHosting caller 面 reason 統一 + 真因只進 audit

> **狀態：DONE（slice/p2r-r12-s2-agenthosting-reason-unification）。** `InMemoryAgentHosting` caller 面
> 對 unknown / cross-tenant 統一回 `UNKNOWN_SANDBOX = "unknown sandbox"`（`hostAgent` + `requireOwned`
> 三路徑），真因只留 audit `event.reason`；存在性 oracle 已消除。no-oracle 不變量已進 contract harness。
> 真實 NemoClaw adapter 套同一不變量留 **R11**；hosting audit event 進 WORM kernel 留 **R2** ingest。

**單一不可區分的 caller-facing reason；真因（unknown vs cross-tenant）只進 audit `event.reason`。**

```
                         caller-facing `reason`          audit `event.reason`
  unknown sandbox    ──▶ "unknown sandbox"        ──▶  "unknown sandbox (deny-by-default)"
  cross-tenant       ──▶ "unknown sandbox"   ◀── 同上不可區分      "cross-tenant: ... (deny-by-default)"
  invalid ctx        ──▶ "invalid agent context (fail-closed)"   "invalid agent context (fail-closed)"
```

- caller（actor 視角）對「sandbox 不存在」與「sandbox 存在但屬別租」**收到完全相同的字串** ⇒ 無法用 reason 區分 → oracle 關閉。
- audit（attester 視角）仍記錄**真因**，讓治理/forensic 能分辨——這正是 attester≠actor 的 WORM 核心：**證據面看得到、行為面看不到**。
- `invalid ctx`（fail-closed）的 reason **不需**統一（它不洩漏任何 sandbox 存在性——壞 ctx 連 tenant 都沒解出來）。
- `hostAgent` 的跨租分支（`src/hosting/in-memory.ts:39-47`）一併統一 caller reason，真因進 audit。

> **為何 audit 仍記真因**：跨租企圖是**高價值 forensic 信號**（可能是租戶配置錯誤或惡意探測）。把它從 caller 拿掉、但在
> WORM 留證，是「最小揭露 + 完整證據」的標準權衡，對齊 looping-engineering 的安全不變量探測面（deny-by-default + audit 完整性）。

---

## 3. 低耦合 / 高內聚 + 重用 vs 新增

### 3.1 重用（既有 port / fake / kernel，不重造）

- **R12-S1** 重用：`CostGate` port 既有的 `CostEvent` / `ReserveResult` 形狀與 `contextOrError` / fail-closed builder
  （`src/cost/port.ts:16-79`）；`InMemoryCostGate` 既有的 `held` / `reservations` 狀態（`src/cost/in-memory.ts:22-25`）；
  `NullCostGate` deny-all 姿態（`src/cost/null.ts`）；contract harness `src/test-contracts/cost-gate-adapter.test.ts`（擴一條
  release 不變量，沿用既有 `ADAPTERS` factory `:20-23`，不新建檔）。abort 觸發點重用既有 `runGovernedToolCall` 的 `aborted` 分支
  （`src/orchestration/pipeline.ts:90-93`，其下游是 `commitBeforeEffect` 的 `aborted`：`src/commitgate/guard.ts:67-74`）。
- **R12-S2** 重用：`AgentHosting` port 的 `denyEvent`（`src/hosting/port.ts:73-80`，audit 仍拿真因）；`InMemoryAgentHosting`
  既有 tenant-scoped 邏輯（`src/hosting/in-memory.ts`）；contract harness `src/test-contracts/agent-hosting-adapter.test.ts`
  （擴一條 no-oracle 不變量）；`NullAgentHosting` 的單一 reason 姿態（`src/hosting/null.ts:14`）作為「正確姿態」的對照。

### 3.2 新增（最小）

- R12-S1：port 增 `release(ctx, reservationId): Promise<ReleaseResult>` + `ReleaseResult` 型別 + `phase:"release"` 進
  `CostEvent.phase` 的 union（`src/cost/port.ts:17`）+ `denyRelease` builder；兩個 in-tree impl 各加 `release`；**修改既有**
  `runGovernedToolCall`（`src/orchestration/pipeline.ts:90-93` abort 分支，經 barrel `:16-17` 已注入 `CostGate`）呼叫 `cost.release`
  （**不**進 commitgate 內部、不新建 helper）。
- R12-S2：改 `InMemoryAgentHosting` 的 caller-facing reason 為常數 `UNKNOWN_SANDBOX = "unknown sandbox"`；audit `event.reason`
  維持真因；不動 port 簽章、不動 Null。

### 3.3 低耦合自證（HARD CONSTRAINT A + no-vendor-in-core）

- `cost` / `hosting` 已在 no-vendor-in-core 的 core from-list（見 P2-G/P2-H DoD：`docs/slices/phase-2/P2-G-…md:28`、§P2-H）。
  兩 slice **不新增任何跨 module / 第三方依賴**：cost impl 只 import `./port.js` + `iam/ids`；hosting impl 只 import `./port.js`。
- **commitgate 零耦合不可破壞**：`src/commitgate/guard.ts:13` 明示「imports NOTHING from other src modules」。R12-S1 的接線
  **以 callback 注入 / 上層 composition** 完成，**禁止** `import { ... } from "../cost/..."` 進 commitgate ⇒ 方向仍向內、無 cycle。
- 依賴方向：`cost/{null,in-memory}.ts → cost/port.ts → iam/ids`；接線 helper 在 application/orchestration 層 →（注入）cost +
  commitgate 的 public surface（barrel）。無反向、無 cycle。`deps:check` 為阻擋性 DoD。

---

## 4. 誠實的 capability gates（哪些是 fake / interim、何時升級）

| 能力 | 本 R12 交付 | 仍是 fake / 缺口（後續 ITEM） |
|---|---|---|
| CostGate `release` | port + 2 in-tree impl（Null / InMemory）+ contract test | 真實 SpendGuard `Release` RPC adapter → **R11**（vendor adapter，over P2-G port）。本 R12 不接真實 ledger / TTL 過期自動 release。 |
| commit-abort 釋放預留 | commitgate `aborted` 分支 →（注入）`release` 的薄組合 helper + 測試 | 把 reserve/commit/release 整條接進真實 inference egress + 餵 WORM kernel → **R6**（inference routing gate）/ ingest（**R2**）。 |
| Hosting reason 統一 | InMemory caller 面統一 + audit 真因 + no-oracle contract 測試 | 真實 NemoClaw adapter 同樣消除 oracle（套同一不變量）→ **R11**；把 hosting audit event 真正 append 進 WORM kernel → **R2** ingest。 |
| 跨租隔離整體 | 本 slice 只補 hosting 機密性 side-channel | 完整 gateway-per-tenant / per-tenant kernel partition → **R8**（Enterprise 多租脊椎）；release-blocking 跨租 conformance 在 R8。 |

> credentials：兩 slice 皆 **credential-blind**（cost 介面只收 token 數值 + resource id，hosting `HostSpec` 無 secret 欄位：
> `src/cost/port.ts:38-45`、`src/hosting/port.ts:31-39`）。測試若需 secret canary 一律 runtime 組裝、不入 fixture（沿用 P2 紀律）。

---

## 5. Slice 分解（SMALL、acyclic）

| Slice | 檔案 | 標題 | 模組 | Net LOC（估） | Depends-on |
|---|---|---|---|---|---|
| **P2R-R12-S1** | [P2R-R12-S1-costgate-release-and-commit-abort-wiring.md](../slices/phase-2-remaining/P2R-R12-S1-costgate-release-and-commit-abort-wiring.md) | CostGate `release(reservationId)` + commit-abort 接線 | cost（+ orchestration `runGovernedToolCall` abort 分支） | ~110（≤180） | P2-G、P2-C |
| **P2R-R12-S2** | [P2R-R12-S2-agenthosting-reason-unification-audit-only-true-reason.md](../slices/phase-2-remaining/P2R-R12-S2-agenthosting-reason-unification-audit-only-true-reason.md) | AgentHosting caller-facing reason 統一 + 真因只進 audit | hosting | ~90 | P2-H |

### Slice DAG（無 cycle）
```
P2R-R12-S1 -> { P2-G, P2-C }     # release 補在既有 CostGate port；abort 觸發點重用 commitgate
P2R-R12-S2 -> { P2-H }           # 只動 InMemoryAgentHosting caller-facing reason；不動 port 簽章
```
> 兩 slice **彼此獨立**（無 S1↔S2 邊），可並行；皆只 depends-on 已 DONE 的 P2-G/P2-C/P2-H ⇒ rank 嚴格遞減、無 cycle。
> 各自 net LOC < ~300、files < ~6、modules ≤ 2，符合 slice-spec §3 硬上限。
