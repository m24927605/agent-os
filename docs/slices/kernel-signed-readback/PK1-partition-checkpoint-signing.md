# SLICE-PK1: partition-per-tenant 簽章 read-back（proto + Go）

- **Phase**: kernel signed read-back 硬化（把 K1 單鏈簽章延到 Enterprise per-tenant 分區;contract + Go 基礎刀）
- **Branch**: slice/pk1-partition-checkpoint-signing
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；Go + proto only（無 TS 消費者改動）；新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8〔報告截斷但實作完成〕;獨立 Opus4.8 reviewer = PASS〔自行建立 RED + 5 mutation 證實〕;per-tenant attester 隔離/ListEntries 隔離/deny/signing 皆證實;drift gate 親測 bite;單鏈 byte-unchanged）

## (0) 動機 + 現況（grounded）
K1/K2 讓單鏈 kernel 簽 checkpoint 並可被釋出 verifier 驗。Enterprise 走 **PartitionedIngest**(ES2a,每 partition 已有獨立 `signer`/`head`/`length`)——但:
- `PartitionAppendServer`(partition_append.go)**只實作 `Append`**(embeds `UnimplementedAppendServiceServer`→ `Checkpoint`/`ListEntries` 未實作)。
- proto `CheckpointRequest{}` 空、`ListEntriesRequest` 只有 `from_sequence`——**無 `partition_id`** → 無法選租戶分區做 read-back。
- 故 Enterprise 租戶**無法**對自己的分區鏈做 signed read-back / 被第三方獨立驗。
PK1 補上:proto 兩個 read-back request 加 `partition_id`;`PartitionedIngest` 加 `Checkpoint(partitionID)`(用該 partition 的 signer 簽,鏡像 K1)+ `ListEntries(partitionID)`;`PartitionAppendServer` 實作兩者。

## (1) ID + Title
SLICE-PK1 — (a) `CheckpointRequest` 加 `string partition_id = 1`、`ListEntriesRequest` 加 `string partition_id = 2`(proto3 向後相容;單鏈 server 忽略空值,partitioned server 對空/未知 fail-closed deny);(b) `PartitionedIngest.Checkpoint(partitionID) → {head, length, signature, publicKey}`(該 partition 的 `signer` 簽 `CheckpointBytes(head, length)` + 回 `x509.MarshalPKIXPublicKey(signer.Public())`)+ `ListEntries(partitionID, fromSeq) → entries`(該 partition 快照);(c) `PartitionAppendServer` 實作 `Checkpoint`/`ListEntries`(route by `req.partition_id`,空/未知 → fail-closed deny,不洩 partition 值)。

## (2) Goal（一句話）
讓 Enterprise 每個租戶分區能產生**用該租戶自己的 key 簽**的 checkpoint 並經 read-back 露出 signature+pubkey,使每租戶的鏈可被釋出 verifier 獨立驗、且 **per-tenant attester 隔離**(A 的鏈只過 A 的 pubkey)在 Go 層證明。

## (3) In-scope / Out-of-scope
- In-scope:
  - **proto**:`CheckpointRequest` + `partition_id=1`、`ListEntriesRequest` + `partition_id=2`。`proto:gen` 重生(Go+TS)→ `proto:check` 綠。
  - **PartitionedIngest**(partition.go):`Checkpoint(partitionID string) → (*Result, error)`——unknown partition → `(nil, err)` fail-closed(沿 Append 樣式);known → 在鎖內讀該 partition `head`/`length`/`signer` → `chain.SignCheckpoint(signer, head, length)` + pubkey(PKIX DER)。`ListEntries(partitionID, fromSeq)`——該 partition 的 store 快照(沿單鏈 ListEntries 樣式)。
  - **PartitionAppendServer**(partition_append.go):實作 `Checkpoint`/`ListEntries`,route by `req.GetPartitionId()`;**空/未知 → fail-closed deny**(不 fall through 單鏈、不洩 partition 值)。
  - **Go conformance(RED 先)**:(1) tenant-A 的 `Checkpoint` signature 過 `VerifyCheckpoint(pubA, headA, lenA, sig)`;(2) **A 的 signature 用 B 的 pubkey → fail**(per-tenant attester 隔離,**本刀新增**);(3) per-tenant `ListEntries` 只回該租戶 entries(A 的 read-back 無 B 的 entry);(4) append A 不動 B 的 head/length(沿 ES2a 隔離);(5) 空/未知 partition_id `Checkpoint`/`ListEntries` → deny。
  - `verify:go` + `proto:check` 綠;`pnpm run verify` exit 0(TS 不受影響)。
- Out-of-scope（誠實標記）:
  - **TS per-tenant reader + live 每租戶驗 + Enterprise** → **PK2**。
  - per-tenant key 外部化/HSM/per-tenant KMS = P4(ES2a 記憶體生,attester≠actor 行程邊界)。
  - 單鏈 server 的 Checkpoint/ListEntries(K1/K2 已做)不變;PK1 只加 partitioned。

## (4) Design delta + 依賴方向 + 決策
- proto 新欄位純加。`PartitionedIngest` 加 Checkpoint/ListEntries(沿 Append 的 route+fail-closed 樣式;per-partition state 已含 signer/head/length)。`PartitionAppendServer` 從只-Append → 也實作兩 read-back RPC。
- **決策**:單鏈 vs 分區的 `partition_id` 語意——單鏈 server(K1)的 Checkpoint **忽略** partition_id(向後相容,Personal/單鏈不送);partitioned server 對空/未知 **fail-closed**。一個 proto、兩種 server 各自合約清楚(沿 ES2a Append 的雙模式)。
- **PUBLIC**:`CheckpointRequest.partition_id`、`ListEntriesRequest.partition_id`;`PartitionedIngest.Checkpoint/ListEntries`;partitioned read-back 語意。

## (5) Test-first plan（RED 先行）
- Go test:partitioned `Checkpoint(A)` signature 過 A 的 pubkey、**過 B 的 pubkey fail**;`ListEntries(A)` 只回 A entries;空/未知 deny → 在實作前紅(目前 partitioned server 無 Checkpoint/ListEntries)。
- proto:gen 後 `proto:check` 綠。`verify:go` 綠。

## (6) Definition of Done（實測）
- [x] RED:reviewer 自證 — 移除 `PartitionAppendServer.Checkpoint` → 落到 `UnimplementedAppendServiceServer` → "method Checkpoint not implemented"(pre-impl 失敗態);test 為新檔。
- [x] proto 加 `CheckpointRequest.partition_id=1`+`ListEntriesRequest.partition_id=2`;`proto:gen` 重生(Go+TS);`proto:check` go+ts ok(reviewer 親改 ingest.pb.go drift → FAIL,證 gate bite)。
- [x] `PartitionedIngest.Checkpoint(partitionID)` 用該 partition signer 簽(既有 ES2a)+ 新增 `PublicKey(partitionID)`(該 partition pubkey)+ `ListEntries(partitionID, fromSeq)`(該租戶 store 快照);`PartitionAppendServer` 實作 `Checkpoint`/`ListEntries` route by `partition_id`,空/未知 **fail-closed deny**(靜態 detail 不洩 partition 值)。
- [x] Go conformance(經 gRPC handler,pubkey 從 **response** 解):A signature 過 A pubkey、**過 B pubkey REJECTED + 反向亦然(per-tenant attester 隔離)**、兩 pubkey distinct、per-tenant ListEntries 隔離(distinct markers + count)、append A 不動 B、空/未知 deny;`verify:go` ok(15 包 -count=1);`verify:cross-tenant` 綠;`pnpm run verify` exit 0。non-vacuity:fixed-pubkey / shared-signer / shared-store / empty-fall-through / Unimplemented 五 mutation 皆翻紅(reviewer 親跑)。
- [x] **誠實標記**:per-tenant key 由 kernel 行程持有(ES2a 記憶體生)→ **attester==operator at THIS layer**(code 註解明示)→ attester≠actor 行程邊界;per-tenant key 外部化/HSM/KMS = P4(不宣稱 operator 不能偽造)。
- [x] **back-compat**:單鏈 `checkpoint.go`/`list.go`(K1/K2)**git diff 空**;TS `partitionId:""` 為最小向後相容(proto required 欄位;單鏈送空 → wire 省略),`createSignedChainReader` **未**獲 per-tenant 行為(PK2)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;writer 報告截斷,reviewer 自行完整建立 RED + 5 mutation;8 攻擊面 HELD/N/A)。

## (7) Rollback
- `git revert <merge-sha>`(proto 欄位 + PartitionedIngest Checkpoint/ListEntries + server 實作 + 重生檔)。單鏈 K1/K2 + ES2a Append 不受影響。

## (8) Depends-on / blocks
- Depends-on:K1(單鏈簽章樣式 + `chain.SignCheckpoint`)、ES2a(PartitionedIngest + per-partition signer/head/length + PartitionAppendServer)、P1 kernel server/proto。
- Blocks:**PK2**(TS per-tenant reader + live 每租戶驗)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:PK1 交付 per-partition 簽章 read-back contract + Go per-tenant attester 隔離;TS 消費 + live 每租戶驗 = PK2;per-tenant key 外部化/HSM = P4。
