# SLICE-PK2: TS per-tenant signed read-back + live 每租戶獨立驗 + attester 隔離（消費者刀）

- **Phase**: kernel signed read-back 硬化（消費者刀:每 Enterprise 租戶獨立驗自己的鏈 + per-tenant attester 隔離 live）
- **Branch**: slice/pk2-ts-per-tenant-readback-live-verify
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS（reader partitionId + gated live e2e + harness）；新增依賴 = 0
- **狀態**: **DRAFT**

## (0) 動機 + 現況（grounded）
PK1 讓 partitioned kernel 對每租戶分區簽 checkpoint 並經 read-back 露出 signature+pubkey(per-partition signer)。K2 的 `createSignedChainReader`(signed-read-transport.ts)目前**無 partition_id**(只讀單鏈)。PK2 讓 reader 帶 `partitionId`,對指定租戶分區做 signed read-back,並 **live 證明每租戶能用自己的 pubkey 獨立驗自己的鏈、且 A 的鏈過不了 B 的 pubkey(per-tenant attester 隔離)**。

## (1) ID + Title
SLICE-PK2 — (a) `createSignedChainReader` 加 `partitionId?: string`(帶則 `Checkpoint({partitionId})`+`ListEntries({partitionId})`,重建該租戶 `SignedChain` + 該租戶 pubkey PEM;不帶則沿 K2 單鏈);(b)**gated live e2e + harness**(`e2e:live-partition-verify`):partitioned kernel(≥2 租戶,ES2a per-partition signer)→ 各租戶 append → per-tenant signed read-back → 釋出 verifier(checksum)驗:**A 的鏈以 A pubkey → intact、B 以 B → intact、A 的鏈以 B pubkey → broken/拒(per-tenant attester 隔離)** + 跨租戶 entries 隔離(A 的 read-back 無 B 的 entry)。

## (2) Goal（一句話）
證明每個 Enterprise 租戶能用**自己的 pubkey** 讓釋出 verifier 獨立驗證**自己分區的鏈**為 intact,且**一個租戶無法用另一租戶的 key 偽造/驗證其鏈**(per-tenant attester 隔離)——把 K2 的單鏈護城河延到 Enterprise 每租戶。

## (3) In-scope / Out-of-scope
- In-scope:
  - **reader**:`createSignedChainReader({..., partitionId?})`:帶 partitionId → `Checkpoint({partitionId})`+`ListEntries({partitionId})`(PK1 的 partition_id)→ 重建該租戶 `SignedChain{entries, checkpoint{length,headEntryHash,signature}}` + 該租戶 `public_key`→PEM;fail-closed(缺 signature/pubkey、head/length self-consistency,沿 K2);不帶 partitionId → K2 單鏈行為不變。
  - **gated live e2e**(`AGENTOS_LIVE_PARTITION_VERIFY`)+ harness `scripts/e2e-live-partition-verify.sh`:
    1. build partitioned kernel(`-partitions tenant-a,tenant-b`,ES2a 每租戶記憶體生 signer)+ build 釋出 verifier(`verifier:release`)+ **checksum 校驗**。
    2. 各租戶 append ≥1 事件(partition_id 路由)。
    3. `createSignedChainReader({partitionId:"tenant-a"})` / `"tenant-b"` 重建各租戶 SignedChain + 各自 pubkey PEM。
    4. 釋出 verifier 驗:**`--chain A --pubkey A` → exit 0 intact**、`--chain B --pubkey B` → intact、**`--chain A --pubkey B` → 非零(per-tenant attester 隔離)**。
    5. **跨租戶 entries 隔離**:A 的 read-back entries 無 B 的 marker。
    6. tampered A entry → broken。
    gated 時 skip。
  - `pnpm run verify` exit 0(reader 單元〔partitionId 路由 + fail-closed〕綠;K2 單鏈不變;live gated skip)。
- Out-of-scope（誠實標記）:
  - per-tenant key 外部化/HSM/per-tenant KMS = P4(用各租戶 kernel 自報 pubkey;trust-root 背書 = P4)。
  - Enterprise fleet 的 console 直接吐 signed read-back(把 reader 接進 `createEnterpriseFleet`)= 後續(PK2 證 kernel+reader 層每租戶驗;接 fleet console 為薄整合,可後續)。
  - WASM browser = 後續。

## (4) Design delta + 依賴方向
- reader 加 optional partitionId(向後相容 K2);gated e2e + harness。委派釋出 verifier(process boundary,不在 TS 重算鏈)。依賴經 ingest barrel。
- **PUBLIC**:`createSignedChainReader` 的 `partitionId`;`e2e:live-partition-verify` 語意。

## (5) Test-first plan（RED 先行）
- 單元(hermetic,fake transport):reader 帶 partitionId → 對 fake 發 `Checkpoint({partitionId})`+`ListEntries({partitionId})`、重建該租戶 SignedChain(spy 證 partitionId 進 request);缺 partitionId → 單鏈(K2 不變);fail-closed 沿 K2。在 reader partitionId 支援前紅。
- **gated live e2e(我跑)**:per-tenant intact(A/A、B/B)、cross-tenant attester 隔離(A/B → 非零)、entries 隔離、tamper→broken。RED = reader partitionId/harness 未建前型別/檔案錯。

## (6) Definition of Done（待實測填）
- [ ] RED:reader `partitionId` 支援 + harness 在實作前紅。
- [ ] `pnpm run verify` exit 0(reader partitionId 單元綠;K2 單鏈不變;live gated skip;depcruise/secret-scan clean)。
- [ ] **live(我跑)`pnpm run e2e:live-partition-verify`**:partitioned kernel 2 租戶 + verifier(checksum)→ per-tenant signed read-back → **A/A intact、B/B intact(各租戶獨立驗自己的鏈,跨語言)**。
- [ ] **per-tenant attester 隔離(本刀核心)**:**A 的鏈以 B 的 pubkey → 非零**(一租戶不能用另一租戶 key 驗/偽造其鏈)。
- [ ] **跨租戶 entries 隔離**:A 的 read-back 無 B 的 entry;tamper A → broken。
- [ ] reader fail-closed(沿 K2);不在 TS 重算鏈(委派 verifier)。
- [ ] **誠實標記**:per-tenant key 外部化/HSM/per-tenant KMS = P4(各租戶 kernel 自報 pubkey,trust-root 背書 = P4)。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:A/B 驗仍過、entries 跨租戶洩、tamper 未抓)。

## (7) Rollback
- `git revert <merge-sha>`(reader partitionId + e2e + harness)。K2 單鏈 + PK1 Go 不受影響。

## (8) Depends-on / blocks
- Depends-on:**PK1**(partitioned Checkpoint/ListEntries + partition_id)、K2(`createSignedChainReader` + DV2 verifier + harness 樣式)、ES2a(partitioned kernel + per-partition signer)。
- Blocks:無(per-tenant 護城河閉環;接 Enterprise console = 後續;per-tenant key 外部化 = P4)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:PK2 證每租戶用自己 pubkey 獨立驗自己的鏈 + per-tenant attester 隔離(到行程邊界);接 fleet console、per-tenant key 外部化/HSM = 後續/P4。
