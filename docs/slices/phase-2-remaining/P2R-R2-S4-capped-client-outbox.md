# SLICE-P2R-R2-S4: capped client-side outbox（滿載 fail-closed）

- **Phase**: P2（R2 — 有界緩衝；kernel 不可達時 fail-closed 而非 OOM/fail-open）
- **Branch**: slice/p2r-r2-s4-capped-client-outbox
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~140、files <~3（`src/audit/ingest/{outbox.ts,outbox.test.ts}` + barrel）、新增依賴 = 0、modules = 1
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R2-S4 — 新增有界（capped）client-side outbox：當 transport 暫時不可達，pending append 進入有界
buffer 等重送；**buffer 滿載時拒收新 enqueue（fail-closed）**，讓 caller 看見錯誤 → commitgate abort → effect
不發生。鏡像 Go outbox 的「pending → deliver（at-least-once）→ 標記 delivered」骨架
（[`kernel/internal/outbox/outbox.go:222-283`](../../../kernel/internal/outbox/outbox.go)），但 TS 這層先做**有界記憶體**版（durable 化是後續 ITEM）。

## (2) Goal（一句話）
在 kernel 不可達時，用有界緩衝避免無界記憶體成長造成 fail-open，並在滿載時以 fail-closed 拒絕新工作。

## (3) In-scope / Out-of-scope
- In-scope：
  - `createCappedOutbox({ capacity, deliver })`：`enqueue(record)`（滿載 → throw `OutboxFullError`，fail-closed）、
    `flush()`（按 (sourceId,sequence) 排序，at-least-once 送，成功才移除；任一失敗即停止、其餘留 pending — 對齊
    [`kernel/internal/outbox/outbox.go:254-283`](../../../kernel/internal/outbox/outbox.go)）。
  - `pendingCount()` / `isFull()`。
- Out-of-scope（明確不做）:
  - durable（重啟保留、framed-append+fsync+replay）→ 後續 ITEM（Go 已有；TS durable 超出 budget）。
  - 自動背景重送排程 → 由 caller / composition root 驅動 flush（本 slice 只給可呼叫的 flush）。
  - dedup（已在 S3）→ outbox 與 dedup 正交組合在 S7（composition-root 接線）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增獨立 outbox.ts；不改 client.ts（S7 才把兩者組合）。有界是硬約束：`enqueue` 在
  `pendingCount >= capacity` 時 throw，**不**丟棄最舊（丟棄=靜默資料遺失=fail-open，禁止）。
- **Modules touched（唯一責任）**:
  - `src/audit/ingest`（outbox.ts）— 「有界緩衝 pending append，滿載 fail-closed，flush 時 at-least-once 排序遞送」。
- **PUBLIC interface**:
  - `class OutboxFullError extends Error {}`
  - `function createCappedOutbox<R>(deps: { capacity: number; deliver: (rec) => Promise<R> }): { enqueue(rec): void; flush(): Promise<void>; pendingCount(): number; isFull(): boolean }`
    （`rec = { sourceId:string; sequence:number; canonicalEvent:Uint8Array; contentHash:string }`）
- **Dependency direction（inward、acyclic）**:
  ```
  src/audit/ingest/outbox  （獨立；deliver 為注入函式，無對其他 module 的 import）
  ```
  - 僅經 public surface 消費: ☑ 是（deliver 注入，零耦合）
  - 新依賴宣告：無。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/audit/ingest/outbox.test.ts`（outbox 不存在 → RED）
- RED 測試清單:
  - [ ] enqueue 到 capacity → `pendingCount` 正確、`isFull()` true。
  - [ ] 安全對抗式 / fail-closed：滿載再 enqueue → **throw `OutboxFullError`**（不丟棄最舊、不靜默吞）。
  - [ ] flush happy：注入恆成功 deliver → 全部送出、pending 歸零、deliver 呼叫按 sequence 升序。
  - [ ] flush fail-closed：deliver 在第 2 筆 reject → flush reject、已送的移除、**未送的留 pending**（可重試），無資料遺失。
  - [ ] at-least-once：對同一未確認筆，flush 失敗後再 flush 不會跳過它。
- 首次紅燈證據:
  ```
  $ pnpm test src/audit/ingest/outbox.test.ts
  ... FAIL (cannot find ./outbox.js) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；outbox 零 module import、無 cycle、無 vendor）
- [ ] low coupling / high cohesion 遵守
- [ ] secret-scan 乾淨（rec.canonicalEvent 已 redact；測試 canary 於 runtime 組裝）
- [ ] Docs 更新
- [ ] Adversarial code review = PASS（mutation：滿載丟棄最舊而非 throw → fail-closed RED 轉紅；flush 失敗仍移除未送筆 → at-least-once RED 轉紅）
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（probe：滿載必 throw、flush 失敗零資料遺失）

## (7) Rollback
- `git revert <merge-sha>`（移除 outbox.ts + barrel）。
- 可逆性: 安全可逆（記憶體狀態）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R2-S2（共用 `rec` 形狀與 client；deliver 由 S7 接 transport）。
- Blocks: SLICE-P2R-R2-S7（組合 outbox + dedup + client + 真實 transport）。
- 確認 slice DAG 無 cycle: ☑ 是
