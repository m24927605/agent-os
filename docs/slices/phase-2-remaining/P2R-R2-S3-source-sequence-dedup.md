# SLICE-P2R-R2-S3: (sourceId,sequence) dedup + content-hash conflict fail-closed

- **Phase**: P2（R2 — idempotency/dedup；鏡像 Go outbox `ErrContentConflict`）
- **Branch**: slice/p2r-r2-s3-source-sequence-dedup
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~120、files <~3（`src/audit/ingest/{dedup.ts,dedup.test.ts}` + client.ts 接線 + barrel）、新增依賴 = 0、modules = 1
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R2-S3 — 為 IngestClient 加一張 `(sourceId,sequence)→contentHash` 的 delivered 表：已成功 commit 的
`(sourceId,sequence)` 再以**相同** contentHash 重投 → 回先前 receipt（idempotent no-op，不再打 kernel）；以
**不同** contentHash 重投 → **throw conflict**（fail-closed）。鏡像 Go
[`kernel/internal/outbox/outbox.go:30-31,238-248`](../../../kernel/internal/outbox/outbox.go) 的 `ErrContentConflict` / `CheckDedup` 語意。

## (2) Goal（一句話）
讓同一 `(sourceId,sequence)` 的重投是安全的 idempotent，且「位置已被不同內容佔用」是 fail-closed 衝突，避免
crash-resume 重複 append 或悄悄改寫意圖。

## (3) In-scope / Out-of-scope
- In-scope：
  - delivered 表（記憶體 Map：key `sourceId/sequence` → contentHash + 該次 `AppendReceipt`）。
  - `append(event)` 在送出前查表：命中且同 hash → 回快取 receipt（不打 transport）；命中但異 hash → throw conflict。
  - 成功 commit 後寫入 delivered 表。
- Out-of-scope（明確不做）:
  - durable 化 delivered 表（重啟後保留）→ 後續 ITEM（Go outbox 已 durable；TS durable 化超出 size budget）。
  - capped 緩衝（kernel 不可達）→ 留給 S4。
  - 跨 source 的全域排序保證 → kernel 以 per-source sequence 負責。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：在 S2 的 `append` 路徑前插入 dedup gate；新增一個小型 dedup helper。dedup 是**前置短路**，
  **不放寬** kernel 拒絕（kernel 仍是 SEQUENCE_REPLAY 的權威，[`kernel/internal/server/append.go:76-78`](../../../kernel/internal/server/append.go)）。
- **Modules touched（唯一責任）**:
  - `src/audit/ingest`（dedup.ts）— 「以 (sourceId,sequence,contentHash) 判定 idempotent no-op vs fail-closed conflict」。
- **PUBLIC interface（內部協作為主；對外經 client）**:
  - `createDedupTable(): { check(sourceId,sequence,contentHash): {kind:"new"} | {kind:"replay",receipt:AppendReceipt} | {kind:"conflict"}; record(sourceId,sequence,contentHash,receipt): void }`
  - client 行為差：`conflict` → throw；`replay` → 回快取 receipt。
- **Dependency direction（inward、acyclic）**:
  ```
  src/audit/ingest/client ──▶ src/audit/ingest/dedup ──▶ src/audit/kernel/log (AppendReceipt)
  ```
  - 僅經 public surface 消費: ☑ 是
  - 新依賴宣告：無第三方；模組內新增 dedup.ts，無 cycle。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/audit/ingest/dedup.test.ts`（dedup 不存在 → RED）
- RED 測試清單:
  - [ ] 首投 (s,0,hashA) → `new`；commit 後 record。
  - [ ] 重投 (s,0,hashA)（同 hash）→ `replay`，回先前 receipt，**transport 未被再呼叫**（用 spy 斷言 0 次新呼叫）。
  - [ ] 安全對抗式 / fail-closed：重投 (s,0,hashB)（異 hash）→ `conflict` → client `append` **throw**（絕不改寫已 settled 位置）。
  - [ ] 不同 source 同 sequence 互不干擾：(sX,0) 與 (sY,0) 各自 `new`。
- 首次紅燈證據:
  ```
  $ pnpm test src/audit/ingest/dedup.test.ts
  ... FAIL (cannot find ./dedup.js) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；無 cycle、無 vendor）
- [ ] low coupling / high cohesion 遵守
- [ ] secret-scan 乾淨
- [ ] Docs 更新
- [ ] Adversarial code review = PASS（mutation：把 conflict 改成靜默覆寫 → 異-hash RED 轉紅；把 replay 改成重打 transport → spy RED 轉紅）
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（probe：異-hash 必 throw、同-hash 零重打）

## (7) Rollback
- `git revert <merge-sha>`（移除 dedup.ts + client 接線）。
- 可逆性: 安全可逆（記憶體狀態，無持久副作用）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R2-S2（IngestClient append 路徑）。
- Blocks: SLICE-P2R-R2-S7（接 commitgate appender — 需 dedup 行為齊備）。
- 確認 slice DAG 無 cycle: ☑ 是
