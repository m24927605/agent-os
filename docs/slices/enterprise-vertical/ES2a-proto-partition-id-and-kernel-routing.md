# SLICE-ES2a: proto `partition_id` 契約 + Go kernel server 路由到 PartitionedIngest

- **Phase**: P3（Enterprise 垂直;ES2 的「contract + Go」基礎刀,先行於 TS 消費者）
- **Branch**: slice/es2a-proto-partition-id-kernel-routing
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；Go + proto only（無 TS 消費者改動）；新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS;drift gate + fail-closed 路由 + head-independence 經 mutation 證實;單鏈 server byte-identical;honest P4 key marker）

## (0) 動機 + 現況（grounded）
ES1 的 per-tenant WORM 是 in-memory(`Map<partitionId, InMemoryAppendOnlyLog>`)。要升到**真實 kernel per-tenant partition**,前提是 live gRPC AppendService 能依 partition 路由。現況:
- `proto/ingest.proto` `AppendRequest` = `source_id`(1)/`sequence`(2)/`canonical_event`(3),**無 `partition_id`**(source_id 註解寫「P3 binds tenant identity」)。
- `kernel/internal/partition/partition.go` 的 **`PartitionedIngest` 已建**(stand-alone lib:`NewPartitionedIngest(map[id]PartitionConfig{Store,Signer})`、`Append(partitionID string, req)` 依 id 路由到 per-tenant {head,next,store,signer};有 `partition_conformance_test.go`)。
- **但 live server 用單鏈** `server.NewIngestServer(chainStore, audit)`(`kernel/cmd/kernel/main.go:37`)——**未接 PartitionedIngest**。
- `proto:check`(scripts/proto-check.sh)用 protoc 重生 ingest.pb.go + ingest_grpc.pb.go 並 diff `kernel/internal/ingestpb/`(drift gate)。

## (1) ID + Title
SLICE-ES2a — (a) `proto/ingest.proto` `AppendRequest` 加 `string partition_id = 4`(contract-before-consumer;`pnpm run proto:gen` 重生 + `proto:check` pin 對齊);(b) Go kernel server 的 `Append` RPC **依 `req.partition_id` 路由到 `PartitionedIngest.Append(partition_id, req)`**(取代/包裝單鏈 ingest),server 啟動時 provision per-tenant `PartitionConfig{Store, Signer}`;(c) Go conformance:live server 依 partition 路由、per-tenant 鏈獨立(append tenant-a 不移 tenant-b head)、**未知/空 partition_id fail-closed deny**。

## (2) Goal（一句話）
讓真實 kernel gRPC AppendService 能依 `partition_id` 把 append 路由到**每租戶獨立的鏈 + 簽章金鑰**,為 Enterprise per-tenant live WORM(ES2b)鋪好 contract + server 基礎,且跨 partition 隔離由 Go conformance 證明。

## (3) In-scope / Out-of-scope
- In-scope:
  - **proto**:`AppendRequest` 加 `string partition_id = 4`(向後相容:新欄位;舊 source_id/sequence/canonical_event 不動)。`pnpm run proto:gen` 重生 → `kernel/internal/ingestpb/{ingest.pb.go,ingest_grpc.pb.go}` 更新 → `proto:check` 綠。
  - **Go server**:`Append` handler 改為依 `req.PartitionId` 路由到 `PartitionedIngest.Append`(server 持有 `*PartitionedIngest`);**空/未知 partition_id → deny(MALFORMED/fail-closed,絕不 fall through 到單鏈或預設 partition)**。server 啟動 provision per-tenant `PartitionConfig{Store, Signer}`(初始 partition 集合由 config/flag 提供)。
  - **Go conformance/test(RED 先)**:(1) append(partition=a) 後 checkpoint(a) 反映、checkpoint(b) **不變**(per-tenant head 獨立);(2) 同一 source_id 在 a 與 b **各自獨立** sequence(不互相 replay/gap);(3) 空 partition_id → deny;未知 partition_id → deny;(4) per-tenant signer:a 的 checkpoint 用 a 的 key 簽、用 b 的 key 驗 **必須 fail**(沿用 partition_conformance_test 既有保證,於 live server 層再證)。
  - `pnpm run verify:go` + `proto:check` 綠。
- Out-of-scope（明確不做,且誠實標記）:
  - **TS 消費者**(partition_id appender、Enterprise 注入、live e2e)→ **ES2b**。
  - **per-tenant Ed25519 key 來源**:ES2a server 啟動在**記憶體生 key**(或 config 注入測試 key)→ **attester==operator 上限**;真實 key 生成/儲存/輪替(外部 KMS、root-trust externalization)= **P4**。**ES2a 明確標此為已知限制,不假裝已解**。
  - 動態 partition 註冊(register/deprovision)→ ES4;ES2a server 啟動預配置固定 partition 集合。
  - TS `_generated/ingest/ingest.ts` 的 partitionId 欄位 → 在 ES2b 隨消費者一起加(或 ES2a 一併重生但不消費——見 §4 決策)。

## (4) Design delta + 依賴方向 + 一個決策
- proto 新欄位 = 純加(proto3 向後相容)。Go server 從單鏈 → 持有 `*PartitionedIngest` 並路由。`PartitionedIngest` 既有、不改(僅被接線)。
- **決策(TS codec 同步)**:`proto:check` 只 gate Go 的 ingestpb;TS `_generated/ingest/ingest.ts` 是另獨立生成。ES2a **一併**重生 TS ingest codec 含 `partitionId`(欄位 4,optional/default 空字串,向後相容,ES2a 不送),使 proto 真相單一;TS **消費** partitionId 留 ES2b。(若 TS 生成器需手動步驟,ES2a 補上 + 記錄。)
- **PUBLIC**:proto `AppendRequest.partition_id`;kernel server 路由語意(依 partition_id,fail-closed)。

## (5) Test-first plan（RED 先行）
- 先寫 Go server-level test(`kernel/cmd/kernel` 或 server 層):依 partition_id 路由 + per-tenant head 獨立 + 空/未知 partition_id deny → 在 server 接線前**紅**(server 仍單鏈)。
- proto:gen 後 `proto:check` 綠(pin 對齊);若 Go 編譯依賴 `PartitionId` 欄位,先 proto:gen 才編得過(契約先行)。
- `pnpm run verify:go` 綠(partition lib 既有 test + 新 server-level test)。

## (6) Definition of Done（實測）
- [x] RED:`partition_append_test.go` 在 adapter 不存在時 build failed(`undefined: PartitionAppendServer`)。
- [x] `proto/ingest.proto` 加 `partition_id=4`;`pnpm run proto:gen` 重生(Go ingestpb + TS `_generated/ingest`);`pnpm run proto:check` 綠(`go ok`+`ts ok`;reviewer mutation:手改 ingest.pb.go drift → proto:check FAIL,證 drift gate bites)。
- [x] partitioned gRPC AppendService adapter(`kernel/internal/server/partition_append.go`)依 `req.GetPartitionId()` 路由到 `PartitionedIngest`;**空 → deny(MALFORMED "partition_id is required");未知 → fail-closed deny(不洩 partition 值、不生預設 tenant)**。**單鏈 `append.go` byte-identical**(Personal 向後相容,git diff 空)。
- [x] Go conformance(gRPC handler 層):per-tenant head 獨立(append a 不移 b)、per-tenant sequence 獨立、wrong-key 驗證 fail;`verify:go` ok;`pnpm run verify` exit 0(TS 不受影響)。reviewer mutation:empty fall-through → empty-deny test 紅;route a into b → head-independence 紅。
- [x] **誠實標記**:`main.go -partitions` 旗標 provision per-tenant Store+**記憶體生 Ed25519 key**(`// P4: replace with externalized per-tenant key provision` + "attester==operator" 註解 + 啟動 log);`-partitions` 空 = 單鏈模式不變。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;drift / empty-fall-through / head-misroute 三 mutation 皆翻紅;8 攻擊面 HELD/N/A)。
> **⚠️ ES2b 硬前置(reviewer MINOR)**:`src/runtime/ingest/grpc-client.ts` 的 `encodeAppendRequest` **無 field-4(partitionId)encode 分支**;ES2a 只送空值故 wire-correct,但 **ES2b 第一任務必須加 field-4 encode 分支**,否則 TS partitioned append 以空值上線 → fail-closed denied。
> **LSP 註記**:proto regen 後編輯器 LSP 顯示 `GetPartitionId undefined` 為 **stale**(以 `go test`/`verify` command output 為準)。

## (7) Rollback
- `git revert <merge-sha>`(proto 欄位 + server 路由 + 重生檔)。`PartitionedIngest` lib 不受影響。

## (8) Depends-on / blocks
- Depends-on:R8-S3(PartitionedIngest lib,DONE)、P1 kernel server/proto/proto:check(DONE)。
- Blocks:**ES2b**(TS partition_id appender + Enterprise live 注入 + live e2e)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:ES2a 交付 contract + server 路由 + Go 隔離證明;per-tenant key root-trust externalization、TS 消費、live e2e = ES2b / P4。
