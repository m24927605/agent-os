# SLICE-K1: kernel 簽 checkpoint + 經 read-back 露出 signature/pubkey（proto + Go）

- **Phase**: P2R-PV-S3a 硬化（contract + Go attester 簽章基礎刀,先行於 TS 消費者）
- **Branch**: slice/k1-kernel-checkpoint-signing
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；Go + proto only（無 TS 消費者改動）；新增依賴 = 0
- **狀態**: **DRAFT**

## (0) 動機 + 現況（grounded）
live kernel 的 read-back UNSIGNED(P2R-PV-S3a):`CheckpointResponse` 無 signature/pubkey,`NewIngestServer` 不持 signer。簽章原語已備(`chain/sign.go` `SignCheckpoint`/`VerifyCheckpoint`,`CheckpointBytes` 與 TS byte-match)。K1 讓 kernel(attester 行程)持 ed25519 key + 簽 checkpoint + 經 `Checkpoint` RPC 露出 signature+pubkey,為 K2(TS 重建可驗 SignedChain + live 驗真 kernel 鏈)鋪 contract + 簽章基礎。

## (1) ID + Title
SLICE-K1 — (a) `proto/ingest.proto` `CheckpointResponse` 加 `string checkpoint_signature = 4`(base64 Ed25519 over `CheckpointBytes(head_entry_hash, length)`)+ `bytes public_key = 5`(kernel ed25519 pubkey,SPKI DER);(b) `NewIngestServer` 增 `ed25519.PrivateKey` signer;`Checkpoint` RPC 在 append mutex 下用 `SignCheckpoint(priv, headEntryHash, length)` 簽當前 head + 回 `checkpoint_signature` + `public_key`(`priv.Public()` 的 SPKI DER);(c) `cmd/kernel/main.go` 加 `-signing-key <file>` 載入 ed25519 私鑰,**無則啟動生成 + 記 honest log**(operator-held key,外部化 = P4)。

## (2) Goal（一句話）
讓 kernel 對自己的 chain head 產生 **可被 `VerifyCheckpoint`/釋出 verifier 驗證的 Ed25519 簽章** 並經 read-back 露出 signature+pubkey,使 attester≠actor 在**行程邊界**成立(kernel 簽、control plane 無 key 不能簽),為「第三方驗真實 kernel 鏈」鋪基礎。

## (3) In-scope / Out-of-scope
- In-scope:
  - **proto**:`CheckpointResponse` 加 `checkpoint_signature`(4,string base64)+ `public_key`(5,bytes SPKI DER)。`pnpm run proto:gen` 重生(Go ingestpb + TS `_generated/ingest`)→ `proto:check` 綠(向後相容:新欄位)。
  - **Go server**:`NewIngestServer(st, audit, signer ed25519.PrivateKey)`(或 functional option,避免破既有呼叫——見 §4 決策);`Checkpoint` handler 在現有 mutex/snapshot 下 `SignCheckpoint(signer, headEntryHash, length)` → 設 `checkpoint_signature`;`public_key` = `x509.MarshalPKIXPublicKey(signer.Public())`。length = checkpoint 的 entry 數(對齊 `CheckpointBytes` 語意)。
  - **main.go**:`-signing-key <file>`(PEM/DER ed25519 私鑰)載入;無則 `ed25519.GenerateKey` + log「HONEST: in-memory signing key, operator-held — key externalization/HSM/remote-attestation = P4」。單鏈 + 分區模式都用(分區模式每 partition 已有 signer〔ES2a〕,K1 聚焦單鏈 Checkpoint 露出 signature;分區 checkpoint 露出 = 沿用同樣式後續/K2 視需要)。
  - **Go conformance/test(RED 先)**:(1) `Checkpoint` RPC 回的 `checkpoint_signature` 過 `VerifyCheckpoint(pub, head_entry_hash, length, sig)`(pub 從回傳的 `public_key` parse);(2) 竄改 head_entry_hash/length → verify fail(非 vacuity);(3) **control plane 不能簽**:append-only client(`internal/client`)無簽章 API、無 key —— 結構性確認 signing 只在 server 端(attester≠actor 行程邊界);(4) 空 log 的 genesis checkpoint 也簽得出且可驗。
  - `pnpm run verify:go` + `proto:check` 綠;`pnpm run verify` exit 0(TS 不受影響——新 proto 欄位 optional,TS read-back 尚不消費)。
- Out-of-scope（明確不做,誠實標記）:
  - **TS read-back 消費 signed checkpoint + live 驗真 kernel 鏈** → **K2**。
  - **key 外部化 / HSM / KMS / remote attestation**(讓 operator 也不能偽造)= **P4**;K1 的 key 由 kernel 行程持有(啟動生成或 operator 提供檔)→ **attester≠actor 只到行程邊界**,明標。
  - 分區模式(ES2a)每-partition checkpoint 露出 signature = 後續(K1 聚焦單鏈)。
  - signing-key 輪替 = 後續。

## (4) Design delta + 依賴方向 + 決策
- proto 新欄位純加(proto3 向後相容)。Go server 增 signer + Checkpoint 簽。`chain/sign.go` 既有、不改(被呼叫)。
- **決策(避免破既有呼叫)**:`NewIngestServer` 簽名變更會觸動 main.go + 既有 test。選 **functional option**(`NewIngestServer(st, audit, WithSigner(priv))`)或新增必填參數並一併更新所有呼叫點——取最小且**不偽裝**(無 signer 時應 fail-closed 或明確 genesis-only?)。**fail-closed 傾向**:server 無 signer 不應靜默回 UNSIGNED checkpoint;K1 要求 signer 必備(main.go 保證提供——載入或生成)。
- **PUBLIC**:proto `CheckpointResponse.{checkpoint_signature, public_key}`;kernel Checkpoint 簽章語意。

## (5) Test-first plan（RED 先行）
- 先寫 Go test:`Checkpoint` 回 signature + pubkey,過 `VerifyCheckpoint` → 在 server 加 signer/簽章前**紅**(目前無欄位/無簽)。
- proto:gen 後 `proto:check` 綠;竄改 head → verify fail;control-plane-無-key 結構確認。
- `pnpm run verify:go` 綠。

## (6) Definition of Done（待實測填）
- [ ] RED:Checkpoint-signature test 在簽章前紅。
- [ ] `proto/ingest.proto` 加 `checkpoint_signature=4`+`public_key=5`;`proto:gen` 重生;`proto:check` 綠。
- [ ] kernel `Checkpoint` 在 mutex 下 `SignCheckpoint` 簽 + 回 signature+pubkey;`-signing-key` 載入或啟動生成(honest log);無 signer fail-closed(不靜默 UNSIGNED)。
- [ ] Go conformance:signature 過 `VerifyCheckpoint`、竄改 head→fail、genesis 可簽可驗、**control plane 無簽章 API/key**(attester≠actor 行程邊界);`verify:go` 綠;`pnpm run verify` exit 0。
- [ ] **誠實標記**:key 由 kernel 行程持有(operator-held)→ attester≠actor 只到行程邊界;key 外部化/HSM/KMS = P4。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:簽錯 bytes→verify fail 沒抓、無 signer 靜默 UNSIGNED、竄改 head 仍 verify 過)。

## (7) Rollback
- `git revert <merge-sha>`(proto 欄位 + server signer + Checkpoint 簽 + main.go flag + 重生檔)。`chain/sign.go` 不受影響。

## (8) Depends-on / blocks
- Depends-on:`chain/sign.go`(SignCheckpoint/VerifyCheckpoint,DONE)、P1 kernel server/proto(DONE)、ES2a(proto partition_id 既有同檔)。
- Blocks:**K2**(TS signed read-back + live 驗真 kernel 鏈)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:K1 交付 kernel 簽章 + 露出 contract;TS 消費 + live 驗真 kernel 鏈 = K2;key 外部化/HSM = P4。
