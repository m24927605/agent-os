# SLICE-P2R-PV-S3a: kernel ListEntries 唯讀 RPC（append-only 安全、verifier-相容、unsigned）

- **Phase**: P2（Personal 垂直 S3 的 kernel 側;真 Go feature）
- **Branch**: slice/p2r-pv-s3a-kernel-listentries-rpc
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~120（`proto/ingest.proto` + `kernel/internal/server/list.go` + `list_test.go`;**生成碼不計**)、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-PV-S3a — 在現有 `AppendService` 上新增**一個唯讀** RPC `ListEntries(from_sequence)`,回傳與 `chain.LogEntry` 同構的 `Entry{sequence, canonical_event(已脫敏), prev_hash, entry_hash}`,讓 client 能從**真實 kernel WORM** 讀回鏈條目以重建 TaskTimeline(S3b)+ 獨立重算鏈結/entryHash 驗證完整性。**讀取 != 背書**(attester≠actor):append-only 安全、絕不 append/rewrite/truncate。

## (2) Goal（一句話）
給 kernel 一條乾淨、網路可達、append-only 安全的讀回路徑(取代 S2 直讀 WAL 檔的 hack),使 client 取得的 Entry 能逐位元重算 entryHash 與 stored 一致。

## (3) In-scope / Out-of-scope
- In-scope:
  - `proto/ingest.proto`(additive):`message Entry {uint64 sequence=1; bytes canonical_event=2; string prev_hash=3; string entry_hash=4;}`、`message ListEntriesRequest {uint64 from_sequence=1;}`、`message ListEntriesResponse {repeated Entry entries=1;}`、在 `AppendService` 加 `rpc ListEntries(ListEntriesRequest) returns (ListEntriesResponse);`。重跑 `scripts/proto-gen.sh` 重生 **Go(`kernel/internal/ingestpb`)+ TS(`src/runtime/_generated/ingest`)** stub,兩邊一起 commit(proto:check drift gate)。
  - `kernel/internal/server/list.go`:`IngestServer.ListEntries(ctx, req)`——**取 `s.mu`**(與 Append/Checkpoint 同鎖,一致快照、不讀 torn tail)→ `store.Load()`(既有 fail-closed 重播;torn → 硬錯)→ filter `sequence >= from_sequence` → 每筆由 stored `Event` 經 `chain.CanonicalBytes`(或既有 canonical 路徑)**重新導出 canonical_event** → 組 `Entry[]`。Load 出錯 → `Internal`,**絕不回部分結果**。
  - `kernel/internal/server/list_test.go`(RED 先):append N 筆 → `ListEntries(0)` 回 N 筆,sequence/prev_hash/entry_hash 與 append 時一致,且**用回傳的 canonical_event 重算 entryHash == 回傳的 entry_hash**(canonical round-trip 不變量);`ListEntries(k)` 回 tail;torn store → error 非部分。
- Out-of-scope（明確不做）:
  - **簽章/SignedChain 讀回**:線上 IngestServer **無 Ed25519 私鑰**(簽章只在 verifier 測試路徑;`cmd/kernel/main.go` 從不產/載金鑰)。讓讀回自我背書 = 引入線上金鑰管理(產生/持久化/分發/輪替),屬更大的安全決策——**留待後續**。S3 讀回為 **unsigned**:client 可驗鏈結+entryHash,**尚未**驗 Ed25519 anchor(誠實缺口)。
  - streaming(大鏈用 server-stream)、range/seek(Load 是 read-all);本刀 unary + 全量 + client 端 filter。後續可優化。
  - TS client / timeline 接線 → **S3b**。

## (4) Design delta + 模組 + 介面 + 依賴方向
- **Design delta**:additive proto + 一個唯讀 server method;**不改 Append/Checkpoint、不改 store(只呼叫既有 Load)**。store 仍純持久化、無業務邏輯。
- **依賴方向**:`server/list.go` → `store`(Load)+ `chain`(CanonicalBytes/重算);沿用既有 import,無 cycle。
- **PUBLIC interface(proto)**:`AppendService.ListEntries`;output 與 `chain.LogEntry` 欄位對齊(verifier-相容)。

## (5) Test-first plan（RED 先行,Go）
- `list_test.go`:`ListEntries` 未實作 → 編譯/測試失敗(RED)。
- RED 清單:append 3 → ListEntries(0) 回 3、欄位齊全;**canonical round-trip**:`chain.EntryHashFromCanonical(entry.canonical_event, entry.prev_hash, entry.sequence) == entry.entry_hash`;ListEntries(2) 回 tail(seq≥2);空 log → 0 筆;Load torn → Internal error。
- 首次 RED 證據:`go test ./internal/server -run ListEntries` 編譯失敗(method 不存在)。

## (6) Definition of Done（待實測填）
- [ ] RED:list_test 在 ListEntries 不存在時 fail。
- [ ] `pnpm run verify` exit 0(含 `verify:go` + `proto:check` Go/TS drift 綠;生成碼兩邊一致已 commit)。
- [ ] `go test ./internal/server`(env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local)綠;**canonical round-trip 不變量**測試過。
- [ ] append-only 安全:ListEntries 取 s.mu、不 append/truncate(reviewer 檢視 + 既有 store 無 truncate 表面)。
- [ ] secret-scan clean(canonical_event 已脫敏;無 raw secret)。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:回傳未脫敏/原始 event、或 entry_hash 與 canonical 不一致 → round-trip 測試紅;from_sequence filter 反向 → tail 測試紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除 ListEntries proto+impl+test + 還原生成碼)。Append/Checkpoint 不受影響、可逆。

## (8) Depends-on / blocks
- Depends-on:P1 kernel(store/chain/server/proto + proto-gen)、R2-S5(proto codegen 慣例)。
- Blocks:P2R-PV-S3b(TS client + timeline live-read)。
- 確認 DAG 無 cycle: ☑ 是
