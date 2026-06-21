# SLICE-P2R-R5-S4: crash-resume idempotency — fold(ledger) skip 已完成 step，effect 零重複

- **Phase**: P2（R5 — Task/AgentSession FSM + resume ledger；安全不變量核心）
- **Branch**: slice/p2r-r5-s4-crash-resume-idempotency
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~180、files <~3（`src/orchestration/task/runner.ts` 加 resume 入口 + `resume.test.ts` + design doc 連結）、modules = 1（orchestration）、新增第三方依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R5-S4 — 在 runner 加 `resumeTask(deps, task)`（或 `runTask` 內建 fold 入口）：重啟時先 fold 該 Task 的 ResumeLedger，對已有 `executed` 記錄的 step **跳過、不再呼叫 `runGovernedToolCall`、不再跑 effect**，只對未完成 step 續跑——以對抗式測試證明 crash 後 **external effect 零重複**。

## (2) Goal（一句話）
證明 crash 後 resume 的**冪等性**：已完成的 step 在重啟後不重跑、effect 呼叫次數不增加（no duplicate external effect）。

## (3) In-scope / Out-of-scope
- In-scope:
  - `resumeTask(deps, task)`：fold `deps.ledger.list(task.taskId)` → 重建 cursor 到第一個「ledger 無 executed 記錄」的 step → 從該 step 續跑 `runTask` 邏輯。
  - **stepKey 比對 dedup**：對每個 step 用 `computeStepKey`（S2）算 key，`ledger.has(stepKey)` 為真 → 視為 done、不呼叫 `runGovernedToolCall`、推進 cursor。
  - **deny-by-default / fail-closed**：ledger 讀取失敗 / 記錄損毀 / stepKey 與 ledger 記錄不一致 → Task→failed，**絕不**「不確定就重跑」。
  - 對抗式 crash 模擬：模擬 process 邊界（effect 已跑、StepRecord 已 append → 重建 fresh runner + 同一 ledger → resume）。
- Out-of-scope（明確不做）:
  - 真實 OS-level crash / kill -9 整合測試 → Tier 3 assurance（有部署目標後 `/schedule`）。
  - WORM 與 ledger 的 reconcile（窄窗：effect 已跑、StepRecord 未 append）→ 留給 R2-backed ledger 之後的 slice；本 slice 在 fake ledger 上以「append 成功 = step done」的單一真相證明冪等。
  - 時光旅行 Forensic Replay fold 引擎 → R10。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 在 S3 runner 上加一個 resume 入口；核心是「**fold-before-run**」——跑任何 step 前先查 ledger，已 executed 的 step 結構性地不可能再觸發 `runGovernedToolCall`（唯一 effect 路徑）。不改 P2-I、不改 ledger 內部、不改 FSM 轉移語意。
- **Modules touched（每個一句唯一責任）**:
  - `src/orchestration/task/runner.ts` — 唯一責任（延伸）：新增 resume 入口，依 ledger fold 決定每 step 跑或跳（跳=不呼叫 P2-I）。
- **PUBLIC interface（新增）**:
  - `function resumeTask<TC, R>(deps: RunTaskDeps<TC, R>, task: Task): Promise<{ task: Task; records: readonly StepRecord[]; skipped: readonly string[] }>`（回終態 + 本次新 append + 被跳過的 stepKey 清單，供驗證/timeline）。
- **冪等規則（fail-closed）**: 對每個 step i：`key=computeStepKey({taskId,stepIndex:i,intent})`；`await ledger.has(key)` → true 則 skip（不呼叫 `runGovernedToolCall`、cursor 前進、記入 `skipped`）；false 則照 S3 的 `runTask` 路徑（含 append-before-advance）。任一 ledger 操作 throw → fail-closed（Task failed，不重跑剩餘 step）。
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖（向內、無 cycle）: 同 S3（runner → orchestration barrel / fsm / session / ledger / stepkey）；無新增跨 module 邊。
  - 僅經 public surface 消費（無 deep import）: 是。
  - 新依賴宣告: **無**（純複用 S2 `computeStepKey`/`ResumeLedger.has` 與 S3 runner 路徑）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/orchestration/task/resume.test.ts`（用 P2-I 真實 fake + `InMemoryResumeLedger`，effect 以**呼叫次數 spy** 觀測）
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] **核心冪等**：3-step Task，第 1 步先跑（ledger 有 1 筆 executed、effect spy=1）→ 模擬 crash → **fresh runner + 同一 ledger** `resumeTask` → 完成第 2、3 步；**effect spy 對第 1 步維持 1 次（不重跑）**、總 effect 次數=3（非 4）。
  - [ ] **全完成後 resume 為 no-op**：3 步全 executed 的 ledger → `resumeTask` → effect spy **0 次新增**、Task=completed、`skipped`=3。
  - [ ] **決定性 stepKey 對抗式**：resume 時對同一 intent 算出與原跑相同的 stepKey（否則會誤判為新 step 而重跑）→ 斷言 `skipped` 命中。
  - [ ] **fail-closed**：注入「`ledger.has` reject / list 回損毀記錄」→ Task=failed、**不重跑任何 step 的 effect**（effect spy 不增加）。
  - [ ] **denied step 不被當 done**：ledger 有一筆 outcome=denied 的 step → resume **不** skip 它的後續（denied 已使 Task failed；resume 不把 failed Task 當可續）；驗證不誤判 denied 為 executed。
  - [ ] **double-resume 安全**：對同一已完成 ledger 連跑兩次 `resumeTask` → effect spy 始終 0 次新增（重入冪等）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/orchestration/task/resume.test.ts
  ... FAIL (resumeTask not implemented) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: 0
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；無新跨 module 邊、無 vendor、無 cycle）
- [ ] low coupling / high cohesion 遵守（resume 只加 fold-before-run，不改 P2-I/FSM/ledger 內部）
- [ ] secret-scan 乾淨（effect spy / canary runtime 組裝）
- [ ] Docs 更新（design §2.3 crash-idempotency 機制與本 slice 行為一致）
- [ ] Adversarial code review = PASS（fresh-context；mutation 必抓：① 把 skip 改成仍呼叫 `runGovernedToolCall`（重複 effect）② 把 stepKey 改成含時間戳/隨機（誤判新 step）③ ledger 錯誤時 fail-open 重跑——三者都應使 §5 測試紅）— 連結/摘要: <...>
- [ ] **Independent Verifier Pass 已執行並 clean**（安全不變量核心：no duplicate external effect、fail-closed、stepKey 決定性；IV 親跑 effect-count spy + 三種 mutation）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `resumeTask` 入口 + resume.test.ts）。
- 可逆性: 安全可逆（resume 邏輯純讀 ledger + 複用 S3 路徑；本 slice 不引入新外部副作用；ledger append-only，回退不改歷史）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R5-S3（runner + append-before-advance）、SLICE-P2R-R5-S2（`computeStepKey`/`ResumeLedger.has`）、SLICE-P2R-R5-S1（FSM/schema）。
- Blocks: R7 TaskTimeline（從 WORM/ledger 重建）、R10 Forensic Replay fold 引擎（共用 fold 概念）、R2-backed 真實 WORM ledger slice。
- 確認 slice DAG 無 cycle: 是（rank 4；依賴 rank≤3 的 S1/S2/S3）。
