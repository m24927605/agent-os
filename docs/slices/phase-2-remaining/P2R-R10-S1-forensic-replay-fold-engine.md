# SLICE-P2R-R10-S1: Forensic Replay fold 引擎（唯讀真相重建，零 kernel 改動）

- **Phase**: P2（time-travel ITEM R10；能力屬 design §69 P1.5「先做」）
- **Branch**: slice/p2r-r10-s1-forensic-replay-fold
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~180、files <~4（`src/orchestration/replay.ts` + `src/orchestration/replay.test.ts` + barrel 改一行）、modules <~1（orchestration）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R10-S1 — `TimelineReducer`：把一段 WORM 衍生事件（`LogRecord` 的 `{sequence, event}` 投影，順序由 sequence 決定）唯讀 fold 成一個 `TaskTimeline`（重建任一時點 `state(T)=fold(events[0..N])`），**不重跑任何 tool、不打外部、不碰 credential**，deterministic（同段事件 → 同一 `timelineHash`）。

## (2) Goal（一句話）
交付一個 pure-function fold 引擎，能從已記錄的事件序列唯讀重建任一 sequence 截點的 task timeline 與 folded state，供稽核 / 事後調查 / Independent Verifier 比對（design §10）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `TimelineReducer(events, uptoSequence?)`：對 `events`（已按 `sequence` 排序的 readonly 投影）做 left-fold，重建 `TaskTimeline{ steps, foldedState, headSequence, timelineHash }`。
  - deterministic `timelineHash`（對 folded 投影做 canonical 序列化後 sha256；重放兩次同段 events → 同 hash）。
  - fail-closed：gap / 非單調 sequence / 缺 `sequence` 欄 → 拋 typed `ReplayError`，**不**回傳「看起來完整」的較短 timeline（呼應 store.go:82-128 對 torn tail 的 fail-closed 哲學）。
- Out-of-scope（明確不做）：
  - 任何 mutating restore（forward-append RestoreEvent）→ 留給 SLICE-P2R-R10-S3。
  - `SnapshotRecord` schema → 留給 SLICE-P2R-R10-S2。
  - 真實從 kernel 拉 log 的 client（本 slice 吃 caller 注入的事件投影，不 import kernel）→ 真實拉取走 R2 ingest/read client。
  - 重跑 tool / 重打外部 / brain 重推（依設計**永不**在 forensic replay 做）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增唯讀 timeline 重建能力；零 kernel 改動（design §10、§56 Build-list #1）。`state(T)` 是對複製出的狀態物件套用事件的 left-fold，不 mutate 輸入。
- **Modules touched（唯一責任）**：
  - `src/orchestration/replay.ts` — 唯讀地把事件序列 fold 成 deterministic TaskTimeline（high cohesion：只做 fold + hash + fail-closed 校驗，不做 IO、不做 restore）。
- **PUBLIC interface（新增）**：
  - `type ReplayEvent = { readonly sequence: number; readonly event: unknown }`（caller 從 `LogRecord` 投影，結構契約、非 import kernel）。
  - `type TaskTimeline = { readonly steps: readonly ReplayEvent[]; readonly foldedState: unknown; readonly headSequence: number; readonly timelineHash: string }`。
  - `function replayTimeline(events: readonly ReplayEvent[], uptoSequence?: number): TaskTimeline`（pure；越界/亂序/gap → throw `ReplayError`）。
  - `class ReplayError extends Error`。
- **Dependency direction（inward、acyclic）**：
  ```
  orchestration/replay.ts ──▶ (canonical hash util via barrel) ──▶ domain
  ```
  - 僅經 public surface 消費（無 deep import）: 是。canonical/redact 若需要則經其 barrel（`src/audit` 或 `src/index.ts` 既有 pattern）注入或 import barrel；**不** import kernel `internal/*`（跨 plane 僅型別投影）。
  - 新依賴宣告：無新增第三方依賴；無新增跨 module 邊（沿用既有 canonical/hash barrel）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/orchestration/replay.test.ts`（`replay.ts` 不存在 → 首次 RED：import 失敗）。
- RED 測試清單（每條對應一個行為/不變量）：
  - [ ] 對 N 筆有序事件 fold → `headSequence === lastSequence`、`steps.length === N`。
  - [ ] **determinism**：同段事件 replay 兩次 → 相同 `timelineHash`；改任一事件內容 → hash 改變。
  - [ ] `uptoSequence = k` → 只 fold 到 ≤k，`headSequence === k`（時點重建）。
  - [ ] **fail-closed（對抗式）**：sequence gap（缺 N+1）→ throw `ReplayError`；非單調 / 重複 sequence → throw；缺 `sequence` 欄 → throw（不回傳較短 timeline）。
  - [ ] **唯讀不變量**：傳入的 events 陣列與其元素 fold 後未被 mutate（深層相等）；無任何 tool/IO 被呼叫（以注入的 spy effect 斷言 0 次呼叫）。
- 首次紅燈證據（待實作時填）：
  ```
  $ pnpm test src/orchestration/replay.test.ts
  ... FAIL (cannot find module './replay.js') ...
  exit code: <填實測>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0（typecheck && lint && build && test && deps:check && secret-scan…）
  ```
  $ pnpm run verify
  ... exit code: <填實測>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；無新跨 module / cyclic 依賴；無 deep import kernel internal）
- [ ] low coupling / high cohesion 遵守（replay.ts 僅 fold+hash+校驗；不做 IO / restore / vendor import）
- [ ] secret-scan 乾淨（events 投影為測試資料、無 secret-like 字面值；canary 若需為 runtime 組裝）
- [ ] Docs 更新（design §「Slice 分解索引」已連結本 slice）
- [ ] Adversarial code review = PASS（fresh-context；mutation：把 fail-closed 改成回傳較短 timeline → gap 測試須轉紅，證明測試非 theater）
- [ ] （非安全不變量核心 slice：唯讀、無 effect）→ 經 §7 adversarial review 達成 Tier-2 acceptance，不另跑 Independent Verifier Pass

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `replay.ts` + barrel 一行）。
- 可逆性：安全可逆——純新增、唯讀、無外部副作用、無 audit append、無資料遷移。

## (8) Depends-on / blocks
- Depends-on：P2-I（orchestration 模組已存在、pipeline 組合層已 merge）。**不**依賴任何未 merge slice（唯讀、可極早做）。
- Blocks：SLICE-P2R-R10-S2（SnapshotRecord 引用 fold 出的 timelineHash / foldedState）。
- 確認 slice DAG 無 cycle：是（rank 0，僅依已 merge 的 P2-I）。
