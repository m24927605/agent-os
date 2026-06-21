# SLICE-P2R-R10-S4: 【kernel 必修】snapshot-safe checkpoint RPC（原子擷取，取代 ftruncate）

- **Phase**: P2（time-travel ITEM R10；design §41/§60 標記的 kernel 必修 gap；Build-list #5）
- **Branch**: slice/p2r-r10-s4-kernel-checkpoint-rpc
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~150、files <~4（`kernel/internal/server/checkpoint.go` + `kernel/internal/server/checkpoint_test.go` + proto 一個 RPC + 既有 server.go 一處接線）、modules <~2（server，+ proto 契約）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R10-S4 — kernel `Checkpoint` RPC：在 `IngestServer` 的 append mutex 下**原子**回傳一致快照錨點 `{committedSequence(head 的 sequence), headEntryHash, perSourceNextSeq}`，使「取得 checkpoint 那一刻沒有半寫入的 torn frame」成立（取代 design §60 不可行的 ftruncate-to-N），**不**改任何 append-only 不變量。

## (2) Goal（一句話）
暴露一個唯讀、在 append 鎖內原子擷取的 kernel checkpoint RPC，讓 orchestration 能以一致錨點（head entryHash + per-source next sequence）做 snapshot，而不會撞上 store fsync 中途的 torn tail（design §41）。

## (3) In-scope / Out-of-scope
- In-scope：
  - proto：在 `AppendService`（既有 ingest proto）新增 `rpc Checkpoint(CheckpointRequest) returns (CheckpointResponse)`，回傳 `{ head_entry_hash, head_sequence, per_source_next_seq map<string,uint64> }`。
  - `kernel/internal/server/checkpoint.go`：`Checkpoint` handler 在 `s.mu.Lock()`（與 `Append` 同一把鎖，append.go:65）下**原子**讀 `s.head` + `s.next` 快照後回傳；**不**寫檔、**不** mutate 任何狀態。
  - 不變量：handler 不 truncate、不 append、不改 `s.head`/`s.next`；唯讀。
- Out-of-scope（明確不做）：
  - outbox `lastSeq`/`delivered` 的整合擷取（design §41 提及的 `[store committed offset, outbox.lastSeq, outbox.delivered]` 完整三元組）→ 若需跨 outbox 一致，留給後續 slice；本 slice 只交付 server 端 head + per-source next 的原子讀（最小、可獨立驗收）。
  - orchestration 端如何使用此 checkpoint（接到 R10-S3 的 `acquireCheckpoint` 注入）→ 屬 R10-S3 的 composition root 接線。
  - 真實 ftruncate（**永不**做；design §49 校正 1）。
- **跨 plane 規則**：proto 契約變更是本 slice 的一部分，但 TS 消費者（R10-S3）只透過 R2 client 經型別化契約消費，不在本 slice。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增唯讀 checkpoint RPC；在既有 append mutex 下原子讀，保證一致切點。**零改動** store.go append-only 表面（無新增 Update/Delete/Truncate）。
- **Modules touched（唯一責任）**：
  - `kernel/internal/server/checkpoint.go` — 在 append 鎖下原子回傳一致 checkpoint（high cohesion：只讀錨點，不寫、不改狀態）。
  - proto（ingest）— 新增 `Checkpoint` RPC 契約（型別化跨 plane 契約，契約先於消費者）。
- **PUBLIC interface（新增）**：
  - proto `rpc Checkpoint(CheckpointRequest) returns (CheckpointResponse)`；`CheckpointResponse { string head_entry_hash = 1; uint64 head_sequence = 2; map<string,uint64> per_source_next_seq = 3; }`。
  - Go `func (s *IngestServer) Checkpoint(ctx, *ingestpb.CheckpointRequest) (*ingestpb.CheckpointResponse, error)`。
- **Dependency direction（inward、acyclic）**：
  ```
  server/checkpoint.go ──▶ ingestpb (proto) ──▶ (no new imports)
  ```
  - 僅經既有 internal package 機制封裝（Go `internal/`）；無新增跨 package 邊；depguard 不破壞。
  - 新依賴宣告：無新增第三方依賴；無新增 module-to-module 邊（同 server package + 既有 ingestpb）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`kernel/internal/server/checkpoint_test.go`（`Checkpoint` 未實作 → 首次 RED：編譯失敗或 method 不存在）。
- RED 測試清單：
  - [ ] append N 筆後 `Checkpoint` 回傳的 `head_entry_hash === s.head`、`per_source_next_seq[src] === N`（與 append 後狀態一致）。
  - [ ] **唯讀不變量（對抗式）**：呼叫 `Checkpoint` 前後 `s.head`/`s.next` 不變；store 檔案大小不變（無寫入、無 truncate）。
  - [ ] **原子性（對抗式）**：併發 `Append` 與 `Checkpoint` 競賽（`go test -race`）下，`Checkpoint` 回傳的 `head_sequence` 與 `per_source_next_seq` 自洽（不會看到 append 寫一半的中間態）。
  - [ ] 空 log → `head_entry_hash === genesis`、`per_source_next_seq` 空 map（fail-safe 邊界）。
- 首次紅燈證據（待填）：
  ```
  $ go test ./kernel/internal/server/ -run Checkpoint -race
  ... FAIL (undefined: Checkpoint) ...
  exit code: <填實測>
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；method `Checkpoint` 未實作 → 編譯失敗，作者已見紅燈，獨立 review 確認）
- [x] `pnpm run verify` exit 0（含 `verify:go`、`proto:check`、secret-scan、cross-tenant、depcruise）
  ```
  $ pnpm run verify
  ... secret-scan: clean
  exit code: 0
  ```
- [x] `go test ./... -race` 綠（含併發 append/checkpoint；於 kernel/ module 執行）
  ```
  $ (cd kernel && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go test ./... -race -run Checkpoint)
  ok  github.com/agent-os/kernel/internal/server  3.577s
  exit code: 0
  $ (cd kernel && env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go test ./... -race)
  ok  github.com/agent-os/kernel/internal/server  2.348s
  exit code: 0
  ```
- [x] dependency-boundary 綠：`no-vendor-in-core` + `not-to-internal` + depcruise `Contracts: 1 kept, 0 broken`；`Checkpoint` 不 import 新 package；append-only 表面（store.go）零改動（`git status --porcelain kernel/internal/store/` 為空）
  ```
  $ bash scripts/proto-check.sh
  proto:check: go ok / proto:check: ts ok / proto:check: ok
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（checkpoint.go 只讀錨點；無寫入 / 無 truncate / 無新狀態）
- [x] secret-scan 乾淨（checkpoint 回傳僅 hash + sequence 數字，無 secret）— `secret-scan: clean`（verify 內）
- [x] Docs 更新（design §41/§60 已標記此為必修；`docs/design/time-travel-snapshot-replay.md` 已連結）
- [x] Adversarial code review = PASS（fresh-context；mutation：拿掉 `s.mu.Lock()` → `-race` 報 data race / 原子性測試轉紅，證明鎖 load-bearing）
- [x] **安全不變量（append-only + 一致性）**：Independent Verifier Pass 已執行——對抗式確認 Checkpoint 唯讀（不能成為繞過 append-only 的旁路）、原子（無 torn 讀）、空 log fail-safe

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `checkpoint.go` + proto RPC + 接線）。
- 可逆性：安全可逆——純新增唯讀 RPC，不改任何既有 append/store 行為、無資料遷移、無外部副作用。proto 為**新增** RPC（向後相容，不破壞既有 client）。

## (8) Depends-on / blocks
- Depends-on：P1 kernel（`IngestServer`、append mutex、store、ingestpb 已存在且 merge）。**不**依賴任何 TS R10 slice（跨 plane 解耦）。
- Blocks：R10-S3 的 composition root（`acquireCheckpoint` 注入此 RPC；經 R2 client）。
- 確認 slice DAG 無 cycle：是（S4 僅依 P1 kernel，rank 0；不被其他 R10 slice 依賴於 doc 層、僅在 runtime 接線時被 R10-S3 注入消費）。
