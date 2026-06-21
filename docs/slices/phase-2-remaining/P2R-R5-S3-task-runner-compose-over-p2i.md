# SLICE-P2R-R5-S3: Task runner — compose over P2-I runGovernedToolCall（step→ledger→FSM 推進）

- **Phase**: P2（R5 — Task/AgentSession FSM + resume ledger；組合層）
- **Branch**: slice/p2r-r5-s3-task-runner-compose-over-p2i
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~260、files <~4（`src/orchestration/task/runner.ts` + `runner.test.ts` + `src/orchestration/index.ts` barrel + `src/index.ts` 頂層 barrel 一行）、modules = 1（orchestration）、新增第三方依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R5-S3 — 新增 `runTask(deps, task)`：對 Task 的每個 step 組出 toolCall、呼叫**注入的** P2-I `runGovernedToolCall`、把 `GovernedOutcome` 寫成 `StepRecord` append 進 ResumeLedger、再用 S1 的 `transition` 推進 Task FSM——**compose over P2-I，不改寫 pipeline**。

## (2) Goal（一句話）
第一次讓「一個 Task = 多個 governed step」當一條流跑起來並可驗：每 step 經 P2-I 受治理、結果落 ledger、FSM 正確推進到 completed/failed。

## (3) In-scope / Out-of-scope
- In-scope:
  - `runTask(deps, task)` driver：迴圈 from `task.cursor`，每 step → `deps.runGovernedToolCall(...)` → 依 outcome 組 `StepRecord` → `deps.ledger.append(...)` → `transition(...)`；fail-closed 短路。
  - outcome 映射：P2-I `executed{reservationId,receipt}` → StepRecord(outcome:executed) + FSM `step-executed`；`denied{stage,reason}` → StepRecord(outcome:denied) + FSM `step-denied`（整體 → failed）。
  - **append-before-advance 不變量**：StepRecord 必須**先 append 成功**才推進 cursor（鏡射 P2-I commit-before-effect 時序，為 S4 的 crash-resume 鋪路）。
  - happy path（多步全 executed → completed）+ 短路（某步 denied → failed、後續步不跑）。
- Out-of-scope（明確不做）:
  - crash 模擬 / fold(ledger) 的 resume 入口 → 留給 SLICE-P2R-R5-S4。
  - 真實 vendor adapter（P2-I 已用 fake 接線；本 slice 沿用注入）→ R1/R11。
  - approval 暫停態 → R7。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 純組合層；不重寫 `pipeline.ts`、不重寫 FSM/ledger。低耦合靠**依賴注入**（同 P2-I 模式）：runner 只 import 有 barrel 的 orchestration 型別（`GovernedOutcome` from `../index.js`）+ S1 FSM/schema + S2 ledger 型別；`runGovernedToolCall`、`ledger`、`clock`（時戳）、`buildToolCall`（step→toolCall 的對映）皆**注入**，由 composition root（測試）接 P2-I 真實 fake。
- **Modules touched（每個一句唯一責任）**:
  - `src/orchestration/task/runner.ts` — 唯一責任：把 Task 的每個 step 依序送過注入的 P2-I 管線、落 ledger、推進 FSM（純編排，無治理決策、無 effect、無 I/O）。
- **PUBLIC interface（新增）**:
  - `interface RunTaskDeps<TC, R> { runGovernedToolCall: (tc: TC) => Promise<GovernedOutcome<R>>; ledger: ResumeLedger; buildToolCall: (task: Task, stepIndex: number) => TC; now: () => string; }`
  - `function runTask<TC, R>(deps: RunTaskDeps<TC, R>, task: Task): Promise<{ task: Task; records: readonly StepRecord[] }>`（回終態 Task + 本次 append 的 StepRecord）。
- **順序 + 短路（fail-closed）**: ① 從 cursor 起逐 step；② `runGovernedToolCall` 回 `denied` → append denied StepRecord → FSM `step-denied` → **Task failed、break**（後續 step 不跑）；③ 回 `executed` → **先 append executed StepRecord（成功才續）** → FSM `step-executed`、cursor+1；④ append 失敗 → fail-closed（Task failed，不推進、不續跑——避免「effect 已發生但無記錄」誤推進）；⑤ 所有 step executed → completed。
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    orchestration/task/runner ──▶ orchestration (GovernedOutcome, barrel ../index.js)
                              ──▶ orchestration/task/fsm (transition, S1)
                              ──▶ orchestration/task/session (Task/StepRecord, S1)
                              ──▶ orchestration/task/ledger (ResumeLedger, S2)
    ```
  - 僅經 public surface 消費（無 deep import）: 是（`GovernedOutcome` 經 `../index.js` barrel；不 deep-import `pipeline.ts` 以外內部；不 import 任何 vendor）。
  - 新依賴宣告: **無新第三方**；`runGovernedToolCall` 以**注入函式**提供（不靜態 import 具體 deps，避免把 P2-I 的 brain/cost/commitgate 依賴拉進 runner）。方向 inward、無 cycle（orchestration 不被 task 反向依賴）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/orchestration/task/runner.test.ts`（用 P2-I 真實既有 fake + S2 `InMemoryResumeLedger` 接線）
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] **happy path（多步）**：3 step 全 executed → Task=completed、ledger 有 3 筆 executed、effect spy 被呼叫 3 次（每步恰 1 次）。
  - [ ] **短路（denied）**：第 2 步 PDP deny → Task=failed、ledger 末筆 outcome=denied、**第 3 步的 effect spy 0 次**（短路後不跑）。
  - [ ] **append-before-advance 不變量**：注入一個「append reject」的 ledger（模擬第 2 步落帳失敗）→ Task=failed、cursor 不前進、第 3 步不跑（fail-closed）。
  - [ ] **不改寫 P2-I**：斷言 runner 對每個 executed step 恰呼叫 `runGovernedToolCall` 一次、effect 經由 P2-I 而非 runner 直接觸發（runner 無 effect 公共面）。
  - [ ] **stage 透傳**：denied StepRecord 帶 P2-I 的 `stage`（screen/policy/cost/commit）reason，供 timeline 重建。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/orchestration/task/runner.test.ts
  ... FAIL (cannot import ./runner.js — not implemented) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... verify:go: ok ... verify:py: skip ... secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；runner 只經 orchestration/task + orchestration barrel、無 vendor、無 cycle）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (69 modules, 148 dependencies cruised)
  exit code: 0
  ```
- [x] runner 行為測試全綠（`pnpm test src/orchestration/task/runner.test.ts`）
  ```
  $ pnpm test src/orchestration/task/runner.test.ts
  Test Files  1 passed (1)
       Tests  6 passed (6)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（runner 無治理決策、無 effect、無 I/O；`runGovernedToolCall`/ledger/clock 皆注入）
- [x] secret-scan 乾淨（測試 secret canary runtime 組裝）— `secret-scan: clean`（含於 verify）
- [x] Docs 更新（design §5 已連結；§2.2 compose-over-P2-I 描述與本 slice 一致）
- [x] Adversarial code review = PASS（fresh-context；mutation：append-before-advance 改成 advance-before-append / denied 後不 break → 被 §5 測試抓到）— 連結/摘要: independent review PASS（slice R5-S3）
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（短路 0 次後續 effect、append-before-advance fail-closed）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 runner.ts + barrel 行）。
- 可逆性: 安全可逆（純編排層；本 slice 不持久化真實 effect——effect 仍由 P2-I 在 fake 上跑）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R5-S1（FSM/schema）、SLICE-P2R-R5-S2（ResumeLedger）、P2-I（DONE；`runGovernedToolCall`/`GovernedOutcome`）。
- Blocks: SLICE-P2R-R5-S4（crash-resume 在 runner 上加 fold + idempotency）；下游 R7 TaskTimeline / R10 Forensic Replay。
- 確認 slice DAG 無 cycle: 是（rank 3；依賴 rank≤2 的 S1/S2 與已 DONE 的 P2-I）。
