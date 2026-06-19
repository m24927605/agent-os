# SLICE-P1-006a: gRPC/protobuf runtime + protoc codegen + `proto/` skeleton + `proto:check`（依賴-only，零行為）

- **Phase**: P1（roadmap §3.1 Go evidence kernel）。**依賴先行 slice**：把 gRPC/protobuf 工具鏈與依賴立起來，**不寫任何 server/client 行為**（行為在 P1-S6）。
- **Branch**: slice/p1-006a-grpc-protobuf-runtime-codegen
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 0.5 day；net LOC <~80 hand-written（`proto/ingest.proto`、`scripts/proto-gen.sh`、`scripts/proto-check.sh`、`.golangci.yml`/`package.json` 增補；generated `*.pb.go` 不計入 hand-written），新增第三方 Go 依賴 = grpc-go + protobuf-go（**本 slice 的全部意義**：依賴變更與行為變更分屬不同 slice，slice-spec §4）。

> EXECUTION-TIME EVIDENCE / only-command-output-is-truth：§5/§6 transcript 為樣板，實作期以真實 exit code 覆蓋。

## (1) ID + Title
SLICE-P1-006a — 定義 append-only 的 gRPC ingest **proto 契約**（`proto/ingest.proto`：只有 `Append` RPC，**無** update/delete/rewrite），以 protoc + protoc-gen-go/-go-grpc **codegen** 出 `kernel/internal/ingestpb/`，把 grpc-go + protobuf-go 加進 `kernel/go.mod`，並提供 `proto:gen`（重產）+ `proto:check`（偵測 generated 與 `.proto` 漂移）。**零行為**（不寫 server/client 邏輯）。

## (2) Goal（一句話）
建立 gRPC/protobuf 的依賴與 codegen 基礎，使 P1-S6 能在其上只寫**行為**——且 proto 契約在型別層即為 **append-only**（無改寫 RPC）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `proto/ingest.proto`：`package agentos.kernel.ingest.v1;`。`service AppendService { rpc Append(AppendRequest) returns (AppendReceipt); }`（**唯一** RPC）。`AppendRequest { string source_id; uint64 source_seq; string content_hash; bytes canonical_event; }`、`AppendReceipt { uint64 sequence; string prev_hash; string entry_hash; bool durable; }`。**刻意無** `Update`/`Delete`/`Rewrite`/`Truncate` RPC（append-only by construction 的線傳面）。
  - `kernel/internal/ingestpb/`：protoc 產生的 `ingest.pb.go` + `ingest_grpc.pb.go`（committed；置 `internal/` 使外部 module 無法直接 import 生成型別、僅經 P1-S6 的 server/client 包裝）。
  - `kernel/go.mod`：新增 `google.golang.org/grpc` + `google.golang.org/protobuf` require（codegen 後 `go mod tidy`）。
  - `scripts/proto-gen.sh`：`protoc --go_out --go-grpc_out` 重產到 `kernel/internal/ingestpb/`。
  - `scripts/proto-check.sh`：toolchain（protoc + 兩個 plugin）存在則重產到 temp + 與 committed diff（**漂移 → exit≠0**）；toolchain 缺則 **skip exit 0**（CI-env 供裝為環境步驟，呼應 verify:go cascade 哲學）。`package.json` 把 `proto:check` 串進 `verify`。
  - `.golangci.yml`：排除 generated `*.pb.go`（生成碼非手寫慣例，lint 例外；issues exclude-rules / skip pattern）。
- Out-of-scope（留 P1-S6）：任何 gRPC **server 實作**（Append handler 落地到 outbox/store/sequence）、**client**、kernel 作為**獨立進程**、append-only enforcement 的**行為測試**、跨進程整合測試。

## (4) Design delta + modules + 依賴方向
- Delta：在零依賴的 `kernel/` module 上，新增 gRPC/protobuf 依賴 + generated proto 型別。**狀態機/行為差 = 無**（純依賴 + 生成碼）。
- Modules：`proto/`（契約根，跨 plane proto 真相）、`kernel/internal/ingestpb/`（生成型別，唯一責任=承載線傳契約型別）。
- 依賴方向：`ingestpb` → grpc-go/protobuf-go（外部，inward 合理；非 agent-os 跨 plane，不違反 kernel-no-cross-plane）。無 cycle。生成碼不 import kernel 其他 internal。
- depguard：`kernel-no-cross-plane` 三條跨 plane deny 沿用（grpc/protobuf 非 agent-os 路徑，允許）。本 slice **不**新增 deny rule（無 internal 反向邊）。

## (5) Test-first plan（RED 先行）
- RED（實作前）：`scripts/proto-check.sh` 在 generated 缺失時 exit≠0；`kernel/internal/ingestpb` 不存在 → `go build ./...` 失敗。
- 一條 compile-time 契約測試 `kernel/internal/ingestpb/surface_test.go`：以反射斷言 `AppendService_ServiceDesc.Methods` **長度為 1 且名為 `Append`**（證明線傳面 append-only：無 update/delete RPC）。RED = 套件不存在 → build fail；GREEN = codegen 後通過。
- 首次紅燈（樣板，實作期覆蓋）：
  ```
  $ cd kernel && env -u GOROOT CGO_ENABLED=0 go test ./internal/ingestpb/...
  no Go files in .../internal/ingestpb   (or undefined: AppendService_ServiceDesc)
  exit code: 1
  ```

## (6) Definition of Done（指令證據）
- [ ] Test-first：surface_test RED 早於 codegen。
- [ ] `pnpm run verify` exit 0（含 `verify:go`：`go vet && go test && golangci-lint`，generated 已排除 lint；含 `proto:check`：無漂移）。
- [ ] `cd kernel && go test ./internal/ingestpb/...` exit 0：`AppendService` 只有 `Append` 一個 method（append-only 線傳面，compile-time + 反射斷言）。
- [ ] `scripts/proto-check.sh`：committed generated 與 `proto/ingest.proto` 無漂移（重產 + diff exit 0）；toolchain 缺則 skip exit 0。
- [ ] low coupling：generated 在 `internal/`，外部不可 import；無新跨 plane import；deps:check（TS）綠。
- [ ] secret-scan clean；proto/generated 無 secret。
- [ ] Docs：本 doc + `kernel/README.md` 增一行「P1-S6a：gRPC/protobuf 依賴 + 生成的 append-only ingest proto；server/client 行為在 P1-S6」。
- [ ] Adversarial review = PASS（主攻：proto 是否真 append-only-only；generated 是否與 .proto 同步；依賴是否僅 grpc/protobuf、無夾帶；coupling）。

## (7) Rollback
`git revert <merge-sha>`：移除 `proto/`、`kernel/internal/ingestpb/`、scripts、go.mod 的 grpc/protobuf require（`go mod tidy`）。純依賴+生成碼，無持久化、無外部副作用，安全可逆。

## (8) Depends-on / blocks
- Depends-on：**P1-S1**（kernel module + enforcing verify:go）、**P1-S2**（content_hash/canonical 契約，proto 欄位語義對齊）。
- Blocks：**P1-S6**（gRPC ingest 行為——server/client/獨立進程，建在本 slice 的生成型別與依賴上）。
- DAG 無 cycle：☑（INDEX `P1-S6a -> {P1-S2}`；P1-S6 -> {P1-S6a, ...}）。

*本檔不含 secret-like 值；綠/通過欄位實作期以真實 exit code 覆蓋；與 AGENTS.md 衝突以 AGENTS.md 為準。*
