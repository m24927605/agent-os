# SLICE-P2R-R5-S2: ResumeLedger port（append-only）+ in-memory fake + content-hash stepKey + contract test

- **Phase**: P2（R5 — Task/AgentSession FSM + resume ledger）
- **Branch**: slice/p2r-r5-s2-resume-ledger-port-fake
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~240（含 stepkey.ts 內 ~45 行 module-local canonical-JSON）、files <~4（`src/orchestration/task/{ledger.ts,stepkey.ts}` + `ledger.test.ts`(含 contract harness) + barrel 一行）、modules = 1（orchestration）、新增第三方依賴 = 0。仍在 §3 軟上限（~300/~6）內。
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R5-S2 — 新增 vendor-neutral `ResumeLedger` port（**append-only**：`append`/`list`/`has`）、其 **in-memory fake** 第二實作、決定性 `stepKey` content-hash 函式，並以 **contract test** 鎖死 append-only 與 idempotent-append 不變量。

## (2) Goal（一句話）
交出一個 append-only、content-hash keyed、可被多實作滿足的 ResumeLedger 契約 + fake，作為 crash-resume 的真相儲存抽象。

## (3) In-scope / Out-of-scope
- In-scope:
  - `ResumeLedger` port interface：`append(record)`、`list(taskId)`（依序）、`has(stepKey)`（dedup 查詢）。
  - `InMemoryResumeLedger` fake（≥2 impl 的 fake 側；WORM-backed 實作留給 R2 後）。
  - `computeStepKey({ taskId, stepIndex, intent })` — **module-local** 決定性 canonical-JSON（key 遞迴排序、fail-closed 拒非有限數/未定義，與 `src/audit/canonical.ts:18-62` 同律）後 SHA-256 hex；**決定性**（同輸入恆同輸出）。**不 cross-module deep-import** `audit/canonical`（見下方依賴說明）。
  - **contract test harness**：對任一 `ResumeLedger` 實作斷言 append-only（已 append 的記錄不可被覆寫/刪除）、idempotent-append（同 `stepKey` 重複 append 不產生第二筆、不報錯但回「已存在」）、list 保序。
- Out-of-scope（明確不做）:
  - WORM-kernel-backed `ResumeLedger` 實作 → 留給 R2（TS→Go 真實 ingest）之後的 slice。
  - runner / 接 P2-I → 留給 SLICE-P2R-R5-S3。
  - crash 模擬與 fold → 留給 SLICE-P2R-R5-S4。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 新增 ledger 抽象與決定性 key 函式。append-only 是**結構性保證**：fake 內部用 `Map<stepKey, StepRecord>` + 有序陣列；`append` 對已存在 key 為 no-op-with-signal（不覆寫），無 `delete`/`update` 公共面。
- **Modules touched（每個一句唯一責任）**:
  - `src/orchestration/task/ledger.ts` — 唯一責任：定義 `ResumeLedger` port 與 `InMemoryResumeLedger` fake（append-only、idempotent-by-stepKey）。
  - `src/orchestration/task/stepkey.ts` — 唯一責任：從 (taskId, stepIndex, intent) 算決定性 content-hash `stepKey`（含 module-local canonical-JSON + `node:crypto` SHA-256）。
- **PUBLIC interface（新增）**:
  - `interface ResumeLedger { append(r: StepRecord): Promise<{ appended: boolean }>; list(taskId: TaskId): Promise<readonly StepRecord[]>; has(stepKey: string): Promise<boolean>; }`
  - `class InMemoryResumeLedger implements ResumeLedger`
  - `function computeStepKey(input: { taskId: TaskId; stepIndex: number; intent: unknown }): string`
  - `function resumeLedgerContract(makeLedger: () => ResumeLedger): void`（contract harness，供本 slice 與未來 WORM-backed 實作共用）
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    orchestration/task/ledger ──▶ orchestration/task/session (StepRecord schema, S1)
    orchestration/task/stepkey ─▶ node:crypto（既有 node 內建；canonical-JSON 為 module-local 純函式）
    ```
  - 僅經 public surface 消費（無 deep import）: 是。**注意（verified-from-code）**：repo **無** `src/audit/index.ts`
    barrel，且 `audit/canonical.ts` 的可重用序列化器 `canonicalJson` 為 **module-private**（公共面 `canonicalizeAuditEvent`
    只吃完整 `AuditEvent` 且會 redact）。因此**不能**寫 `../../audit/index.js`（不存在）或 deep-import `../../audit/canonical.js`
    （會違反 `.dependency-cruiser.cjs:33` 的 `not-to-internal`，deps:check 紅）。R5 採「**同律不同碼**」：在
    `stepkey.ts` 內以**最小純函式**重寫決定性 canonical-JSON（與 `canonical.ts:18-62` 同紀律），唯一外部依賴是
    `node:crypto`（doNotFollow core，免規）。**零跨 module deep import**。
  - 新依賴宣告: **無新第三方**、**無新跨 module 邊**（`node:crypto` 為 node 內建，cruiser `doNotFollow` core）。
    > **追蹤 follow-up（非本 slice）**：若要消除「兩份 canonicalizer」的重複，另開一個「把 `canonicalJson` 升為 audit
    > 公共面 + 新增 `src/audit/index.ts` barrel」的契約 slice，再讓 `stepkey.ts` 改 import 之——屬依賴/契約變更，
    > 依 slice-spec §3「依賴變更不與行為變更同 slice」**不混入本 R5-S2**。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/orchestration/task/ledger.test.ts`（含 `resumeLedgerContract` 對 `InMemoryResumeLedger` 跑）
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] **append-only**：append 一筆後再 append 同 `stepKey` → `{appended:false}`、ledger 仍只 1 筆、原記錄**未被覆寫**。
  - [ ] **idempotent-append 對抗式**：同 `stepKey` append 兩次內容不同 → 第二次被拒（不覆寫、不報錯升級為新筆），證 dedup。
  - [ ] **list 保序**：append 3 個不同 step → `list` 依 append/stepIndex 順序回傳。
  - [ ] **決定性 stepKey**：`computeStepKey` 對同一 (taskId, stepIndex, intent) **兩次呼叫回同一 hex**；不同 intent → 不同 hex。
  - [ ] **canonical 決定性對抗式**：intent 物件 key 順序不同但語意相同 → 經 module-local canonical-JSON（遞迴 key 排序）後**同一 stepKey**（防 key 抖動導致重複 effect）。
  - [ ] **canonical fail-closed**：intent 含非有限數（NaN/Infinity）或巢狀 undefined → `computeStepKey` **throw / 拒絕**（與 `canonical.ts` 同律，不靜默 coerce 成不同/相同 key）。
  - [ ] **contract harness 自證**：`resumeLedgerContract(() => new InMemoryResumeLedger())` 全綠。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/orchestration/task/ledger.test.ts
  ... FAIL (cannot import ./ledger.js / ./stepkey.js — not implemented) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: 0
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；ledger 只 import 同 module 的 session(S1)；stepkey 只 import `node:crypto`——**無**跨 module deep import、**無** `audit/*` 邊、無 vendor、無 cycle）
- [ ] low coupling / high cohesion 遵守（port 與 fake 同檔但公共面僅 port+fake+harness；append-only 無 delete/update 公共面）
- [ ] secret-scan 乾淨（hash fixture 為 runtime 組裝、無 source 字面 secret）
- [ ] Docs 更新（design §5/§6 已連結）
- [ ] Adversarial code review = PASS（fresh-context；mutation：把 append 改成可覆寫 / 把 stepKey 改成含時間戳 → 須被 §5 測試抓到）— 連結/摘要: <...>
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（append-only 不可改寫、stepKey 決定性 = 不重複 effect 的根）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 ledger.ts/stepkey.ts + barrel 一行）。
- 可逆性: 安全可逆（in-memory fake 無持久副作用；無 audit append——真實 WORM-backed 實作不在本 slice）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R5-S1（`StepRecord`/`TaskId` schema）、`iam/ids`（branded `TaskId`，interim 允許直 import）。**不** depends-on `audit/canonical`（R5 採 module-local 同律 canonicalizer，見 §4）。
- Blocks: SLICE-P2R-R5-S3（runner append StepRecord）、SLICE-P2R-R5-S4（crash-resume fold ledger）。
- 確認 slice DAG 無 cycle: 是（rank 2；只依賴 rank 1 的 S1 與既有模組）。
