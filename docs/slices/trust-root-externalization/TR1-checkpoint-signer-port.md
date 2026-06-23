# SLICE-TR1: CheckpointSigner port — kernel 行程不再持私鑰（in-repo seam + out-of-process signer）

- **Phase**: P4 trust-root externalization（in-repo 架構 seam;真 KMS/HSM operator-inaccessible 證明 = TR2/部署）
- **Branch**: slice/tr1-checkpoint-signer-port
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；Go only;新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS;structural no-raw-key / byte-equivalent drop-in / fail-closed 經 mutation 證實;wire sig byte-identical;proto+verifier 不變;採納 reviewer nit②〔unparseable-pubkey fail-closed 測試〕）

## (0) 動機 + 現況 + ⚠️ 誠實分界（grounded）
moat 唯一剩的上限:kernel **持 raw `ed25519.PrivateKey`**(K1 `IngestServer.signer`,append.go:43;PK1 `PartitionConfig.Signer`/partitionState.signer;main.go `loadOrGenerateSigner`;`chain.SignCheckpoint(priv ed25519.PrivateKey,...)`)→ 跑 kernel 的 operator 能取 key、偽造鏈。
- **TR1(in-repo 可達成)**:把 raw key 換成 `CheckpointSigner` port → **kernel 行程結構性不再持私鑰**;`InProcessSigner`(今日 fallback)+ **out-of-process `CommandSigner`**(key 在外部命令域、不進 kernel 行程)+ KMS/HSM adapter 契約。
- **TR1 誠實不宣稱**:純軟體 out-of-process signer 由同一 operator 跑 → operator 仍能從 signer 取 key,**尚非 operator-unforgeable**;真 operator-inaccessible(HSM/cloud-KMS-IAM)= **TR2/部署**。TR1 宣稱的是 **① kernel 行程永不持私鑰(in-repo 證)② 外部 signer 是 drop-in**。

## (1) ID + Title
SLICE-TR1 — (a) `CheckpointSigner` interface `{ Sign(message []byte) ([]byte, error); Public() ed25519.PublicKey }`(kernel/internal/signer 或 chain);(b) `InProcessSigner`(wrap `ed25519.PrivateKey`,`Sign`=ed25519.Sign,今日行為);(c) **refactor** K1 `IngestServer` + PK1 `PartitionedIngest`/`PartitionConfig` + main.go 改持/注入 `CheckpointSigner`——**raw `ed25519.PrivateKey` 不再是 server/partition 欄位**;checkpoint 簽改 `signer.Sign(CheckpointBytes(head,length))` + `signer.Public()`;(d) **`CommandSigner`**:`-signer-command <cmd>` → kernel 以外部命令簽(message 經 stdin、signature 經 stdout;pubkey 啟動時取一次)——**私鑰不進 kernel 行程**;(e) Go conformance + in-tree fake 簽章命令證 seam + KMS/HSM adapter 契約 doc。

## (2) Goal（一句話）
讓 kernel 行程**結構性不再持有簽章私鑰**——改經 `CheckpointSigner` port 簽,raw key 從所有 server/partition 欄位移除;in-process(今日)與 out-of-process command signer 皆 drop-in,為真 KMS/HSM externalization(TR2)鋪好架構前提。

## (3) In-scope / Out-of-scope
- In-scope:
  - `CheckpointSigner` port + `InProcessSigner`(ed25519,沿用 `chain.SignCheckpoint` 內部)。
  - refactor:`IngestServer.signer` / `PartitionConfig.Signer` / `partitionState.signer` 由 `ed25519.PrivateKey` → `CheckpointSigner`;checkpoint.go / partition Checkpoint 簽改經 port;**grep 證 server/partition 不再有 `ed25519.PrivateKey` 欄位**。`chain.SignCheckpoint` 可留作 InProcessSigner 的內部(或新增 `chain.CheckpointBytes` 已存在 + port 簽)。
  - `CommandSigner`:啟動以 `-signer-command` 取 pubkey(如 `<cmd> pubkey` 回 SPKI DER)+ 每次簽 `<cmd> sign`(message stdin → signature stdout);fail-closed(命令缺/非零退出/壞 sig → error,絕不偽造或 UNSIGNED)。
  - main.go:`-signer-command`(CommandSigner,key 不進行程)| `-signing-key`(InProcessSigner,今日,back-compat 預設)| 皆無 → 生成 in-memory(今日 + honest log);**honest log 區分**「in-process key(attester==operator)」vs「out-of-process signer(key 不在 kernel 行程;operator-unforgeability 取決於該命令的 key 保護 = 部署)」。
  - Go conformance(RED 先):in-process 與 command signer 簽出的 checkpoint 皆過 `VerifyCheckpoint`(pubkey 從 `signer.Public()`);**server/partition 結構性不持 raw key**(欄位型別是 CheckpointSigner;fake spy signer 證 kernel 只呼 Sign/Public、不碰 raw bytes);CommandSigner 用 in-tree fake 命令(持 test key)→ 簽可驗、kernel 行程無 key material;命令失敗 → fail-closed。
  - KMS/HSM adapter 契約 doc(CheckpointSigner 的實作契約:KMS/HSM 怎麼填 Sign/Public;key 不出外部邊界)。
  - `pnpm run verify`/`verify:go` 綠;單鏈 K1/K2 + PK1 既有 conformance 不變(InProcessSigner 行為 byte-equiv)。
- Out-of-scope（誠實標記,= TR2/部署):
  - **真 KMS/HSM/remote-attestation adapter + operator-inaccessible live 證明** = TR2(需你的 AWS/GCP KMS / HSM / TPM / SGX 環境)。
  - 純軟體 CommandSigner **不宣稱** operator-unforgeable(同 operator 可取 signer 行程的 key)。
  - key 輪替、多簽、threshold = 後續。

## (4) Design delta + 依賴方向
- 新 port + 2 impl;refactor 3 處持-key 點改持 port。`chain.SignCheckpoint`/`VerifyCheckpoint` 不變(InProcessSigner 內用)。無新依賴。
- **PUBLIC**:`CheckpointSigner`;`InProcessSigner`/`CommandSigner`;`-signer-command` 旗標 + 協定。

## (5) Test-first plan（RED 先行）
- Go test:checkpoint 經 `CheckpointSigner` 簽且過 `VerifyCheckpoint`(in-process + command signer 兩路);在 port/refactor 前紅(今日收 raw `ed25519.PrivateKey`)。
- spy signer:kernel 只呼 `Sign`/`Public`,不存取 raw key(結構性 + 編譯型別)。
- CommandSigner:fake 命令簽可驗;命令非零退出/壞 sig → fail-closed error(非 UNSIGNED/偽造)。
- 既有 K1/K2/PK1 conformance:InProcessSigner 下 byte-equiv 綠。

## (6) Definition of Done（實測）
- [x] RED:port/refactor 前 `signer`/`server`/`partition` build failed(`undefined: CheckpointSigner`/`NewInProcessSigner`/`NewCommandSigner`)。
- [x] `pnpm run verify` **exit 0**(verify:go ok〔kernel module go test ./... 全 ok〕;**K1/K2/PK1 + internal/conformance〔TS↔Go golden〕+ internal/partition Conformance byte-equivalent 綠**;proto:check go+ts ok〔**無 proto/*.pb.go change**〕;verify:cross-tenant 綠;secret-scan clean〔key runtime-generated〕;git 乾淨無 stray binary)。
- [x] **kernel 行程不持私鑰**:`IngestServer.signer`/`PartitionConfig.Signer`/`partitionState.signer` 型別 = `signer.CheckpointSigner`(server/partition 非-test 碼僅 doc-comment 提 `ed25519.PrivateKey`,無欄位);spy `TestCheckpointUsesPortOnly` 證 kernel 只呼 Sign/Public;reviewer mutation(欄位改回 raw key)→ structural test 紅。
- [x] **in-process + command signer 皆可驗**:InProcessSigner-signed 過 `VerifyCheckpoint` 且 byte-identical `chain.SignCheckpoint`;CommandSigner-signed(in-tree fake 編譯 binary、key 在子行程)亦過;reviewer mutation(InProcessSigner.Public() 回錯 key)→ verify 紅。
- [x] **CommandSigner + nil-signer fail-closed**:命令缺/空 argv/非零退出/壞長度 sig/unparseable pubkey → error(絕不 UNSIGNED/偽造);nil signer → checkpoint 拒;reviewer mutation(失敗仍回 sig)→ fail-closed 紅。**採納 reviewer nit②**:加 `TestCommandSignerUnparseablePubkeyFailsClosed`(`sh -c printf garbage` 的 pubkey → NewCommandSigner error)補上最後一個 construction fail-closed 分支。
- [x] **honest log/標記**:`-signing-key`/generated = "IN-PROCESS key, attester==operator at this layer, P4";`-signer-command` = "private key NOT in the kernel process; operator-unforgeability depends on the external command's key protection (HSM/KMS/IAM) = DEPLOYMENT/TR2; TR1 does NOT claim a pure-software command is operator-unforgeable"。
- [x] KMS/HSM adapter 契約 doc(CheckpointSigner doc-comment;TR2 實作契約)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;4 mutation〔field-type、wrong-pubkey、fabricate-on-error、nil-signer-unsigned〕翻紅;8 攻擊面 HELD/N/A;wire sig byte-identical、proto/verifier 不變)。
> **追蹤 reviewer nit①(→ TR2)**:`kernel/internal/log/InMemoryAppendOnlyLog`(log.go:33)仍持 raw `ed25519.PrivateKey`——但它是 **conformance fixture 用的 reference/non-durable log,非 production IngestServer/partition ingest 路徑**(不在 TR1 範圍);TR2 註記勿誤認為殘留 production key-holder。

## (7) Rollback
- `git revert <merge-sha>`(port + 2 impl + refactor + main 旗標)。`chain.SignCheckpoint`/verifier 不受影響(InProcessSigner 內用)。

## (8) Depends-on / blocks
- Depends-on:K1(單鏈簽章 + `chain.SignCheckpoint`)、PK1(per-partition signer)、P1 kernel server。
- Blocks:**TR2**(真 KMS/HSM adapter + operator-inaccessible live)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:TR1 證 kernel 行程不持私鑰 + 外部 signer drop-in(架構前提);真 operator-inaccessible trust-root(HSM/cloud-KMS/remote attestation)= TR2/部署,需你的環境。
