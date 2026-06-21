# Verifier release artifact（standalone + WASM，可重現、版本化）

> SLICE-P2R-R9-S5。權威設計見 [`docs/design/developer-sdk.md`](../design/developer-sdk.md) §2.2 S5。
> **only command output is truth**：本文件的「綠/通過」宣稱以 `pnpm run verify` exit 0 + `pnpm run verifier:release` 的實際產物為準。

## 這是什麼

`kernel/cmd/verifier`（[`main.go`](../../kernel/cmd/verifier/main.go)）是稽核者**信這顆小 binary 而不信我們平台**的 standalone evidence-chain verifier：它只依賴 `internal/verify` + `internal/chain`、**從不**依賴 producer（`internal/log`），fail-closed（鏈不完整驗證就**絕不** exit 0）。

本 release 流程把它升級為**版本化、可重現、跨平台 + WASM** 的對外產物，讓稽核者能在**任何環境（含瀏覽器、離線）**取得一顆可信賴的 verifier 來驗鏈——而**不必信任我們的 toolchain 或平台**。

**verifier 的驗鏈邏輯與信任語意完全不變**：Ed25519 public key 仍由**稽核者**在驗證時提供；本刀只改 build / 打包。

## 產出

```bash
pnpm run verifier:release
```

在 `dist/verifier/` 產出（`dist/` 已 gitignore，不入庫）：

| 產物 | 平台 |
|---|---|
| `verifier-linux-amd64` | Linux x86-64 |
| `verifier-linux-arm64` | Linux ARM64 |
| `verifier-darwin-amd64` | macOS Intel |
| `verifier-darwin-arm64` | macOS Apple Silicon |
| `verifier-windows-amd64.exe` | Windows x86-64 |
| `verifier.wasm` | 瀏覽器 / 任何 WASM host（離線可跑） |
| `SHA-256SUMS` | 對上列所有產物的 SHA-256 校驗和（排序、穩定） |

版本標籤透過 `-ldflags -X main.buildVersion=<tag>` 嵌入（預設取 `git describe`；可用 `VERIFIER_VERSION=<tag>` 覆寫）。查版本：`./verifier-<os>-<arch> --version`。

> **版本標籤 ≠ 契約版本**：release tag 標識「產物」；鏈的**契約版本**仍由 `internal/version.KernelContractVersion()`（`agent-os-kernel/v0`）獨立提供，本刀**不**動它。

## 可重現（reproducible）

build 對同一 commit 兩次產出 **byte-identical** binary（相同 `SHA-256SUMS`）。靠：

- `-trimpath`（移除絕對 build 路徑）
- `CGO_ENABLED=0`（不依賴 host C toolchain）
- `-ldflags "-s -w -buildid="`（移除非決定性 buildid）
- `GOFLAGS=-mod=readonly`、`GOTOOLCHAIN=local`（鎖 toolchain）
- **決定性版本標籤**（git commit，**非** wallclock 時間戳）

驗證可重現：連跑兩次 `pnpm run verifier:release`，比對兩次 `dist/verifier/SHA-256SUMS` 相同（smoke 由 [`scripts/build-verifier-release.test.sh`](../../scripts/build-verifier-release.test.sh) 守）。

## 校驗產物

```bash
cd dist/verifier && shasum -a 256 -c SHA-256SUMS
```

## 用法

### Native CLI

```bash
./verifier-darwin-arm64 --chain chain.json --pubkey auditor-pub.pem
# exit 0 = 鏈完整；exit 1 = 鏈破損（reorder/tamper/gap/簽章無效）；exit 2 = 輸入無法解析 / 缺/壞 pubkey
```

### WASM（瀏覽器 / Node，離線）

載入 Go 的 `wasm_exec.js`（隨 Go 發行）+ `verifier.wasm`，instantiate 後呼叫全域函式：

```js
const r = globalThis.agentosVerifyChain(chainJsonString, pubKeyPemString);
// r = { ok: boolean, length: number, brokenAt: number, reason: string }
// 對映 internal/verify.VerifyResult（verify.go:16-22）
```

WASM entrypoint（[`wasm_main.go`](../../kernel/cmd/verifier/wasm_main.go)）**只是 I/O 邊界**：委派同一個 `verifyChainBytes`（[`verify_bytes.go`](../../kernel/cmd/verifier/verify_bytes.go)），**零驗鏈邏輯複製**。fail-closed：缺參數 / 壞 pubkey / 無法解析的鏈 → `ok:false`，**絕不**回 `ok:true`。

## 信任語意（誠實聲明）

- **pubkey 仍由稽核者提供**：本刀**不**做 pubkey pinning，也**不**外部化簽章 root（客戶 KMS/HSM）。
- **pubkey pinning / 外部化 root = P4**（見 [`docs/design/three-surface-architecture.md:77`](../design/three-surface-architecture.md)）——本 R9 **不宣稱**信任 root 升級。
- 本刀只解「**可重現、版本化、可在任何環境離線跑**」，不過度宣稱信任升級。

## Out-of-scope（本刀不做，留後續）

- 自動發到 GitHub Releases / CDN（publish pipeline）。
- 把 WASM 嵌進 Personal / Enterprise 殼 UI（P4 殼整合）。
- 改 verifier 驗鏈邏輯 / `VerifyResult` 契約。
