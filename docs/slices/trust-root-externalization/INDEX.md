# Trust-root externalization（P4）— INDEX

> 2026-06-23。目標:收掉 moat 唯一剩下的誠實上限——目前 kernel(attester 行程)**持有 raw Ed25519 私鑰**
> (K1 `IngestServer.signer`、PK1 `PartitionConfig.Signer`、main.go `loadOrGenerateSigner`),所以
> **「跑 kernel 的 operator」能取得 key、能偽造鏈**(attester==operator at the trust-root)。終極 moat =
> 私鑰**永不進 kernel 行程**,由 operator-inaccessible 的外部 signer(HSM / cloud-KMS-IAM / remote-attested
> enclave)持有並只回簽章。grounded:`chain.SignCheckpoint(priv ed25519.PrivateKey, ...)` 到處收 raw key。

## 0. ⚠️ 誠實分界（最重要,決定 in-repo vs 部署)
- **in-repo 可達成且有價值(本垂直)**:**架構 seam** —— 把 raw `ed25519.PrivateKey` 換成 `CheckpointSigner` port(`Sign(msg)→sig` + `Public()`),讓 **kernel 行程結構性不再持私鑰**;in-process signer(今日,fallback)+ **out-of-process command signer**(kernel 以外部簽章命令簽,key 在命令域、**不進 kernel 行程**)+ KMS/HSM adapter 契約。**這是 externalization 的架構前提——沒有它就不可能外部化。**
- **非純 in-repo(部署綁定,誠實標記)**:「operator 也不能偽造」最終取決於外部 signer 是否 **operator-inaccessible**:
  - 軟體 out-of-process signer(同一 operator 跑)→ kernel 行程不持 key,但 **operator 仍能從 signer 行程取 key**(尚未 operator-unforgeable)。
  - cloud KMS(AWS/GCP,IAM 隔離)/ HSM / TPM / SGX remote attestation → key 真正 operator-inaccessible(**真 trust-root**)→ 需雲端/硬體基礎設施 + 憑證,**超出純 in-repo,需你的部署環境**。
- 故本垂直**誠實只宣稱**:① kernel 行程永不持私鑰(in-repo 證);② 外部 signer 是 drop-in(KMS/HSM 契約)。**不宣稱** in-repo 軟體 signer 已達 operator-unforgeable。

## 1. 切片分解
| Slice | 範圍 | 狀態 |
|---|---|---|
| **TR1** | `CheckpointSigner` port(`Sign(msg)→sig`+`Public()`)+ `InProcessSigner`(今日)+ refactor K1/PK1/main 改持 port(raw key 不再是 kernel/server/partition 欄位)+ **out-of-process `CommandSigner`**(kernel 以 `-signer-command` 外部命令簽,key 不進 kernel 行程;in-tree fake 簽章命令證 seam)+ KMS/HSM adapter 契約 + Go conformance(經 port 簽且可驗;kernel 結構性不持 raw key;command signer 的 key 不在 kernel 行程)| ✅ **DONE**(structural no-raw-key + byte-equiv drop-in + fail-closed,4 mutation 證實;wire sig byte-identical;proto/verifier 不變;獨立 Opus4.8 review PASS)|
| **TR2(部署/後續)** | **真** KMS/HSM/remote-attestation adapter(target 依你的部署:AWS KMS / GCP KMS / HSM / TPM / SGX)——key 真正 operator-inaccessible + live 驗證。**需你的雲端/硬體環境,非純 in-repo** | OPEN(待 target 決定 + 環境)|

## 2. 待你決定（open decision,影響 TR2,不影響 TR1）
**外部 signer 目標**:AWS KMS / GCP KMS / 實體 HSM(PKCS#11)/ TPM 2.0 / SGX-enclave / 純軟體 out-of-process。TR1 的 seam 是 **target-agnostic**(CommandSigner 讓部署插入任意外部簽章命令);TR2 的「真 adapter + operator-inaccessible live 證明」依此 target + 需該環境。

## 3. 交付順序
TR1(in-repo seam:kernel 不持私鑰 + out-of-process command signer + 契約)→（待你選 target + 環境)TR2(真 KMS/HSM adapter + operator-inaccessible live)。TR1 每刀 doc-first + RED + `pnpm run verify`/`verify:go` 綠 + 獨立 Opus 4.8 review + merge。
