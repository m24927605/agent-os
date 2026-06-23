# SLICE-DV2: Developer 護城河的真 verifier live 證明（cross-language + tamper + checksum）

- **Phase**: P4（Developer 垂直;把 DV1 的 spawn-relay 契約升到**真 Go verifier binary** 的密碼學證明）
- **Branch**: slice/dv2-real-verifier-live-proof
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS（暴露 pubkey + gated e2e + harness）+ 可能小 verifier-build glue；新增依賴 = 0
- **狀態**: **DONE**（merged + LIVE 3/3;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS〔且親自 re-ran live 自證跨語言 byte-match〕;護城河從契約升為真實密碼學證明）

## (0) 動機 + 現況（grounded）
DV1 的 `verifyEvidenceChain` 用 **test-double** 證 spawn-relay 契約。護城河(INDEPENDENT VERIFIABILITY)要成立,必須證 **kit 產生的 WORM 鏈能被釋出的真 Go verifier 獨立驗證**(跨語言 byte-match;reading ≠ attesting)。現況:
- `kernel/cmd/verifier`(main.go:3-7)讀 `--chain <SignedChain JSON>` + `--pubkey <Ed25519 PEM/DER>`,recompute+verify,exit 0=intact/非零;**只依 internal/verify+chain,絕不依 producer(log)** → auditor 信小 binary 而非平台。
- `verifier:release`(scripts/build-verifier-release.sh)reproducible build(`-trimpath`/`CGO_ENABLED=0`/`-buildid=`)+ 產 `SHA-256SUMS`。
- DV1 kit:`verifyEvidenceChain(pubkeyPath)` 已序列化 WORM 成 `{entries: worm.entries(), checkpoint: worm.checkpoint()}`(field 名與 Go json tag byte-for-name 對齊);kit 內部 `generateKeyPairSync("ed25519")`(bootstrap.ts:169)**但未暴露 publicKey**。
- 跨語言保證:P1-S7 TS↔Go canonical/entryHash/checkpoint conformance 已綠 → 真 verifier **應**接受 TS 產生的 signed 鏈(DV2 live 實證;若 canonicalization 不 byte-match,verifier 報 broken = live 抓到的真缺口)。

## (1) ID + Title
SLICE-DV2 — (a) kit 暴露其 Ed25519 **publicKey**(PEM 導出 helper / opts 注入 keypair),使開發者能把 pubkey 交給 verifier;(b)**gated live e2e + harness**(`e2e:live-developer`):**build 真 `kernel/cmd/verifier`**(`verifier:release`)→ **checksum 校驗**(對 `SHA-256SUMS`)→ kit author+runTool → 導出 kit pubkey → `verifyEvidenceChain(pubkeyPath, {AGENTOS_VERIFIER_BIN})` → **exit 0(intact,真 verifier 驗 TS 鏈)** + tampered 鏈 → exit 1(broken)+ wrong pubkey → 非零。

## (2) Goal（一句話）
證明 Developer kit 產生的 WORM 證據鏈能被**釋出的真 Go verifier 獨立密碼學驗證為 intact**(跨語言 byte-match)、且**竄改必被抓**(broken)、**錯 pubkey 必拒**——把護城河從 DV1 的契約升到真實密碼學證明,且 verifier binary 經 checksum 校驗(provenance)。

## (3) In-scope / Out-of-scope
- In-scope:
  - **暴露 pubkey**:`DeveloperKit` 加 `publicKeyPem(): string`(或 opts 注入 keypair),導出 kit 的 Ed25519 公鑰(verifier 用 PEM/DER)。不洩私鑰。
  - **gated live e2e**(`AGENTOS_LIVE_VERIFIER`,鏡像既有 gated live 模式)+ harness `scripts/e2e-live-developer.sh`:
    1. `verifier:release` build 真 verifier(standalone)→ 產出 + `SHA-256SUMS`。
    2. **checksum 校驗**:重算 binary 的 SHA-256,對 `SHA-256SUMS`(若不符 → fail,證 provenance gate)。
    3. kit `authorTool` + `runTool`(≥1 governed action → WORM signed 鏈)。
    4. 導出 kit pubkey(PEM 檔)→ `verifyEvidenceChain(pubkeyPath, {AGENTOS_VERIFIER_BIN=<built>})` → **exit 0 / `{ok:true,length}`**(真 verifier 驗 TS 鏈 intact = 跨語言 byte-match 實證)。
    5. **tampered**:改一個 entry 的 bytes → 真 verifier → exit 1 / `{ok:false,broken}`(非 vacuity:verifier 真抓竄改)。
    6. **wrong pubkey**:用另一把 pubkey → 非零 /`{ok:false}`(trust-root 綁作者 pubkey)。
    gated 時 skip(verify hermetic)。
  - `pnpm run verify` exit 0(含 DV1 既有 e2e 不變;新 pubkey helper 單元;live e2e gated skip)。
- Out-of-scope（明確不做,誠實標記）:
  - **驗證 live KERNEL 的鏈**:Personal S2 揭露 live kernel **UNSIGNED read-back**(P2R-PV-S3a;kernel 不持 ed25519 key)→ verifier 驗 Ed25519 checkpoint 會對 unsigned 鏈失敗。DV2 護城河證明用 **kit 自己 ed25519-signed 的鏈**(乾淨,不依 kernel 簽章);驗 live kernel 鏈 = **後續(待 kernel signed read-back)**。
  - **verifier pubkey trust-root 外部化**(KMS/pinned 分發)= P4;DV2 證「作者自備正確 pubkey → 獨立驗證成立」,pubkey 的可信分發/釘選 = P4。
  - WASM verifier 的 browser 端 demo = 後續(DV2 用 standalone binary)。
  - integrateWithPersonal/Enterprise = DVx;Python plane = DV4。

## (4) Design delta + 依賴方向
- 純加 `publicKeyPem` helper + gated e2e + harness;**不改 DV1 的 runTool/WORM/verifyEvidenceChain 核心**(只暴露 pubkey + 真 binary 接上)。verifyEvidenceChain 既有 spawn-relay 不變(DV1 已 process-boundary、不 import Go)。
- 依賴經 barrel;無 vendor 進 core;harness 在 `scripts/`。
- **PUBLIC**:`DeveloperKit.publicKeyPem()`;`e2e:live-developer` 語意。

## (5) Test-first plan（RED 先行）
- 單元(hermetic):`publicKeyPem()` 導出合法 PEM、不含私鑰;在 helper 實作前紅。
- **gated live e2e(我跑)**:build verifier → checksum → author/run → verify intact(exit 0)→ tampered(broken)→ wrong-pubkey(非零)。RED = pubkey helper/harness 未建前型別/檔案錯。
- 首次 RED:`publicKeyPem` 不存在 → 型別錯;harness 不存在。

## (6) Definition of Done（實測）
- [x] RED:`Property 'publicKeyPem' does not exist`(TS2339)+ `kit.publicKeyPem is not a function` → 實作前紅。
- [x] `pnpm run verify` **exit 0**(883 passed + 14 skipped;DV1 e2e〔6〕+ 既有 byte-unchanged;publicKeyPem 單元〔2〕綠;live e2e gated skip〔3〕;depcruise 133 modules clean;secret-scan clean;verify:cross-tenant 綠)。
- [x] **LIVE(我跑 + reviewer 親自 re-ran)`pnpm run e2e:live-developer` 3/3**:`verifier:release` build 真 `kernel/cmd/verifier` + **checksum 校驗對 SHA-256SUMS 通過**(verifier-darwin-arm64 35b0b451…)→ kit TS signed 鏈 `verifyEvidenceChain` → **{ok:true} intact(真 Go verifier 驗 TS 鏈 = 跨語言 byte-match 實證,canonicalization 風險已解)**。
- [x] **tamper 非 vacuity**:flip entry0.entryHash → 真 verifier **嚴格 exit 1(broken)**(斷言 entryHash≠original + status===1,非 0/2;用 kit 確切鏈 bytes)。
- [x] **wrong-pubkey**:第二把 keypair pubkey → `{ok:false}`(trust-root 綁作者 pubkey)。
- [x] `publicKeyPem` 導 SPKI public-only(reviewer mutation:改 PKCS8 private → no-leak 單元紅);`verifyEvidenceChain` byte-for-byte 不變、仍不 import Go(DV1 moat-invariant 綠);credential-blind。
- [x] **誠實標記**:驗 live kernel 鏈 = 後續(kernel UNSIGNED,P2R-PV-S3a;DV2 護城河用 kit 自簽鏈);pubkey trust-root 外部化/KMS = P4;WASM browser demo = 後續。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8 親 re-ran live 自證 byte-match;non-vacuity 全 bite:PKCS8→RED、checksum mismatch→e2e 前 exit 1、all-skipped guard→exit 1、tamper→嚴格 exit 1)。
> **provenance gate(reviewer 親測 bite)**:harness 重算 binary SHA-256 對 `SHA-256SUMS`,mismatch/absent → **exit 1,在設 AGENTOS_VERIFIER_BIN/跑 e2e 之前**,絕不跑未驗證 binary;+ non-vacuity guard(all-skipped vitest exit 0 → harness 判 FAIL)。

## (7) Rollback
- `git revert <merge-sha>`(移除 pubkey helper + e2e + harness)。DV1 核心不受影響、可逆。

## (8) Depends-on / blocks
- Depends-on:DV1(createDeveloperKit + verifyEvidenceChain spawn-relay)、R9-S5(verifier release + SHA-256SUMS)、P1-S7(TS↔Go conformance,使 TS 鏈可被 Go verifier 驗)。
- Blocks:無(護城河 live 完成;DV3 forensic 端點、DV4 Python、DVx integrate、驗 live-kernel-鏈〔待 P2R-PV-S3a〕為後續)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:DV2 證 kit 的 signed 鏈被真 verifier 跨語言驗證 + tamper/wrong-pubkey;驗 live kernel 的鏈(待 kernel signed read-back)、pubkey trust-root 外部化、WASM browser = 後續/P4。
