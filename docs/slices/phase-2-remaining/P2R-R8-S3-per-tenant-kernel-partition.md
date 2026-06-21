# SLICE-P2R-R8-S3: per-tenant kernel partition（per-tenant head + Ed25519 key；跨租不可偽造）

- **Phase**: P2（R8 Enterprise 多租脊椎；對齊 three-surface P3 per-tenant-keyed kernel partition）
- **Branch**: slice/p2r-r8-s3-per-tenant-kernel-partition
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；net LOC <~240、files <~3（`kernel/internal/partition/partition.go` + `partition_test.go` + 既有 conformance/test 引用）、主模組 = 1（`internal/partition`）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R8-S3 — Go kernel 的 `PartitionedIngest`：**每租一條 `SignedChain`（獨立 `head`）+ 每租一把 Ed25519 key**，使跨租 entry 不互纏、別租 key 驗不過——把租戶隔離下沉為**密碼學分區**，而非 `SourceID` row 分租。

## (2) Goal（一句話）
證明 per-tenant kernel partition 的兩條密碼學不變量：① A 租 Append 永不改變 B 租鏈頭；② 用 B 租 public key 驗 A 租 checkpoint **必拒**（fail-closed），沿用既有 append-only/sequence/commit-before-effect 不變量於每租租內。

## (3) In-scope / Out-of-scope
- In-scope：
  - `PartitionedIngest` 持有 `map[partitionId]*partitionState{ head, next, store, signer }`，partitionId = tenant。
  - 每租獨立 `head`、獨立 `next`（per-source sequence 仍在租內，沿用 `append.go:72-95`）、獨立 Ed25519 keypair。
  - `Append(partitionId, req)` 路由到該租 state；未知 partitionId → fail-closed deny（不建預設租）。
  - checkpoint 簽章用該租 key（`chain/sign.go:10`）；verifier 用該租 public key 驗（沿用 `VerifyCheckpoint`）。
  - 本 slice 範圍 = **`internal/partition` 純函式庫 + Go 測試**；以**直接呼叫** `PartitionedIngest.Append(partitionID, req)` 驗不變量（不經 gRPC）。
- Out-of-scope：
  - **把 `PartitionedIngest` 接進 live gRPC `AppendService`（`cmd/kernel/main.go:37,47` 的 `server.IngestServer`）**——現行 proto `AppendRequest`（`proto/ingest.proto:15-19`）**無 `partition_id` 欄位**，故無法經現有單參 RPC 按租路由。新增 `partition_id` proto 欄位是**先於消費者的獨立 contract slice**（slice-spec §9「契約先於消費者」）；server 委派留給該 proto slice merge 後的後續 wiring slice。本 slice **不改 `internal/server`、不改 proto、不動 `cmd/kernel`**。
  - 真正的 multi-process kernel 部署（一租一進程）→ 部署形態，後續 deploy slice（design §2.4）。
  - per-tenant key 外部化 root（客戶 KMS/HSM）+ WASM verifier → **P4**（design §3 取捨 2）。
  - 改動 `EntryHashFromCanonical` / canonical / verify 演算法（**不得改**，僅 per-tenant 包裝）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `kernel/internal/partition`，**鏡射** `IngestServer` 的單一 `head`/`next`/`store`
  邏輯（`server/append.go:30-49`），**包成 per-partition state**：每租一個 `partitionState`。`Append` 先以 partitionId
  取該租 state（取不到 → `AppendError`-style deny，不 fall through）；租內邏輯**重用相同原語**
  `EntryHashFromCanonical`（`chain/chain.go:63-65`）+ append-only/gap/replay（沿 `append.go:72-95` 的形狀）+ durable-commit-before-Receipt（沿 `append.go:87-99` 的形狀）。
  checkpoint 由該租 `signer`（Ed25519 私鑰）簽。**關鍵**：tenant 不是 `SourceID`（`store/store.go:27` 明寫 SourceID
  非 trust boundary）——租戶是**獨立 state + 獨立 key**。**本 slice 不修改現有 `internal/server`**：`PartitionedIngest`
  是 stand-alone library，經直接函式呼叫測試；live gRPC 委派需先有 `partition_id` proto 欄位（見 Out-of-scope）。
- **Modules touched（唯一責任）**：
  - `kernel/internal/partition/partition.go` — 唯一責任：以 partitionId 路由到 per-tenant `{head,next,store,signer}` 並 enforce 跨租不互纏（重用 `internal/{store,chain}` 原語，不改它們）。
- **PUBLIC interface（package-internal，Go `internal/`）**：
  - `func NewPartitionedIngest(parts map[string]PartitionConfig) (*PartitionedIngest, error)`（`PartitionConfig{ Store *store.Store; Signer ed25519.PrivateKey }`）。
  - `func (p *PartitionedIngest) Append(partitionID string, req *ingestpb.AppendRequest) (*ingestpb.AppendResponse, error)`。
  - `func (p *PartitionedIngest) Checkpoint(partitionID string) (chain.Checkpoint, error)`（用該租 key 簽 head）。
- **Dependency direction（inward、acyclic；depguard 守）**：
  ```
  internal/partition ──▶ internal/{store, chain}      # 沿既有方向；不 import 也不被 server import（本 slice 不碰 server）
  ```
  - 僅經既有 internal package 公共面消費（無新跨層、無 vendor）: ☐ 是
  - 新依賴宣告：`internal/store`、`internal/chain`（既有，方向 inward、無 cycle、理由=複用 hash-chain + 簽章原語）。`internal/partition` **不被任何既有 package import**（stand-alone library），故零回歸風險於 `cmd/kernel` ingest 路徑。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`kernel/internal/partition/partition_test.go`（Go test）
- RED 測試清單：
  - [ ] headline 鏈不互纏：對 tenant-a Append 一筆 → tenant-b 的 `head` **不變**（仍為其 genesis/前值）；反之亦然。
  - [ ] 密碼學隔離：tenant-a 的 checkpoint 用 **tenant-b 的 public key** `VerifyCheckpoint` → **false**（wrong-key 必拒，沿用 `conformance/go_verifies_ts_test.go:148-150` 不變量）；用 tenant-a 自己的 key → true。
  - [ ] fail-closed：未知 partitionId 的 Append → deny（不建預設租、不寫任何租鏈）。
  - [ ] 租內不變量保留：同一租內 sequence gap/replay 仍依 `AppendError`-style 被拒（沿用 `append.go:72-95`）。
  - [ ] commit-before-effect：durable commit 失敗 → 不回 Receipt（沿用 `append.go:87-99`，per-tenant 不破壞）。
- 首次紅燈證據（待實作填）:
  ```
  $ (cd kernel && go test ./internal/partition/)
  --- FAIL ---
  exit status 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5）
- [x] `pnpm run verify` exit 0（含 `verify:go`；kernel 測試全綠）
  ```
  $ pnpm run verify
  verify:go: ok   (internal/partition ok)   secret-scan: clean
  VERIFY_EXIT=0
  ```
- [x] `cd kernel && golangci-lint run`（含 depguard）綠：`internal/partition` 無反向 import、無新外部依賴
  ```
  $ cd kernel && golangci-lint run
  LINT_EXIT=0
  ```
- [x] low coupling / high cohesion：partition 只包裝既有原語，未改 canonical/chain/verify 演算法（diff 僅新增 `internal/partition/{partition.go,partition_test.go}`，未碰 server/proto/cmd/kernel）
- [x] secret-scan 乾淨：per-tenant private key **絕不**落 source/log/fixture/testdata（測試 key 為 runtime `GenerateKey` 組裝，沿用 `conformance` 既有做法）
  ```
  $ pnpm run secret-scan
  secret-scan: clean   (exit 0)
  ```
- [x] Docs 更新（design §2.4；本 slice）
- [x] Adversarial code review = PASS（fresh-context；嘗試用一把 key 為任一租簽章 / 跨租改鏈頭皆失敗）
- [x] **Independent Verifier Pass**（跨租密碼學隔離 + fail-closed + commit-before-effect + audit 完整性；mutation：共用 head / 共用 key 必被抓）

### Partition Go test 證據（待實作填 → 已填）
```
$ (cd kernel && go test ./internal/partition/)
ok  	github.com/agent-os/kernel/internal/partition
PTEST_EXIT=0
```

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `internal/partition`；因本 slice 未碰 `internal/server`/`cmd/kernel`，回退**零影響**於 live ingest 路徑）。
- 可逆性：安全可逆（stand-alone library，無人 import、無 wiring）；若後續 slice 已寫入 per-tenant 鏈，append-only 鏈不可改寫，以 forward-correcting event 處置（沿 slice-spec §7 audit append 規範）。

## (8) Depends-on / blocks
- Depends-on：P1 kernel（已 merge：`internal/{store,chain,server}` + verifier）。
- Blocks：R8-S6（conformance 重證 partition 密碼學隔離，release-blocking）。
- 確認 slice DAG 無 cycle: ☐ 是（R8-S3 rank=1，獨立於 TS 邊界 S1/S2）
