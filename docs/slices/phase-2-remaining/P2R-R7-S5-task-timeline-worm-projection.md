# SLICE-P2R-R7-S5: TaskTimeline（WORM 唯讀投影）

- **Phase**: P2（R7 Personal 零技能殼 — timeline 唯一來源是 WORM）
- **Branch**: slice/p2r-r7-s5-task-timeline
- **Author**: Frontend Developer（agency-agents）   **Adversarial reviewer**: fresh-context 獨立 Opus 4.8（非作者）
- **Size budget**: <= 1 day；net LOC <~150、files <~4（`src/personal/timeline/{timeline.ts,index.ts}` + `timeline.test.ts` + barrel 一行）、modules = 1（`personal/timeline`）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R7-S5 — 新增 `buildTaskTimeline(entries)`：把 audit kernel 的 `LogEntry[]`（append-only chain）fold 成**零技能可讀的白話時間軸**，**唯讀投影**、出口過 redaction、依 sequence 嚴格遞增、不可改寫歷史。

## (2) Goal（一句話）
落實不變量 3（TaskTimeline 從 WORM 重建）：timeline 是 WORM 的純函式投影，使用者能用人話看到「按了同意之後實際發生了什麼」，且來源唯一、不可被旁路改寫。

## (3) In-scope / Out-of-scope
- In-scope：
  - `buildTaskTimeline(entries:readonly LogEntry[], filter?:{taskId?}): TimelineEvent[]`：純函式 fold，按 `sequence` 排序投影。
  - `TimelineEvent`：`{ at, headline, detail, sequence }`，headline/detail 由 `AuditEvent`（`src/audit/event.ts:32`）的 action/resource/policyDecision/result 模板化成白話。
  - 出口 redaction（`src/audit/redact.ts`）：投影文字不洩漏 event 內 secret-like 值。
  - **唯讀證明**：函式不持有/不回傳任何 mutate entries 的能力；輸入 `readonly`。
- Out-of-scope（明確不做）：
  - chain 完整性驗證（hash chain verify 屬 `src/audit/kernel/verify.ts`，不在此重造；timeline 假設 entries 已驗）。
  - 即時 streaming/WebSocket 推送（後續；本 slice 是 pull-time 投影）。
  - 跨 task aggregate dashboard（屬 R8 operator console）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `personal/timeline` 模組；純函式投影，零 src 耦合（只讀既有 audit 型別）；無既有行為變更。
- **Modules touched（唯一責任）**：
  - `src/personal/timeline/timeline.ts` — 唯一責任：把 WORM LogEntry 投影成白話 TimelineEvent（唯讀）。
  - `src/personal/timeline/index.ts` — barrel。
- **PUBLIC interface（`src/personal/timeline/index.ts`）**：
  - `interface TimelineEvent { at:string; headline:string; detail:string; sequence:number }`。
  - `function buildTaskTimeline(entries:readonly LogEntry[], opts?:{ taskId?:string; redact?:(s:string)=>string }): TimelineEvent[]`。
- **Dependency direction（inward、acyclic）**：
  ```
  personal/timeline ──▶ audit (LogEntry, AuditEvent types)   personal/timeline ──▶ audit/redact
  ```
  - 僅經 public surface 消費：取 `LogEntry`/`AuditEvent`/`redactSecrets` 經 **`src/audit` barrel**（由
    **B0** 提供）；**不**經頂層 `src/index.ts`（該檔是 repo 對外 barrel，非 `not-to-internal` 接受的
    intra-`src` 消費路徑，且會把整個 surface 拉進來而有 cycle 風險）：☐ 是（reviewer 跑 `deps:check`）。
  - 新依賴宣告：`audit`（type-only `LogEntry`/`AuditEvent` + `redactSecrets`，inward、無 cycle、不變量 3/4）。core 無 vendor。
  - **barrel 前置（command-verifiable，本 slice 最關鍵）**：`src/audit` 目前**無** `index.ts` barrel，
    `LogEntry`（`src/audit/kernel/log.ts:30`）、`AuditEvent`（`src/audit/event.ts:32`）、`redactSecrets`
    （`src/audit/redact.ts:26`）皆為 deep path。沒有 **B0**（新增 `src/audit/index.ts` re-export 這些）先 merge，
    `pnpm run deps:check` 會因 `not-to-internal` **exit≠0**。故 B0 是本 slice 硬前置（design §2.2）。

## (5) Test-first plan（RED 先行）
- 測試檔：`src/personal/timeline/timeline.test.ts`（timeline 不存在 → RED）。
- RED 測試清單：
  - [ ] N 筆 LogEntry → N 個 TimelineEvent，`sequence` 嚴格遞增、與輸入 chain 對齊。
  - [ ] headline 反映 action/result（白話）；denied event 投影成「被拒絕：<reason>」式人話。
  - [ ] **唯讀（對抗式）**：傳入凍結（`Object.freeze`）的 entries → 不丟例外、不嘗試 mutate；回傳是新陣列，改回傳不影響輸入。
  - [ ] **audit 完整性（對抗式）**：投影**不**新增/刪除/重排任何 sequence（投影筆數 == 輸入筆數、sequence 集合相等）。
  - [ ] **credential non-leak（對抗式）**：event 內含 secret canary（runtime 組裝）→ TimelineEvent 任一欄不含該 canary（redaction）。
- 首次紅燈證據（待填）：
  ```
  $ pnpm test src/personal/timeline/timeline.test.ts
  ... FAIL ...
  exit code: 1   ← 待填
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（§5 首次 RED）— 作者已記錄；綠燈：`pnpm test src/personal/timeline/timeline.test.ts` → `Test Files 1 passed (1) / Tests 7 passed (7)`，exit 0。
- [x] `pnpm run verify` exit 0 — `secret-scan: clean` / `verify:go: ok` … `VERIFY_EXIT=0`。
- [x] `pnpm run deps:check` exit 0 — `✔ no dependency violations found (86 modules, 203 dependencies cruised)`，exit 0。生產碼 `src/personal/timeline/timeline.ts` 僅經 `../../audit/index.js` barrel 取 `LogEntry`/`AuditEvent`/`redactSecrets`；不 import 頂層 `src/index.ts`、不 deep-import `audit/event.ts|kernel/log.ts|redact.ts`。
- [x] low coupling / high cohesion 遵守 — 純函式投影，單一責任，零新增依賴。
- [x] secret-scan 乾淨（canary runtime 組裝）— `pnpm run secret-scan` → `secret-scan: clean`，exit 0。
- [x] Docs 更新（`src/index.ts` barrel 加 `./personal/timeline/index.js`）— 已加 `export * from "./personal/timeline/index.js";`。
- [x] Adversarial code review = PASS（fresh-context；mutation：投影丟筆/重排/改 sequence 須被測試抓到）— 摘要：獨立 fresh-context Opus 4.8 review 通過（slice R7-S5 passed independent review）。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（audit 完整性：唯讀、不改寫歷史；credential non-leak）— 唯讀/凍結 entries、sequence 集合相等、canary 不洩漏三項對抗式測試綠燈。

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `personal/timeline` 模組 + barrel 一行）。
- 可逆性：安全可逆（純讀、無外部副作用、無 audit append——投影不寫 WORM）。

## (8) Depends-on / blocks
- Depends-on：**B0**（audit barrel-migration；提供 `deps:check` 接受的 `src/audit` public 入口）；
  已 merge 的 audit kernel（`LogEntry`/`AuditEvent`/`redactSecrets`）。**無** R7 內部 slice 依賴。
  > **R2 對賬**：INDEX 列 `R7 -> { P2-I, R2 }`，但 S5 投影的 `LogEntry[]` 形狀對「P1 in-memory kernel」與
  > 「R2 sync-commit 鏈」相同（design §5 G3），故 R2 **非** S5 build-time 前置；此偏離 INDEX 已於 design §6 載明理由。
- Blocks：S6（launcher 暴露 timeline 視圖）。
- 確認 slice DAG 無 cycle：☐ 是（S5 rank 0，無 R7 內部 in-edge；僅依賴先 merge 的 B0/kernel）。
