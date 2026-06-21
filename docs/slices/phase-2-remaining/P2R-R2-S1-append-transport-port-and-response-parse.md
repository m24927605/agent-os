# SLICE-P2R-R2-S1: AppendTransport port + AppendResponse 解析（fail-closed）

- **Phase**: P2（R2 — five-piece STEP「真實 ingest」第一刀；vendor-neutral transport port + oneof 解析）
- **Branch**: slice/p2r-r2-s1-append-transport-port
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~150、files <~4（`src/audit/ingest/{transport.ts,parse.ts,index.ts,parse.test.ts}`）、新增依賴 = 0、modules = 1
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R2-S1 — 定義 vendor-neutral `AppendTransport` port（`append(req)→AppendResponseShape`）與一個純函式
`parseAppendResponse(resp)`：把 kernel 回應的 `oneof{receipt|error}` 解析成 `AppendReceipt`，**任何**非
receipt 結果（error / 空 oneof / CODE_UNSPECIFIED）→ **throw**（fail-closed）。鏡像 Go
`kernel/internal/client/client.go:41-48` 的解析+empty-fail-closed 形狀。

## (2) Goal（一句話）
在不引入任何 RPC 依賴下，先把「跨 plane 接縫的型別形狀 + fail-closed 解析」固定下來，作為後續 IngestClient 的
唯一 transport 依賴與唯一回應解析點。

## (3) In-scope / Out-of-scope
- In-scope：
  - `AppendTransport` interface：`append(req: AppendRequestShape): Promise<AppendResponseShape>`（`AppendRequestShape =
    {sourceId:string, sequence:number, canonicalEvent:Uint8Array}`，鏡像 [`proto/ingest.proto:15-19`](../../../proto/ingest.proto)）。
  - `AppendResponseShape`（plain TS 形狀，鏡像 oneof：`{receipt?:{...}, error?:{code:string,detail:string}}`）。
  - `parseAppendResponse(resp): AppendReceipt`（重用 [`src/audit/kernel/log.ts:23-28`](../../../src/audit/kernel/log.ts) 的 `AppendReceipt`）；
    error / 空 oneof / `CODE_UNSPECIFIED` → throw（含 code+detail，detail 是靜態原因不含 event 內容）。
  - barrel `src/audit/ingest/index.ts`。
- Out-of-scope（明確不做）:
  - 實際送出（canonicalize/dedup/送）→ 留給 S2。
  - proto TS codegen → 留給 S5（契約）；具體 RPC client → 留給 S6（adapter）。
  - 連線/逾時錯誤處理（屬 transport 實作層）→ S6；本 slice 只處理「拿到一個 response 物件後的解析」。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增一個 module `src/audit/ingest`，只含型別 port + 一個純解析函式。無行為副作用、無網路。
- **Modules touched（唯一責任）**:
  - `src/audit/ingest` — 「定義 TS↔kernel 的 vendor-neutral transport port 與 fail-closed 回應解析」。
- **PUBLIC interface**:
  - `interface AppendTransport { append(req: AppendRequestShape): Promise<AppendResponseShape> }`
  - `type AppendRequestShape = { readonly sourceId: string; readonly sequence: number; readonly canonicalEvent: Uint8Array }`
  - `type AppendResponseShape = { receipt?: { sequence:number; contentHash:string; prevHash:string; entryHash:string }; error?: { code:string; detail:string } }`
  - `function parseAppendResponse(resp: AppendResponseShape): AppendReceipt`（throw on 非 receipt）
- **Dependency direction（inward、acyclic）**:
  ```
  src/audit/ingest ──▶ src/audit/kernel (AppendReceipt 型別，同 audit 模組內)
  ```
  - 僅經 public surface 消費（同模組內 `../kernel/log.js` 已由 src/index.ts 匯出）: ☑ 是
  - 新依賴宣告: 無（0 第三方、0 跨 module）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/audit/ingest/parse.test.ts`（module 不存在 → RED：import 失敗）
- RED 測試清單:
  - [ ] receipt 分支：合法 receipt → 回 `AppendReceipt`，四欄一致。
  - [ ] 安全對抗式 / fail-closed：`error` 分支（如 `SEQUENCE_REPLAY`）→ **throw**，訊息含 code+detail。
  - [ ] fail-closed：空 oneof（receipt 與 error 皆 undefined）→ **throw**（deny-by-default）。
  - [ ] fail-closed：`error.code = "CODE_UNSPECIFIED"`（proto zero，[`proto/ingest.proto:31`](../../../proto/ingest.proto)）→ **throw**，絕不當成功。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/audit/ingest/parse.test.ts
  ... FAIL (cannot find module ./index.js) ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；ingest 經 barrel 被消費、無 cycle、無 vendor）
- [ ] low coupling / high cohesion 遵守（單一責任；僅同模組 public surface 消費）
- [ ] secret-scan 乾淨
- [ ] Docs 更新（若 behavior/commands/API 改變）
- [ ] Adversarial code review = PASS（fresh-context；mutation：把空 oneof / CODE_UNSPECIFIED 改成回 falsy receipt → 對應 RED 必須轉紅）
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（probe：所有非 receipt 路徑皆 throw）

## (7) Rollback
- `git revert <merge-sha>`（移除 `src/audit/ingest` 新模組）。
- 可逆性: 安全可逆（純型別 + 純函式，無外部副作用、無 audit append）。

## (8) Depends-on / blocks
- Depends-on: P2-C（commitgate 概念；本 slice 不 import guard 但其形狀為後續 appender 服務）。
- Blocks: SLICE-P2R-R2-S2（IngestClient wrapper）、S6（RPC transport adapter — 實作此 port）。
- 確認 slice DAG 無 cycle: ☑ 是
