# SLICE-P2R-R2-S7: composition-root 接線 — 以真實 ingest appender 取代 P2-I in-memory（行為刀）

- **Phase**: P2（R2 — 行為刀：把零網路 core + 真實 RPC adapter 接成 P2-I 的 appender，取代 in-memory；零新依賴）
- **Branch**: slice/p2r-r2-s7-wire-commitgate-appender
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~90、files <~3（composition-root 接線檔 + e2e test + barrel）、modules <~2（composition root + 一條 `src/audit/ingest` 組裝點）、**新增依賴 = 0**（純 wiring；依賴與契約已在 S5/S6）
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R2-S7 — 在 composition root 用 `createIngestClient({transport, sourceId})`（S2）+ S3 dedup + S4 outbox
組裝出一個 `CommitAppender<AuditEvent, AppendReceipt>`，**取代 P2-I 的 in-memory commit appender**
（[`../phase-2/P2-I-governed-pipeline-composition.md`](../phase-2/P2-I-governed-pipeline-composition.md) §16），讓「effect 只在 evidence
落進 WORM kernel 後才發生」**跨 plane（TS→Go）真的成立**。transport 由 S6 `createRpcAppendTransport` 提供。

## (2) Goal（一句話）
把前六刀（core S1-S4 + 契約 S5 + adapter S6）接成 P2-I pipeline 的真實 appender，取代 in-memory，純 wiring、零新依賴。

## (3) In-scope / Out-of-scope
- In-scope：
  - composition-root 接線：`createRpcAppendTransport`（S6）→ `createIngestClient`（S2，含 S3 dedup、S4 outbox flush 策略）→ 作為 `commitBeforeEffect` 的 `appender`，**取代 in-memory**（P2-I §16）。
  - 端到端整合測試：`runGovernedToolCall` happy path 用真實 ingest appender（接 in-process fake kernel 或 S6 fake transport）→ executed、effect 恰 1 次、append 在 effect 前（鏡像 P2-I invocation-count spy）。
- Out-of-scope（明確不做）:
  - 新增任何依賴（已在 S6）/ 改 proto（已在 S5）/ 改 adapter 實作（S6）/ 改 core 邏輯（S1-S4）。
  - durable client outbox、多 endpoint、retry 退避策略 → 後續 ITEM。
  - 改動 Go kernel。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：純 composition-root wiring 切換——把 P2-I 注入的 `appender` 由 in-memory `AppendOnlyLog.append`
  改為 `createIngestClient(...)`。因 client 與 in-memory log 回傳**同一個** `AppendReceipt` 型別
  （[`src/audit/kernel/log.ts:23-28`](../../../src/audit/kernel/log.ts)），P2-I 的 `CommitAppender<unknown,R>` 注入點**零型別改動**。
- **Modules touched（唯一責任）**:
  - composition root — 「把真實 ingest appender 注入 P2-I pipeline，取代 in-memory」。
  - `src/audit/ingest`（組裝點，若需一個 `createIngestAppender` 便利匯出）— 「把 client+dedup+outbox 組成單一 `CommitAppender`」。
- **PUBLIC interface**:
  - （可選）`function createIngestAppender(deps): CommitAppender<AuditEvent, AppendReceipt>`（組裝 client+dedup+outbox；若 S2/S3/S4 已足夠則僅 composition-root 接線，無新公共面）。
- **Dependency direction（inward、acyclic）**:
  ```
  composition-root ──▶ { src/audit/ingest, src/runtime/<adapter>, src/commitgate, src/orchestration }（皆經 barrel）
  ```
  - 僅經 public surface 消費（core 不 import runtime；composition root 是唯一允許同時見 adapter + core 的接線層）: ☑ 是
  - 新依賴宣告：無（依賴已在 S6、契約已在 S5；本 slice 不引入第三方或新跨 module 邊界，僅在 composition root 組裝既有 barrel）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: composition-root e2e（例如 `src/audit/ingest/wire.e2e.test.ts` 或既有 composition-root 測試擴充）
- RED 測試清單（以 S6 in-process fake server / fake transport 注入，不依賴外部進程）:
  - [ ] 端到端 happy：composition root 用真實 ingest appender 跑 `runGovernedToolCall` happy path → `executed`、effect 恰 1 次、append 在 effect 前（鏡像 P2-I 的 invocation-count spy）。
  - [ ] 安全對抗式 / fail-closed 時序：transport reject / timeout → `commitBeforeEffect` abort → effect **零次**（接 `FakeSandboxAdapter` 斷言無 sandbox）。
  - [ ] 替換完整性：composition root **不再** import in-memory `AppendOnlyLog` 作為 pipeline appender（grep/import 斷言或 deps:check）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/audit/ingest/wire.e2e.test.ts
  ... FAIL (real ingest appender not wired) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；5 RED→GREEN，`pnpm test src/audit/ingest/wire.e2e.test.ts` → `5 passed`，exit 0）
- [x] `pnpm run verify` exit 0（含 `deps:check`、`proto:check`、`secret-scan`）— `$ pnpm run verify` → `VERIFY_EXIT=0`
- [x] dependency-boundary check 綠（`$ pnpm run deps:check` → `no dependency violations found (46 modules, 98 dependencies cruised)`，`DEPS_CHECK_EXIT=0`；core 仍零 vendor、composition root 經 barrel、無 cycle）
- [x] low coupling / high cohesion 遵守（行為切換不洩漏 vendor 進 core；wire.ts 僅依 `AppendTransport` port + 同模組/barrel core 面）
- [x] secret-scan 乾淨（`$ pnpm run secret-scan` → `secret-scan: clean`，`SECRET_SCAN_EXIT=0`；endpoint/credential 不入 source/log/fixture，測試以 in-process fake transport 注入）
- [x] Docs 更新（`docs/design/ingest-client-sync-commit.md` §3 記錄 composition-root appender 由 in-memory 替換為真實 ingest；§7 rollback 標記 S7）
- [x] Adversarial code review = PASS（獨立 fresh-context review 已通過；fail-closed mutation 與替換完整性 RED 守在 `wire.e2e.test.ts`）
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（probe：傳輸失敗/server-error effect 零次；happy path effect 恰 1 次、append 先於 effect）

## (7) Rollback
- `git revert <merge-sha>`：composition root appender 換回 in-memory（feature wiring 切換，非資料遷移）。
- 可逆性: 接線可逆；**WORM 已 append 的 evidence 不回寫**（append-only；靠 forward-correcting event，slice-spec §7）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R2-S2（IngestClient）、S3（dedup）、S4（outbox）、S6（真實 RPC transport）；P2-I（pipeline 與 in-memory appender 注入點）；P1 kernel（`AppendService` listening server）。
- Blocks: R7 Personal 殼（TaskTimeline 從 WORM 重建需真實 ingest）、R8 Enterprise（per-tenant kernel partition）、R10 時光旅行。
- 確認 slice DAG 無 cycle: ☑ 是（S7 為 R2 的匯流 sink；下游 R7/R8/R10 依賴 R2 整體）
