# SLICE-K2: TS signed read-back + live 驗「真實 kernel 鏈」（消費者刀）

- **Phase**: P2R-PV-S3a 硬化（消費者刀:把 kernel 簽的 read-back 串成可被釋出 verifier 驗的真鏈）
- **Branch**: slice/k2-ts-signed-readback-live-verify
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS（signed-chain reader + gated live e2e + harness）；新增依賴 = 0
- **狀態**: **DRAFT**

## (0) 動機 + 現況（grounded）
K1 讓 kernel 簽 checkpoint 並經 `Checkpoint` RPC 露出 `checkpoint_signature` + `public_key`。現況 TS `createEntriesReader`(read-transport.ts:39)只回 `LogEntry[]`(entries,無 signed checkpoint)。K2 加一個 **signed-chain reader**:entries(`ListEntries`)+ signed Checkpoint(`Checkpoint`,K1 的 signature+pubkey)→ 重建 `SignedChain{entries, checkpoint{signature,...}}` + 導出 kernel pubkey → 用 **DV2 釋出的真 verifier** 驗 → **intact = 驗「營運方實際產生的 kernel 鏈」**(不再只驗 kit 自簽)。閉環護城河。

## (1) ID + Title
SLICE-K2 — (a) TS `createSignedChainReader`(或擴 `createEntriesReader`):從 `ListEntries`+`Checkpoint` 重建 `SignedChain`(entries + `checkpoint{signature, headEntryHash, length}`)+ 導出 kernel `public_key`(SPKI → PEM);(b)**gated live e2e + harness**(`e2e:live-kernel-verify`):對**真實簽章 kernel**(K1)append 治理事件 → signed read-back 重建 SignedChain → 寫 chain JSON + kernel pubkey PEM → **DV2 的釋出 verifier**(checksum-verified)驗 → **exit 0 / intact(驗真實 kernel 鏈)** + tampered entry → broken + wrong/kit-pubkey → 非零。

## (2) Goal（一句話）
證明第三方(Developer/auditor)能用**釋出的 verifier** 獨立驗證**營運方實際 kernel 行程產生且簽章的 WORM 鏈**(用 kernel 自報的 pubkey)為 intact、且竄改必被抓——把 DV2 護城河從「kit 自簽鏈」升到「真實 kernel 鏈」。

## (3) In-scope / Out-of-scope
- In-scope:
  - **TS signed-chain reader**:`createSignedChainReader(opts) → Promise<{ chain: SignedChain; publicKeyPem: string }>`:`ListEntries` 取 entries、`Checkpoint` 取 `{head_entry_hash, ...length..., checkpoint_signature, public_key}` → 組 `SignedChain`(field 對齊 Go verifier json tag,沿 DV2 的 `{entries, checkpoint}`)+ `public_key`(SPKI DER)轉 PEM。fail-closed:缺 signature/pubkey → error(不回 UNSIGNED 充當 signed)。
  - **gated live e2e**(`AGENTOS_LIVE_KERNEL_VERIFY`)+ harness `scripts/e2e-live-kernel-verify.sh`:
    1. build **K1 簽章 kernel**(`-signing-key` 或啟動生成)+ build **DV2 verifier**(`verifier:release`)+ **checksum 校驗**。
    2. 起 kernel → append ≥1 治理事件(經既有 ingest appender)。
    3. `createSignedChainReader` 重建 SignedChain + 導出 kernel pubkey PEM。
    4. spawn 釋出 verifier(`--chain <reconstructed> --pubkey <kernel pem>`)→ **exit 0 intact(驗真實 kernel 鏈)**。
    5. **tampered**:改一個 read-back entry 的 bytes → verifier → exit 1 broken(非 vacuity)。
    6. **wrong pubkey**(如 kit 的 pubkey,非 kernel 的)→ 非零(綁 kernel 的 attester key)。
    gated 時 skip。
  - `pnpm run verify` exit 0(reader 單元〔可用 K1 簽出的 fixture / fake transport〕綠;既有不變;live gated skip)。
- Out-of-scope（誠實標記）:
  - **kernel key 外部化 / HSM / KMS / remote attestation** = P4(K2 用 kernel 自報 pubkey;「誰為 pubkey 背書」= P4 trust-root;K2 證「給定 kernel pubkey,kernel 鏈可獨立驗」)。
  - 分區模式每-partition signed read-back = 後續(K2 聚焦單鏈,沿 K1)。
  - WASM browser 驗證 = 後續。

## (4) Design delta + 依賴方向
- 純加 TS reader + gated e2e + harness;不改 K1 的 Go 簽章、不改 DV2 verifier。reader 經 ingest barrel;verify 委派 DV2 的 process-boundary verifier(不在 TS 重算鏈)。
- **PUBLIC**:`createSignedChainReader`;`e2e:live-kernel-verify` 語意。

## (5) Test-first plan（RED 先行）
- 單元(hermetic,fake/ fixture transport):reader 從 entries+signed-checkpoint 重建合法 SignedChain;缺 signature/pubkey → fail-closed error;在 reader 實作前紅。
- **(採納 K1 reviewer MINOR)head/length self-consistency**:reader 重建的 `checkpoint.length` 與 `entries.length` 一致(K1 簽 `CheckpointBytes(head, length)`,length=entry count);若 read-back 的 entries 數與 signed checkpoint 的 length 不符 → reader fail-closed(防 K1 在 lock 外 torn-read 的回歸,且 verifier 也會因 length 不符報 broken)。
- **gated live e2e(我跑)**:真 kernel append → signed read-back → 真 verifier → intact;tampered→broken;wrong-pubkey→非零。RED = reader/harness 未建前型別/檔案錯。

## (6) Definition of Done（待實測填）
- [ ] RED:`createSignedChainReader` + harness 在實作前紅。
- [ ] `pnpm run verify` exit 0(reader 單元綠;既有不變;live gated skip;depcruise/secret-scan clean)。
- [ ] **live(我跑)`pnpm run e2e:live-kernel-verify`**:K1 簽章 kernel + DV2 verifier(checksum)→ append → signed read-back 重建 SignedChain → 釋出 verifier 驗 → **intact(驗真實 kernel 鏈,跨語言)**。
- [ ] **tamper 非 vacuity**:改 read-back entry → verifier broken(嚴格 exit 1)。
- [ ] **wrong-pubkey**:kit pubkey(非 kernel)→ 非零(綁 kernel attester key)。
- [ ] reader fail-closed(缺 signature/pubkey 不充當 signed);credential-blind;不在 TS 重算鏈(委派 verifier)。
- [ ] **誠實標記**:kernel key 外部化/HSM/KMS = P4(用 kernel 自報 pubkey,trust-root 背書 = P4)。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:reader 吞缺 signature、tamper 未抓、wrong-pubkey 仍過)。

## (7) Rollback
- `git revert <merge-sha>`(TS reader + e2e + harness)。K1 簽章 / DV2 verifier 不受影響。

## (8) Depends-on / blocks
- Depends-on:**K1**(kernel 簽 checkpoint + 露出 signature/pubkey)、DV2(釋出 verifier + checksum harness 樣式 + `verifyEvidenceChain`)、P2R-PV-S3b(`createEntriesReader`/ListEntries reader)、P1-S7(TS↔Go conformance)。
- Blocks:無(護城河閉環:第三方驗真實 kernel 鏈;key 外部化 = P4)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:K2 證「給定 kernel 自報 pubkey,真實 kernel 鏈被釋出 verifier 獨立驗 intact + tamper 抓」;pubkey trust-root 背書 / key 外部化 / HSM = P4。
