# SLICE-P2R-R10-S2: SnapshotRecord Zod schema + system.snapshot 事件型別

- **Phase**: P2（time-travel ITEM R10；design §40、Build-list #3）
- **Branch**: slice/p2r-r10-s2-snapshotrecord-schema
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~140、files <~3（`src/orchestration/snapshot.ts` + `src/orchestration/snapshot.test.ts` + barrel 改一行）、modules <~1、新增依賴 = 0（zod 已在用）
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R10-S2 — `.strict()` `SnapshotRecord` Zod schema（統一錨點 = 單一 WORM `sequence`，其他狀態以 N 定址：`snapshotId`/`sequence`/`wormHeadHash`/`memoryVersion`/`ledgerLsn`/`sandboxRef`/`externalEffectsSinceBaseline`）+ `toSnapshotAuditEvent()` 把它包成 `kind: "system.snapshot"` AuditEvent（供 R2 append 進 WORM）。

## (2) Goal（一句話）
定義一個嚴格驗證、credential-blind 的 `SnapshotRecord` 契約並提供把它轉成 `system.snapshot` 審計事件的純函式，讓一致性快照有可驗證的型別化錨點（design §40）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `SnapshotRecord` Zod `.strict()` schema（多餘欄位 → parse fail，沿用 R4 CredentialLease DRAFT spec 採的 `.strict()` 邊界硬化方針；註：merged src/ 目前尚無 `.strict()` 用例，本 slice 與 R4 一同確立此慣例，非 backref 已存在 code）。
  - 欄位：`snapshotId`(uuid)、`sequence`(int≥0，**統一錨點**)、`wormHeadHash`(sha256: 前綴)、`memoryVersion`(int≥0，對映 R10-S6 brain memory 版本)、`ledgerLsn`(string|null，PITR LSN 或 null=append-REVERSAL 模式)、`sandboxRef`(string|null，宣告式 Sandbox 參照，**非**記憶體 checkpoint)、`externalEffectsSinceBaseline`(readonly array of `{ tool, sideEffect, idempotent }`，DivergenceReport 種子)。
  - `toSnapshotAuditEvent(rec): { kind: "system.snapshot"; ... }`（pure，無 IO）。
  - **credential-blind 不變量測試**：任何欄位帶 secret-shaped 值 → 由注入的 detector 判定後 reject（schema 本身只允許參照/雜湊型欄位，不存 raw payload）。
- Out-of-scope（明確不做）：
  - 真正擷取各 constituent 狀態（取 WORM head / brain dump / Postgres LSN / sandbox 宣告態）→ 留給 SLICE-P2R-R10-S3（Restore FSM 的 capture 階段）。
  - append 進 kernel → 走 R2 ingest client（本 slice 只產生事件物件，不送）。
  - snapshot store 持久化 / GC retention → 留給後續 slice（design §75 retention）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 snapshot 的型別化契約；本身不擷取狀態、不寫 WORM。所有欄位皆為**參照或雜湊**（無 raw secret 落地，design §52）。
- **Modules touched（唯一責任）**：
  - `src/orchestration/snapshot.ts` — 定義 SnapshotRecord 契約 + 轉 audit event（high cohesion：只做 schema + 純轉換，不做 IO、不擷取狀態）。
- **PUBLIC interface（新增）**：
  - `const SnapshotRecord = z.object({...}).strict()`；`type SnapshotRecord = z.infer<...>`。
  - `function toSnapshotAuditEvent(rec: SnapshotRecord): { readonly kind: "system.snapshot"; readonly snapshotId: string; readonly sequence: number; ... }`。
- **Dependency direction（inward、acyclic）**：
  ```
  orchestration/snapshot.ts ──▶ zod, iam/ids (barrel), orchestration/replay.ts (型別) ──▶ domain
  ```
  - 僅經 public surface 消費（無 deep import）: 是（replay 經同模組 / barrel）。
  - 新依賴宣告：無新增第三方依賴；對 R10-S1 的依賴為同模組型別引用（acyclic，S2→S1 嚴格遞減）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/orchestration/snapshot.test.ts`（`snapshot.ts` 不存在 → 首次 RED：import 失敗）。
- RED 測試清單：
  - [ ] valid record → `SnapshotRecord.parse` 成功；`toSnapshotAuditEvent` 回傳 `kind === "system.snapshot"` 並保留 `sequence`/`wormHeadHash`。
  - [ ] **`.strict()`（對抗式）**：多餘欄位（例如塞 `rawCredential`）→ parse throw（拒絕未知欄位，杜絕 raw payload 滲入）。
  - [ ] 欄位型別違規：`sequence` 負數 / `wormHeadHash` 缺 `sha256:` 前綴 / `snapshotId` 非 uuid → parse fail-closed。
  - [ ] **credential-blind**：以注入 detector 對組好的 record 掃描，secret-shaped 值（藏在 `sandboxRef`）→ reject（deny-by-default；detector 拋例外亦 reject）。
  - [ ] `externalEffectsSinceBaseline` 含 `irreversible`/`external` 條目時，`toSnapshotAuditEvent` 完整保留（DivergenceReport 不被吞）。
- 首次紅燈證據（實測，移除 `snapshot.ts` 後重現）：
  ```
  $ pnpm test src/orchestration/snapshot.test.ts
  Error: Failed to load url ./snapshot.js (resolved id: ./snapshot.js) in
    src/orchestration/snapshot.test.ts. Does the file exist?
  Tests  no tests
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；移除 `snapshot.ts` → 測試載入失敗 exit 1）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；無 cycle、無 deep import）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (103 modules, 248 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（snapshot.ts 只做 schema + 純轉換；secret detector 注入、不 import audit 內部）
- [x] secret-scan 乾淨（測試 secret canary 為 runtime 組裝、無 source 字面值）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] Docs 更新（design 索引已連結；本 slice doc 標記 DONE）
- [x] Adversarial code review = PASS（fresh-context；獨立審查通過）
- [x] **安全不變量（credential-blind）**：Independent Verifier Pass 已執行——對抗式探測 secret 不入 snapshot、`.strict()` 拒未知欄位、detector 拋例外 → deny-by-default
  ```
  $ pnpm test src/orchestration/snapshot.test.ts
  Test Files  1 passed (1)
  Tests  12 passed (12)
  exit code: 0
  ```

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `snapshot.ts` + barrel 一行）。
- 可逆性：安全可逆——純新增型別 + 純函式，無 IO、無 audit append、無資料遷移。

## (8) Depends-on / blocks
- Depends-on：SLICE-P2R-R10-S1（引用 `TaskTimeline`/`timelineHash` 作為 `wormHeadHash`/state 錨點來源）。
- Blocks：SLICE-P2R-R10-S3（Restore FSM 消費 SnapshotRecord 作為還原目標）。
- 確認 slice DAG 無 cycle：是（S2 → S1，rank 嚴格遞減）。
