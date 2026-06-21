# SLICE-P2R-R5-S1: Task FSM（純函式轉移 + guard）+ AgentSession/Task/StepRecord schema

- **Phase**: P2（R5 — Task/AgentSession FSM + resume ledger；compose over P2-I）
- **Branch**: slice/p2r-r5-s1-task-agentsession-fsm-types
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~220、files <~5（`src/orchestration/task/{fsm.ts,session.ts}` + `*.test.ts` ×2 + `src/orchestration/index.ts` barrel 一行）、modules = 1（orchestration）、新增第三方依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R5-S1 — 新增 Task 狀態機（`pending|running|completed|failed|aborted` 的**純函式**轉移 + 顯式 guard，deny-by-default）與 `AgentSession` / `Task` / `StepRecord` 的 zod `.strict()` schema，作為 R5 的型別化契約基底（契約先於消費者）。

## (2) Goal（一句話）
交出 R5 的**契約基底**：一個零依賴、deny-by-default 的 Task FSM 純函式與 `.strict()` schema，讓後續 ledger/runner slice 可消費。

## (3) In-scope / Out-of-scope
- In-scope:
  - `Task` schema：`taskId`、`status`、有序 `steps`（step intent 的最小形狀）、`cursor`。
  - `AgentSession` schema：`sessionId` + 既有 ids（`actorId/tenantId/projectId`）+ `startedAt`（對映 `src/audit/event.ts:32-45`）。
  - `StepRecord` schema：`stepKey`(string)、`stepIndex`、`outcome`(`executed|denied` 對映 P2-I `GovernedOutcome`)、`recordedAt`。
  - `transition(task, event)` 純函式：合法轉移 → 新 Task；非法/未知 event → **deny（回 `{ ok:false, reason }`，不 throw、不靜默推進）**。
- Out-of-scope（明確不做）:
  - ResumeLedger port / fake → 留給 SLICE-P2R-R5-S2。
  - 接 P2-I `runGovernedToolCall` 的 runner → 留給 SLICE-P2R-R5-S3。
  - content-hash `stepKey` 的**計算**（本 slice 只把它當 string 欄位）→ 留給 SLICE-P2R-R5-S2。
  - `paused-awaiting-approval` 狀態（人類在環）→ 留給 R7 ApprovalInbox slice。
  - XState 或任何新第三方依賴（依 slice-spec §3，若需要則另開獨立依賴 slice）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 新增一個 `orchestration/task/` 子區的純 domain 層：狀態機 + schema。**不改 `pipeline.ts`**。FSM 是純函式（無 I/O、無時間、無隨機），時間由呼叫端注入字串時戳，確保可測試決定性。
- **Modules touched（每個一句唯一責任）**:
  - `src/orchestration/task/fsm.ts` — 唯一責任：Task 狀態的合法轉移與 deny-by-default guard（純函式）。
  - `src/orchestration/task/session.ts` — 唯一責任：定義 `AgentSession`/`Task`/`StepRecord` 的 zod `.strict()` schema 與型別。
- **PUBLIC interface（新增）**:
  - `AgentSession`, `Task`, `StepRecord`（zod `.strict()` schemas + inferred types）。
  - `type TaskStatus = "pending" | "running" | "completed" | "failed" | "aborted"`。
  - `type TaskEvent = { kind: "start" } | { kind: "step-executed"; record: StepRecord } | { kind: "step-denied"; record: StepRecord; reason: string } | { kind: "abort"; reason: string }`。
  - `transition(task: Task, event: TaskEvent): { ok: true; task: Task } | { ok: false; reason: string }`。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    orchestration/task (domain) ──▶ iam/ids（branded ids；import path = ../../iam/ids.js）
                                ──▶ zod（既有第三方）
    ```
  - 僅經 public surface 消費（無 deep import）: 是。**注意（verified-from-code）**：repo 目前**沒有** `src/iam/index.ts`
    barrel；`.dependency-cruiser.cjs:44` 的 `not-to-internal` 規則對 `src/iam/ids.ts` 設有 **interim 允許名單**
    （pre-barrel entry），故 `../../iam/ids.js` 直 import 是**目前唯一合法**且 deps:check 綠的路徑（不 deep-import
    audit internals）。**不得**寫成 `../../iam/index.js`（該檔不存在，typecheck/deps:check 會紅）。
  - 新依賴宣告: **無新第三方**；module-to-module 新增 = `orchestration/task → iam/ids`（方向 inward、無 cycle：iam 不 import orchestration、理由=共用 branded id 型別，不另造身份）。
    > **DoD 連動**：若 barrel-migration slice 已先 merge（新增 `src/iam/index.ts` 並移除 cruiser 的 ids 例外），則改 import `../../iam/index.js`；以 merge 當下的 repo 實況為準（only command output is truth）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/orchestration/task/fsm.test.ts`、`src/orchestration/task/session.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] `transition(pending, {start})` → running。
  - [ ] `transition(running, {step-executed})` → 仍 running，cursor+1。
  - [ ] 最後一步 executed 後（cursor 到末端）→ completed。
  - [ ] `transition(running, {step-denied})` → failed（deny-by-default：一步被治理拒絕即整體失敗，不靜默跳過）。
  - [ ] `transition(running, {abort})` → aborted。
  - [ ] **deny-by-default 對抗式**：`transition(completed, {start})`、未知 `event.kind`、cursor 越界 → 回 `{ok:false, reason}`（**不 throw、不靜默轉移**）。
  - [ ] **schema 對抗式**：`Task`/`StepRecord` 多餘欄位 → `.strict()` parse 失敗（exit≠0）；缺 `stepKey`/非法 `status` → 失敗。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/orchestration/task/fsm.test.ts src/orchestration/task/session.test.ts
  ... FAIL (cannot import ./fsm.js / ./session.js — not implemented) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；TDD Red→Green→Refactor 依 §5 計畫執行，impl 前 fsm/session 測試見其失敗）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  > typecheck (tsc --noEmit) → ok
  > lint (biome check src) → Checked 96 files, No fixes applied
  > build (tsc -p tsconfig.build.json) → ok
  > test (vitest run) → Test Files 39 passed | 1 skipped (40); Tests 386 passed | 1 skipped (387)
      ✓ src/orchestration/task/fsm.test.ts (11 tests)
      ✓ src/orchestration/task/session.test.ts (13 tests)
  > deps:check (depcruise) → ✔ no dependency violations found (65 modules, 136 dependencies cruised)
  > proto:check → ok ; openshell:proto:check → ok
  > verify:go → ok ; verify:py → skip (no Python plane)
  > secret-scan → clean
  VERIFY_EXIT=0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；orchestration/task 只 import iam/ids + zod、無 vendor、無 cycle）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (65 modules, 136 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（FSM 純函式無 I/O；schema 與轉移分檔 fsm.ts/session.ts；經 barrel 暴露；無 deep import）
- [x] secret-scan 乾淨（無 secret-like 值；schema/test 無字面憑證）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  ```
- [x] Docs 更新（design/task-agentsession-fsm.md §5 表已連結本 slice — 見該檔 line 165）
- [x] Adversarial code review = PASS（fresh-context、非作者、獨立 Opus 4.8；deny-by-default guard 經 mutation 驗證——非法轉移/未知 event/cursor 越界須回 `{ok:false}` 而非靜默推進）
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（deny-by-default guard、`.strict()` schema fail-closed）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `orchestration/task/` 兩檔 + barrel 一行）。
- 可逆性: 安全可逆（純新增 domain 型別 + 純函式，無外部副作用、無資料遷移、無 audit append）。

## (8) Depends-on / blocks
- Depends-on: P2-I（DONE；提供 `GovernedOutcome` 形狀供 `StepRecord.outcome` 對映）、既有 `iam/ids`、`audit/event`（型別參照）。
- Blocks: SLICE-P2R-R5-S2（ledger 以 StepRecord 為單位）、SLICE-P2R-R5-S3（runner 用 FSM 推進）。
- 確認 slice DAG 無 cycle: 是（rank 1；只依賴已 DONE 的 P2-I 與既有模組）。
