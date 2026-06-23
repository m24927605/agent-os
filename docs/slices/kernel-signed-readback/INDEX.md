# Kernel signed read-back 硬化（P2R-PV-S3a 硬化）— INDEX

> 2026-06-23。目標:收掉**最關鍵的誠實缺口**——live kernel **UNSIGNED read-back**(P2R-PV-S3a:kernel 不持
> ed25519 key,read-back 鏈無 checkpoint 簽章)。硬化後,kernel(獨立 attester 行程)簽自己的 chain checkpoint,
> read-back 露出 signature + pubkey,**第三方(Developer/auditor)能用釋出的 verifier 驗證營運方實際產生的 kernel 鏈**
> ——把 DV2 護城河從「驗 kit 自簽鏈」升到「驗真實 kernel 鏈」。grounded 掃描見下。方法論:[`looping-engineering.md`](../../standards/looping-engineering.md)。

## 0. 缺口 + 現況（grounded,file:line）
- **簽章原語已備**:`kernel/internal/chain/sign.go` `SignCheckpoint(priv, headEntryHash, length)`(base64 Ed25519 over `CheckpointBytes`,與 TS `node:crypto sign(null, checkpointBytes, priv)` byte-match)+ `VerifyCheckpoint`;`chain/types.go:18-20` `Checkpoint` = Ed25519 signature over chain head。
- **但 single-chain `NewIngestServer(st, audit)`(append.go:39)不持 signer、不簽**;`cmd/kernel/main.go` 也未給 key。
- **proto `CheckpointResponse`(ingest.proto:64)= `head_entry_hash`/`head_sequence`/`per_source_next_seq`,無 `signature`、無 `public_key`** → 露出的 checkpoint UNSIGNED。
- **TS `createEntriesReader`(read-transport.ts:39)只回 `readonly LogEntry[]`**(entries),無 signed Checkpoint → 重建的鏈無法被 verifier 驗 Ed25519 attestation。
- **DV2 護城河**目前只驗 **kit 自簽**鏈(`verifyEvidenceChain` over `InMemoryAppendOnlyLog`);驗真實 kernel 鏈被此缺口擋住。

## 1. 端到端目標
```
kernel(attester 行程,持 ed25519 key)→ 簽 checkpoint(SignCheckpoint)
 → read-back 露出 {entries, signed checkpoint, public_key}
 → TS 重建 SignedChain → 釋出的 verifier 驗 → intact(驗的是「營運方實際產生」的鏈)
```
**attester ≠ actor**:kernel(attester)持簽章 key;control plane(actor)**無 key、只能 Append**,無法偽造 checkpoint。

## 2. ⚠️ 誠實邊界（關鍵,寫進每刀）
- 本硬化讓 attester≠actor 成立到 **行程邊界**:kernel 行程簽、control plane 不能簽。
- **但 kernel 的 key 由 kernel 行程持有(啟動時生成或從 operator 提供的檔載入)→ 「operator(跑 kernel 的人)能取得 key」這層仍在**。真正的「operator 也不能偽造」(key 外部化、HSM/KMS、remote attestation)= **P4**,本刀**明確標為已知上限,不假裝已解**。
- 即便如此,這是真實強化:read-back 從 **UNSIGNED → kernel-signed-verifiable**,第三方能驗營運方產的鏈(不再只信 kit 自簽)。

## 3. 切片分解（contract-before-consumer,小、RED-first）
| Slice | 範圍 | 狀態 |
|---|---|---|
| **K1** | proto + Go 簽章:`CheckpointResponse` 加 `checkpoint_signature`(base64)+ `public_key`(kernel ed25519 pubkey,DER/PEM);kernel server 持 ed25519 key(`-signing-key` 檔載入,無則啟動生成並記 honest log)+ `Checkpoint` RPC 用 `SignCheckpoint` 簽 + 回 signature+pubkey;Go conformance(簽出的 checkpoint 過 `VerifyCheckpoint`;control plane 無 key 不能簽)| ✅ **DONE**(簽章正確/length=entry-count/tamper/fail-closed/attester≠actor 5 mutation 證實;drift gate bite;獨立 Opus4.8 review PASS)|
| **K2** | TS signed read-back + live 驗真 kernel 鏈:TS reader 從 `Checkpoint`+`ListEntries` 重建 `SignedChain{entries, checkpoint{signature,...}}` + kernel pubkey;gated live e2e:對真實 kernel append 後 read-back → 重建 SignedChain → 釋出 verifier(DV2 的)驗 → **intact(驗營運方實際鏈)** + tamper→broken | ✅ **DONE + LIVE 3/3**(釋出 verifier 驗真 kernel 鏈 intact〔跨語言〕、tamper→broken、wrong-pubkey→拒;修 Checkpoint codec field4/5;獨立 Opus4.8 review 親 re-ran PASS)|
| **PK1** | partition-per-tenant 簽章 read-back(proto+Go):`CheckpointRequest`/`ListEntriesRequest` 加 `partition_id`;`PartitionedIngest` 加 `Checkpoint(partitionID)`(用該 partition 的 signer 簽 + 回 signature+pubkey〔ES2a 每 partition 已有 signer/head/length〕)+ `ListEntries(partitionID)`;`PartitionAppendServer` 實作兩者(route by partition_id,空/未知 fail-closed)。Go conformance:tenant-A 的 signed checkpoint 過 A 的 pubkey、**過 B 的 pubkey fail(per-tenant attester 隔離)**;per-tenant ListEntries 只回該租戶 entries | ✅ **DONE**(per-tenant attester 隔離〔A 過 A、過 B REJECTED〕+ ListEntries 隔離 + deny + signing,5 mutation 證實;drift gate bite;單鏈 byte-unchanged;獨立 Opus4.8 review PASS)|
| **PK2** | TS per-tenant reader + live + Enterprise:`createSignedChainReader` 帶 `partitionId`;gated live e2e(partitioned kernel 2 租戶):append 各租戶 → per-tenant signed read-back → 釋出 verifier 驗 **A 的鏈以 A pubkey→intact、B 以 B→intact、A 的鏈以 B pubkey→broken/拒(per-tenant attester 隔離)** + 跨租戶 entries 隔離 | ✅ **DONE + LIVE 1/1**(每租戶獨立驗自己的鏈 intact、A-under-B 拒〔per-tenant attester 隔離〕、entries 隔離、tamper→broken;encode field1/2 + reader spy mutation 證實;獨立 Opus4.8 review 親 re-ran PASS)|

## 4. 交付順序
K1(單鏈 proto+Go 簽章)→ K2(TS read-back + live 驗真 kernel 鏈)→ **PK1(partition-per-tenant proto+Go 簽章 read-back)→ PK2(TS per-tenant reader + live 每租戶獨立驗 + attester 隔離)**。每刀 doc-first + RED + `pnpm run verify` 綠 + 獨立 Opus 4.8 review + merge;K2/PK2 含 gated live(我跑)。
> **PK 誠實邊界(同 K1/K2)**:per-tenant key 由 kernel 行程持有(ES2a 記憶體生)→ attester≠actor 行程邊界;per-tenant key 外部化/HSM/per-tenant KMS = P4。**新增證明**:per-tenant attester 隔離(A 不能用 B 的 key 偽造、各租戶獨立驗自己的鏈)。
