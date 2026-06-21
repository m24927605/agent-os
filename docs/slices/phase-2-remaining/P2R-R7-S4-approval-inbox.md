# SLICE-P2R-R7-S4: ApprovalInbox（pending/approve→P2-I/reject，capped）

- **Phase**: P2（R7 Personal 零技能殼 — 顯式核准是唯一 effect 入口）
- **Branch**: slice/p2r-r7-s4-approval-inbox
- **Author**: Frontend Developer（agency-agents）   **Adversarial reviewer**: fresh-context 獨立 Opus 4.8（非作者）
- **Size budget**: <= 1 day；net LOC <~180、files <~4（`src/personal/approval/{inbox.ts,index.ts}` + `inbox.test.ts` + barrel 一行）、modules = 1（`personal/approval`）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R7-S4 — 新增 `ApprovalInbox`：把待核准計畫排進 pending（**capped**，借鏡 Hermes pairing「max 3 pending」），`approve` 是 `runGovernedToolCall`（P2-I）的**唯一**呼叫點、`reject`/未決 ⇒ **不執行**（deny-by-default）。

## (2) Goal（一句話）
把不變量 2（plan-preview-before-effect）落成可驗：計畫只有經 owner 顯式 `approve` 才走 governed pipeline 產生 effect；任何其他狀態（pending/rejected/expired）一律不執行。

## (3) In-scope / Out-of-scope
- In-scope：
  - `ApprovalInbox`：`submit(preview, lower)` → pending entry（id）；`approve(id)` → 呼叫注入的 `runGovernedToolCall` deps 並回 `GovernedOutcome`；`reject(id)` → `denied`。
  - **pending cap（hard cap，借鏡 Hermes `MAX_PENDING_PER_PLATFORM=3`，`/tmp/hermes-agent-probe/gateway/pairing.py:49`）**：超限 submit → deny。
  - `lower`：把 PlanPreview/intent lower 成 P2-I 的 `GovernedCall`（`{tool,context}`，見 `src/orchestration/pipeline.ts:24`）；approve 經此交給注入的 pipeline runner。
  - 一次性授權：approve 只授權**這一個** entry 一次，approve 後 entry 轉 terminal（不可重放）。
- Out-of-scope（明確不做）：
  - 持久化 pending（in-memory 即可；durable store 留後續/R8）。
  - 長期權限/角色（屬 Enterprise R8，最小授權面）。
  - timeline 顯示 → S5；launcher → S6。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `personal/approval` 模組；低耦合靠**依賴注入** pipeline runner（同 P2-I/commitgate 模式），ApprovalInbox 不直接 import 任何 vendor/adapter，只接收一個 `run` 函式。
- **Modules touched（唯一責任）**：
  - `src/personal/approval/inbox.ts` — 唯一責任：管理 pending 計畫的核准生命週期，approve 為唯一 effect 入口。
  - `src/personal/approval/index.ts` — barrel。
- **PUBLIC interface（`src/personal/approval/index.ts`）**：
  - `const MAX_PENDING = 3`。
  - `type SubmitOutcome = { status:"pending"; id:string } | { status:"denied"; reason:string }`。
  - `type DecideOutcome<R> = { status:"executed" | "denied"; outcome?:GovernedOutcome<R>; reason?:string }`。
  - `class ApprovalInbox<TC extends GovernedCall, R> { constructor(run:(tc:TC)=>Promise<GovernedOutcome<R>>); submit(preview:PlanPreview, call:TC):SubmitOutcome; approve(id:string):Promise<DecideOutcome<R>>; reject(id:string):DecideOutcome<R>; }`。
- **Dependency direction（inward、acyclic）**：
  ```
  personal/approval ──▶ orchestration (GovernedCall, GovernedOutcome types)
  personal/approval ──▶ personal/plan (PlanPreview type)
  ```
  - 僅經 public surface 消費（`orchestration` barrel + `personal/plan` barrel）；pipeline runner 為注入函式（不 deep-import）：☐ 是。
  - 新依賴宣告：`orchestration`（type-only + 注入 runner，inward、無 cycle）；`personal/plan`（type-only，inward）。core 無 vendor。

## (5) Test-first plan（RED 先行）
- 測試檔：`src/personal/approval/inbox.test.ts`（inbox 不存在 → RED）。
- RED 測試清單：
  - [ ] `submit` → `pending` + id；`approve(id)` → 呼叫注入 runner **恰 1 次** → `executed` 帶 `GovernedOutcome`。
  - [ ] **deny-by-default（對抗式）**：未 approve（仍 pending）→ runner **0 次呼叫**（spy 計數）；`reject(id)` → `denied`、runner 0 次。
  - [ ] **一次性（對抗式）**：`approve(id)` 後再 `approve(id)` → 第二次 deny、runner **不再被呼叫**（防重放/double-effect）。
  - [ ] **pending cap**：submit 第 4 個（超 `MAX_PENDING`）→ `denied`（borrow Hermes max-3-pending）。
  - [ ] approve 一個 deny 中的計畫（runner 回 `denied`）→ `DecideOutcome.status:"denied"` 帶 stage（透傳 P2-I 短路）。
- 首次紅燈證據（待填）：
  ```
  $ pnpm test src/personal/approval/inbox.test.ts
  ... FAIL ...
  exit code: 1   ← 待填
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（§5 首次 RED）。
- [ ] `pnpm run verify` exit 0（待填）。
- [ ] `pnpm run deps:check` exit 0（`personal/approval` 只 import orchestration + personal/plan barrel、無 cycle、無 vendor、inward；runner 為注入函式非 deep-import）。
- [ ] low coupling / high cohesion 遵守。
- [ ] secret-scan 乾淨。
- [ ] Docs 更新（`src/index.ts` barrel 加 `./personal/approval/index.js`）。
- [ ] Adversarial code review = PASS（fresh-context；mutation：把 approve 改成可重放 / 把 reject 也呼叫 runner，皆須被測試抓到）— 摘要：<待填>。
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（deny-by-default：唯有 approve 觸發 effect、一次性、cap 不可繞過）。

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `personal/approval` 模組 + barrel 一行）。
- 可逆性：安全可逆（in-memory、無 audit append、effect 全由注入的 P2-I 處理，本 slice 無外部副作用）。

## (8) Depends-on / blocks
- Depends-on：S3（PlanPreview type）、P2-I（已 merge；`GovernedCall`/`GovernedOutcome`/`runGovernedToolCall`）。
- Blocks：S6（launcher 需 ApprovalInbox 接線）。
- 確認 slice DAG 無 cycle：☐ 是（S4 rank 3，依賴 rank 2 的 S3 與已 merge 的 P2-I）。
