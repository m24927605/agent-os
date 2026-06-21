# SLICE-P2R-R2-S2: canonicalize→redact→Append→await Receipt wrapper（IngestClient core）

- **Phase**: P2（R2 — 真實 ingest 的核心 wrapper；同步 commit、fail-closed）
- **Branch**: slice/p2r-r2-s2-ingest-client-wrapper
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~140、files <~3（`src/audit/ingest/{client.ts,client.test.ts}` + barrel 一行）、新增依賴 = 0、modules = 1
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R2-S2 — 新增 `createIngestClient({transport, sourceId})`，回傳一個滿足
`CommitAppender<AuditEvent, AppendReceipt>`（[`src/commitgate/guard.ts:21-23`](../../../src/commitgate/guard.ts)）的物件：`append(event)` 走
**canonicalize（內含 redact）→ contentAddress → 配 sequence → transport.append → parseAppendResponse**，
回傳 durable `AppendReceipt`；任何 transport reject / 解析 throw → **傳播 reject**（commitgate 會 abort、effect 不發生）。

## (2) Goal（一句話）
把 P2-I 的 in-memory appender 可被替換的真實 appender 邏輯做出來：一個與 in-memory `AppendOnlyLog.append` 同形、
零網路依賴（注入 transport）、fail-closed 的 sync-commit wrapper。

## (3) In-scope / Out-of-scope
- In-scope：
  - `createIngestClient(deps: { transport: AppendTransport; sourceId: string }): CommitAppender<AuditEvent, AppendReceipt>`。
  - `append(event)`：① `canonicalizeAuditEvent(event)`（[`src/audit/canonical.ts:65-68`](../../../src/audit/canonical.ts)，已內含 redact）→ canonicalEvent
    bytes；② per-source monotonic sequence（client 維護 counter，從 0 起，每次成功 +1；對齊 Go server 期望，
    [`kernel/internal/server/append.go:72-95`](../../../kernel/internal/server/append.go)）；③ `transport.append({sourceId,sequence,canonicalEvent})`；
    ④ `parseAppendResponse`（S1）→ `AppendReceipt`；⑤ **只有成功才推進 counter**（reject 不推進，下次重試同 sequence）。
- Out-of-scope（明確不做）:
  - dedup（同 sequence 重投 / content conflict）→ 留給 S3。
  - capped outbox（kernel 不可達的緩衝）→ 留給 S4。
  - 具體 RPC transport / 真實連線 → 留給 S6（adapter）；composition-root 接線 → 留給 S7（本 slice 測試用 fake transport）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 client.ts；把既有 canonical/receipt/transport-port 組成一個 `CommitAppender`。redact **不**
  在此重做（canonical 已含），避免雙重關注點。sequence 由 client 配（取捨見 design §4.4）。
- **Modules touched（唯一責任）**:
  - `src/audit/ingest`（client.ts）— 「把 AuditEvent 同步 commit 進 kernel 並回 durable receipt（fail-closed）」。
- **PUBLIC interface**:
  - `function createIngestClient(deps: { transport: AppendTransport; sourceId: string }): CommitAppender<AuditEvent, AppendReceipt>`
- **Dependency direction（inward、acyclic）**:
  ```
  src/audit/ingest/client ──▶ src/audit/canonical (canonicalizeAuditEvent, contentAddress)
                          ──▶ src/audit/kernel/log (AppendReceipt 型別)
                          ──▶ src/audit/ingest/transport,parse (S1，同模組)
                          ──▶ src/commitgate (CommitAppender 型別，經 barrel index.js)
  ```
  - 僅經 public surface 消費（commitgate 經 `../../commitgate/index.js` barrel；其餘同 audit 模組內）: ☑ 是
  - 新依賴宣告：`audit/ingest → commitgate`（型別）：方向=inward（orchestration/commitgate 不 import audit/ingest，無 cycle）、理由=回傳型別需滿足 `CommitAppender` 契約以替換 P2-I appender。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/audit/ingest/client.test.ts`（client 不存在 → RED）
- RED 測試清單（用 fake `AppendTransport`）:
  - [ ] happy：append(event) → fake transport 收到的 `canonicalEvent` == `canonicalizeAuditEvent(event)`；回傳 receipt 四欄來自 response。
  - [ ] sequence 單調：連續三次成功 → transport 收到 sequence 0,1,2。
  - [ ] fail-closed：transport reject → `append` reject（傳播），且 counter **未推進**（下次重試仍送同一 sequence）。
  - [ ] fail-closed：transport 回 `error` oneof → `append` reject（經 parseAppendResponse）。
  - [ ] 安全對抗式 / credential non-leak：event 含 runtime 組裝的 secret canary → 送到 transport 的 bytes **不含** canary（redact 已內含於 canonical）。
- 首次紅燈證據:
  ```
  $ pnpm test src/audit/ingest/client.test.ts
  ... FAIL (cannot find ./client.js) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；commitgate 經 barrel、無 cycle、無 vendor）
- [ ] low coupling / high cohesion 遵守
- [ ] secret-scan 乾淨（canary 於 runtime 組裝，不入 source/fixture/snapshot）
- [ ] Docs 更新
- [ ] Adversarial code review = PASS（mutation：transport reject 後仍推進 counter → sequence 測試轉紅；移除 canonicalize 直送原始 event → canary 測試轉紅）
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（probe：reject 路徑零 counter 推進、bytes 零 canary）

## (7) Rollback
- `git revert <merge-sha>`（移除 client.ts + barrel 一行）。
- 可逆性: 安全可逆（純邏輯、注入 transport，無自身外部副作用；無 audit append 因測試用 fake）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R2-S1（AppendTransport + parseAppendResponse）。
- Blocks: SLICE-P2R-R2-S3（dedup）、S4（outbox）、S7（接 commitgate appender）。
- 確認 slice DAG 無 cycle: ☑ 是
