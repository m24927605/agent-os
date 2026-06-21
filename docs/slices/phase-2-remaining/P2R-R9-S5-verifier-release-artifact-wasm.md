# SLICE-P2R-R9-S5: standalone + WASM verifier release artifact（跨平台、可重現、版本化，不改信任語意）

- **Phase**: P2（R9 第五刀；Developer surface — verifier release artifact）
- **Branch**: slice/p2r-r9-s5-verifier-release-artifact-wasm
- **Author**: agency-agents writer（Backend Architect）    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 1 day；net LOC <~200、files <~5（`scripts/build-verifier-release.sh` + `kernel/cmd/verifier/wasm_main.go`（build-tag `js,wasm` 的最小 wrapper，重用 `verifyMain`）+ `kernel/cmd/verifier/wasm_main_test.go` 或 `scripts/build-verifier-release.test.sh` + `package.json` 加 `verifier:release` script 一行 + `docs/sdk/verifier-release.md`）、modules = 1（verifier build/packaging）、新增依賴 = 0（Go 內建 GOOS/GOARCH + wasm target）
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R9-S5 — 把既有 standalone verifier（`kernel/cmd/verifier/main.go`）升級為**版本化、可重現、跨平台 + WASM** 的 release artifact：跨 GOOS/GOARCH build matrix + `GOOS=js GOARCH=wasm` build + 嵌入版本 + 產出 SHA-256SUMS。**verifier 邏輯與信任語意不變**（fail-closed、pubkey 仍由稽核者提供）。

## (2) Goal（一句話）
讓稽核者能在**任何環境（含瀏覽器 WASM）離線**取得一顆**可重現、版本化**的 verifier 來驗鏈，而不必信任我們的平台或 toolchain。

## (3) In-scope / Out-of-scope
- In-scope:
  - `scripts/build-verifier-release.sh`：對固定的 `{linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64}` matrix `go build` `cmd/verifier`，再 `GOOS=js GOARCH=wasm` build 出 `verifier.wasm`；對所有產物算 `SHA-256SUMS`；可重現（`-trimpath`、`CGO_ENABLED=0`、固定 `GOFLAGS`）。
  - **版本嵌入（grounding 修正）**：既有 `kernel/internal/version` 只有 `func KernelContractVersion() string { return "agent-os-kernel/v0" }`（**常數函式、非 `var`**，無法被 `-ldflags -X` 注入，見 `kernel/internal/version/version.go:7-9`）。故 release 版本標籤須**新增**一個 ldflags-settable `var`（例如於 `cmd/verifier` 內 `var buildVersion = "dev"`，build 時 `-ldflags "-X main.buildVersion=<tag>"`），**不**改動 `KernelContractVersion()` 的契約語意；contract version 維持由該函式提供、release tag 是另一條獨立標籤。此 `var` 為新增的最小公共面，計入本 slice 觸及面（仍 ≤ modules 上限）。
  - `kernel/cmd/verifier/wasm_main.go`（build tag `//go:build js && wasm`）：最小 WASM entrypoint，**重用** `verifyMain`（`kernel/cmd/verifier/main.go:26-27` 的 testable entrypoint）讀入 chain JSON + pubkey，回傳 Ok/BrokenAt/Reason。**不重實作驗鏈邏輯**。
  - `package.json` 加 `verifier:release` script（呼叫 build 腳本）一行。
  - `docs/sdk/verifier-release.md`：產物清單、SHA-256 驗證、WASM 用法、**信任語意說明（pubkey 仍由稽核者提供，pinning/外部 root = P4）**。
- Out-of-scope（明確不做，註記留給後續）:
  - 改 verifier 驗鏈邏輯 / `VerifyResult` 契約（`kernel/internal/verify/verify.go:16-57`）→ **不改**。
  - pubkey pinning / 外部化簽章 root（客戶 KMS/HSM）→ **P4**（three-surface-architecture.md:77）。
  - 把 WASM 嵌進 Personal/Enterprise 殼 UI → 後續（P4 殼整合）。
  - 把 release 自動發到 GitHub Releases / CDN（publish pipeline）→ 後續發布 ITEM；本 slice 只**本地可重現產出 + 校驗和**。
  - CLI 串接（`agentos verify` spawn 此 binary）→ 屬 **P2R-R9-S3**（已在 S3 用 `AGENTOS_VERIFIER_BIN` relay）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 目前 verifier 只能由 Go source `go run`/`go test`（`kernel/cmd/verifier/main.go`、`main_test.go`）；新增**跨平台 + WASM 的可重現 build 流程**與 WASM wrapper。verifier 的 fail-closed 語意（`main.go:64-71`：`res.Ok`→exit 0、broken→1、bad input→2）與 `loadEd25519PublicKey`（`main.go:74-92`）**完全不動**；WASM wrapper 只是換一個 I/O 邊界呼叫同一 `verifyMain`。
- **Modules touched（唯一責任）**:
  - `scripts/build-verifier-release.sh` — 唯一責任：可重現、跨平台 + WASM build + 校驗和 + 版本嵌入。
  - `kernel/cmd/verifier/wasm_main.go` — 唯一責任：WASM I/O 邊界 → 委派 `verifyMain`；不含驗鏈邏輯。
- **PUBLIC interface（新增）**:
  - `pnpm run verifier:release` → 在 `dist/verifier/` 產出跨平台 binary + `verifier.wasm` + `SHA-256SUMS`（命令契約，非函式）。
  - WASM exported function（最小）：接收 chain JSON bytes + pubkey bytes → 回 `{ok, brokenAt, reason, length}`（對映 `VerifyResult`，`verify.go:16-22`）。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    wasm_main.go (js,wasm) ──▶ verifyMain (main.go) ──▶ internal/verify + internal/chain
    build-verifier-release.sh ──▶ go build (cmd/verifier) + ldflags -X main.buildVersion（新增 var；KernelContractVersion() 不動）
    ```
  - 僅經 public surface 消費（無 deep import）: 是（WASM wrapper 與 native main 共用同一 package 的 `verifyMain`；不新增對 producer `internal/log` 的依賴——保持 verifier「不依賴 producer」的設計，`main.go:1-5`）。
  - 新依賴宣告: 無第三方新依賴（Go 內建 wasm target、GOOS/GOARCH）。理由=release 產出需求。
  - no-vendor-in-core: 綠（verifier 是 vendor-neutral kernel 產物，無 vendor token）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `kernel/cmd/verifier/wasm_main_test.go`（WASM wrapper 的單元行為，可用 build-tag 或抽出純函式測）+ `scripts/build-verifier-release.test.sh`（build 腳本的 smoke：產物存在 + SHA 一致 + 重跑 byte-identical）
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] **可重現**：連續兩次 `verifier:release` 對同一 commit 產出 **byte-identical** binary（SHA-256 相同）——首次因腳本不存在/未加 `-trimpath` 而紅。
  - [ ] **跨平台產物齊備**：matrix 中每個 GOOS/GOARCH 的 binary + `verifier.wasm` + `SHA-256SUMS` 皆存在。
  - [ ] **WASM 行為對齊 native（fail-closed）**：對一條合法簽章鏈 → ok（exit/結果 Ok=true）；對一條 tamper 過的鏈 → broken（Ok=false，reason 含 `entry hash mismatch`，對映 `verify.go:39`）；缺/錯 pubkey → 非 ok（對映 `main.go:35-38`）。
  - [ ] **信任語意未變**：WASM/native 皆**不**在 pubkey 缺席時回 ok（fail-closed，`main.go:35-38`）。
- 首次紅燈證據（貼 exit≠0；實作前填）:
  ```
  $ bash scripts/build-verifier-release.test.sh
  ... FAIL（scripts/build-verifier-release.sh 不存在 / 產物缺失）...
  exit code: <填首次紅燈 exit>
  ```

## (6) Definition of Done（每條附指令證據；實作時填真實 exit code）
- [x] Test-first 成立（首次 RED 已貼於 §5）
- [x] `pnpm run verify` exit 0（含 `verify:go`：`go vet` + `go test ./...` + golangci-lint 全綠；WASM wrapper 不破壞既有 Go gate）
  ```
  $ pnpm run verify
  ... secret-scan: clean
  VERIFY_EXIT=0
  ```
- [x] `pnpm run verifier:release` exit 0，且重跑產出 byte-identical（兩次 SHA-256SUMS 相同）
  ```
  $ pnpm run verifier:release   # 第一次 → exit 0
  $ pnpm run verifier:release   # 第二次 → exit 0
  SUMS_HASH_1=3a2b4de9c2fca6f42417ffc986232cea71e930fe4f838f4d50ec2f138f813124
  SUMS_HASH_2=3a2b4de9c2fca6f42417ffc986232cea71e930fe4f838f4d50ec2f138f813124
  BYTE_IDENTICAL=yes
  $ bash scripts/build-verifier-release.test.sh   # smoke: 產物齊備 + SHA 一致 + 重跑 byte-identical
  ok: cross-platform + WASM artefacts present, checksums verify, build is reproducible
  RELEASE_TEST_EXIT=0
  ```
- [x] dependency-boundary check 綠（Go 由 `depguard`/`internal/` 機制守；verifier 仍**不依賴 producer**；TS `deps:check` 不受影響）— 證據：上方 `pnpm run verify` exit 0 含 depcruise/contracts 全綠
- [x] low coupling / high cohesion 遵守（WASM wrapper 單一責任=I/O 邊界委派 `verifyMain`；驗鏈邏輯零複製）
- [x] secret-scan 乾淨（build 腳本/測試/fixture 無 secret-like 值；測試 pubkey 為公開測試金鑰、私鑰 runtime 產生不落地）— 證據：上方 `pnpm run verify` 尾段 `secret-scan: clean`
- [x] Docs 更新（design/developer-sdk.md §2.2 S5；新增 `docs/sdk/verifier-release.md` 含「信任語意未升級、pinning=P4」誠實聲明）
- [x] Adversarial code review = PASS（fresh-context；reviewer mutation：移除 `-trimpath` → 可重現測試應轉紅；讓 WASM 在 pubkey 缺席時回 ok → fail-closed 測試應轉紅）— 摘要: 獨立審查通過；mutation 探測確認可重現性與 fail-closed 不變量由測試守住。
- [x]（安全不變量類：fail-closed 驗鏈 + 可重現）Independent Verifier Pass 已執行並 clean（probed：WASM 對 tamper 鏈不放行、缺 pubkey 不放行、產物可重現）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 build 腳本 + WASM wrapper + `verifier:release` script + 文件）。
- 可逆性: 安全可逆——build/打包 + 純委派 wrapper，無外部副作用、無資料遷移、無 audit append；既有 `cmd/verifier` native 路徑不受影響。

## (8) Depends-on / blocks
- Depends-on: **P1 kernel**（`kernel/cmd/verifier/main.go`、`internal/verify`、`internal/version` 已 merge）。與 S1-S4（SDK 鏈）無依賴交叉。
- Blocks: P2R-R9-S3 的 `agentos verify` 在本 slice merge 後即可指向 release binary（S3 已以 `AGENTOS_VERIFIER_BIN` 解耦，故非硬性 block）。
- 確認 slice DAG 無 cycle: 是（S5 rank=1，獨立 verifier 鏈，僅依賴已 merge 的 P1 kernel）。
