# SLICE-P2R-R10-S3: Restore FSM + RestoreEvent forward-append（永不截斷 log）

- **Phase**: P2（time-travel ITEM R10；Internal Live Rollback，design §70；Build-list #4）
- **Branch**: slice/p2r-r10-s3-restore-fsm
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~260、files <~5（`src/orchestration/restore.ts` + `src/orchestration/restore.test.ts` + barrel 改一行；可選 `restore-types.ts`）、modules <~1（orchestration）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R10-S3 — Restore 狀態機（`validate → lock → append RestoreInitiated → rebuild projection → append RestoreCompleted`，每 phase **fail-closed**）+ `RestoreEvent`（`kind: "system.restore"`，`actor=admin/approver`、`sourceId ≠ brain`）以 **forward-append** 進 hash-chain，**絕不截斷 / 絕不 rewrite log**（design §44、§49 校正 1）。

## (2) Goal（一句話）
讓「把 task 內部狀態倒回某 SnapshotRecord」成為一筆新的、由授權 actor 簽署的 forward `RestoreEvent` + state-layer projection 重建，而非任何 log 截斷（倒的是狀態層，原始 events 全留鏈上）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `RestoreEvent` 型別（`kind: "system.restore"`、`actor`(admin/approver id)、`sourceId`(non-brain)、`targetSnapshotId`、`targetSequence`、`divergenceReport`）。
  - Restore FSM（XState 或顯式 enum，沿用 R5 Task FSM 風格）：phases `idle → validating → locked → initiated → rebuilding → completed | aborted`；每個 phase 失敗 → `aborted`（fail-closed，**不**部分套用）。
  - **forward-append 不變量**：FSM 透過注入的 `RestoreAppender`（R2 ingest client 的窄介面）emit `RestoreInitiated` 與 `RestoreCompleted` 兩筆 forward 事件；**無任何截斷 API**（測試斷言不存在 truncate 呼叫）。
  - projection 重建以注入的 `rebuildProjection(snapshot)` 抽象表示（具體 DB txn / brain import / sandbox reprovision 由 composition root 注入；本 slice 只保證 FSM 順序 + fail-closed + 兩筆 forward 事件）。
  - **attester≠actor**：`sourceId === "brain"`（或任一 brain source）→ FSM 直接 deny-by-default（腦不可自我 restore，design §44）。
- Out-of-scope（明確不做）：
  - GLOBAL cross-ingest lock 的真實 kernel 實作 → 走 SLICE-P2R-R10-S4（本 slice 的 `lock` phase 吃注入的 `acquireCheckpoint()`）。
  - verifier 認 RestoreEvent → 留給 SLICE-P2R-R10-S5。
  - 真正的 Postgres PITR / brain import / sandbox reprovision 具體實作 → 各自後續 slice（R10-S6 brain、Build-list #7 cost ledger）。
  - PDP `system.restore` deny-by-default 規則 + ApprovalInbox gate → Build-list #8（本 slice 只保證 brain 不可發起 + 注入式 authorize hook）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 mutating restore 編排；**狀態層 projection 重建 + forward RestoreEvent**，WORM log append-only 不變量保持（store.go 無 Truncate 表面、outbox.go append-only by construction）。
- **Modules touched（唯一責任）**：
  - `src/orchestration/restore.ts` — 編排 restore 的有序、fail-closed phase 轉換並 emit 兩筆 forward RestoreEvent（high cohesion：只做 FSM + 順序保證；DB/brain/sandbox/lock/authorize 全注入）。
- **PUBLIC interface（新增）**：
  - `type RestoreEvent = { readonly kind: "system.restore"; readonly actor: string; readonly sourceId: string; readonly targetSnapshotId: string; readonly targetSequence: number; ... }`。
  - `interface RestoreDeps { acquireCheckpoint(): Promise<...>; authorize(actor, snapshot): {effect:"allow"|"deny"; reason}; appender: RestoreAppender; rebuildProjection(snapshot): Promise<void>; }`。
  - `function runRestore(deps: RestoreDeps, snapshot: SnapshotRecord, actor: string, sourceId: string): Promise<RestoreOutcome>`（`{status:"completed"|"aborted", phase, reason?}`）。
- **Dependency direction（inward、acyclic）**：
  ```
  orchestration/restore.ts ──▶ orchestration/snapshot.ts (型別) ──▶ domain
                            └─▶ (RestoreAppender 窄介面，R2 ingest client 注入；不 import kernel internal)
  ```
  - 僅經 public surface 消費（無 deep import）: 是；跨 plane（→ Go kernel）僅經 R2 ingest client 的注入介面，不 deep-import。
  - 新依賴宣告：對 R2 的依賴為**注入的 `RestoreAppender` 介面**（方向 inward、無 cycle、理由：forward-append 需真實 ingest；契約先於消費者，R2 已先行）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/orchestration/restore.test.ts`（`restore.ts` 不存在 → 首次 RED：import 失敗）。
- RED 測試清單：
  - [ ] happy path：valid snapshot + admin actor → phases 走 `validating→locked→initiated→rebuilding→completed`，appender 恰收到 **2 筆** forward 事件（RestoreInitiated、RestoreCompleted），順序正確。
  - [ ] **forward-only 不變量（對抗式）**：FSM 全程**無**任何 truncate/rewrite 呼叫（注入的 appender 只有 append 能力；以 spy 斷言 0 次任何非 append 操作）。
  - [ ] **attester≠actor（對抗式）**：`sourceId` 為 brain → FSM 立即 `aborted` at `validating`、**不** append、deny-by-default。
  - [ ] **fail-closed 各 phase（對抗式）**：`acquireCheckpoint` reject → `aborted` at `locked`、未 emit RestoreInitiated；`rebuildProjection` reject（rebuild 中途崩）→ `aborted` at `rebuilding`、**未** emit RestoreCompleted（不留半完成假象）。
  - [ ] authorize deny → `aborted` at `validating`，無 append。
  - [ ] DivergenceReport（`externalEffectsSinceBaseline` 非空）原樣帶入 RestoreInitiated 事件（operator 核准前可見，design §23）。
- 首次紅燈證據（已驗，移走 restore.ts 重現 import-fail RED）：
  ```
  $ vitest run src/orchestration/restore.test.ts   # 無 restore.ts
  FAIL  src/orchestration/restore.test.ts
  Error: Failed to load url ./restore.js (resolved id: ./restore.js) ... Does the file exist?
  Test Files  1 failed (1)
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5，移走 restore.ts → import-fail RED，exit code 1）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... (typecheck && lint && build && test && deps:check && cross-tenant && launcher:check && secret-scan)
  secret-scan: clean
  VERIFY_EXIT: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；無 cycle、無 deep import kernel internal）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (104 modules, 251 dependencies cruised)
  DEPS_EXIT: 0
  ```
- [x] low coupling / high cohesion 遵守（restore.ts 只做 FSM 順序 + forward append；lock/authorize/projection/appender 全注入）
- [x] secret-scan 乾淨（verify 內 `secret-scan: clean`；DivergenceReport 只含 tool 名/sideEffect 類別，無 secret；canary runtime 組裝）
- [x] Docs 更新（design 索引已連結；§44/§49 forward-append 不變量呼應）
- [x] Adversarial code review = PASS（fresh-context、非作者、獨立 Opus 4.8；slice 已通過 independent review）
- [x] **安全不變量**：Independent Verifier Pass 已執行——對抗式探測 deny-by-default（brain 不可發起）、fail-closed（任一 phase 崩潰不留半完成）、**log 永不截斷**（無 truncate surface）；7 tests passed

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `restore.ts` + barrel 一行）。
- 可逆性：本 slice 僅編排 + 注入；自身不直接寫 WORM（appender 注入）。RestoreEvent 一旦真實 append 即 append-only 不可改寫——回退靠 **forward-correcting event**（再 append 一筆標註撤銷的事件），**不得**改寫歷史（呼應 slice-spec §7 audit append 回退策略）。

## (8) Depends-on / blocks
- Depends-on：SLICE-P2R-R10-S2（消費 `SnapshotRecord`）；R2（真實 ingest client 提供 `RestoreAppender` 注入；契約先於消費者）。
- Blocks：SLICE-P2R-R10-S5（verifier 認 S3 定義的 `RestoreEvent` schema）。
- 確認 slice DAG 無 cycle：是（S3 → {S2, R2}，皆較早 rank）。
