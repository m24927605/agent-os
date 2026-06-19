# SLICE-P1-006: gRPC ingest proto + kernel 作為獨立進程 + append-only client（control plane 無法改寫已 append 紀錄）

- **Phase**: P1（roadmap §3.1「Go Evidence Kernel — 先簡後繁」；對應 HARD CONSTRAINT A：kernel ≠ control plane，不同進程/身分/語言，僅經 proto）
- **Branch**: slice/p1-006-grpc-ingest-proto-kernel-separate-process-append-only-client
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget（行為-only，依賴/工具鏈已移到 P1-S6a）**: 估計 <= 1 day；預期 net LOC <~240（不含 generated stub / lockfile；**不含 P1-S6a 的工具鏈/依賴設定**）、files <~7（`proto/ingest.proto` 的 service 增補、generated Go stub 重產、`kernel/cmd/kernel/main.go`、`kernel/internal/server/append.go` + `append_test.go`、`kernel/internal/client/client.go` + `client_test.go`、`kernel/internal/server/conformance_test.go`）、modules <~3（`proto/` 契約（跨 plane）+ `kernel/internal/server` + `kernel/internal/client`）
  > **尺寸誠實揭露**：`proto/` 目錄骨架 + buf/protoc codegen 接線 + `proto:check` 入 cascade + gRPC runtime 依賴**已從本 slice 移除、改由 P1-S6a 擁有**（slice-spec §4）。本 slice 只剩「Append service 定義 + server enforcement + append-only client + 對抗測試」這單一行為增量。

> **本 slice-doc 的執行時鐵律（引用 phase-0/INDEX.md §2.1，一次定義、此處引用）：**
> 1. **EXECUTION-TIME EVIDENCE**：本文件 §5/§6 的所有指令 transcript 與 exit code（`go test … FAIL`、`exit code: 1`、`pnpm run verify … exit code: 0`）**都是樣板佔位**，必須在執行時被**真實輸出覆蓋**；覆蓋前不得據此宣稱 slice 已綠/已 done。
> 2. **First-RED 必須真實捕獲且早於實作**：Go RED 測試必須在寫任何 server/client 實作前真實跑出 exit≠0 並 commit；reviewer 須經 git history / 親自還原實作重跑再確認 RED 為真（adversarial-code-review.md §3.3 第 4 步）。
> 3. **Per-slice 實作 loop cap ≈6**：RED→GREEN→verify 內圈若 6 次迭代仍無法 GREEN，停止並重評 slice 邊界（可能切太大）。
> 4. **canary 是「明顯非機密」sentinel**，只在記憶體構造、不寫入 fixture（見 §5 credential non-leak 對抗測試）。

---

## (1) ID + Title

SLICE-P1-006（slice JSON id：P1-S6）— 定義 **typed gRPC ingest proto**（`proto/ingest.proto`，zero shared internals）、把 Go evidence kernel 跑成**獨立進程**（`kernel/cmd/kernel`），並提供一個**只能 append 的 client**（型別層即無 update/delete/rewrite 面）；以對抗測試證明 **control plane 無法改寫/刪除已 append 的紀錄**（嘗試即 fail-closed 被拒，且 kernel 自身落一筆 audit 事件）。

## (2) Goal（一句話）

新增單向 `Append` RPC 的 ingest proto + 獨立進程 kernel server（包住 P1-S4 durable+sequence 與 P1-S5 outbox 投遞路徑）+ append-only client，使 control plane **只能** append、**結構上無改寫面**，並以 RED 對抗測試鎖定「重寫既有 sequence / 送過時 sequence / 任何非 Append 操作 → server deny（fail-closed）並 audit」。

## (3) In-scope / Out-of-scope

> **前置依賴-only slice `P1-S6a`（gRPC/protobuf 工具鏈 + runtime，本 slice depends-on）**：依 slice-spec §4，把「新增 `google.golang.org/grpc` + `google.golang.org/protobuf` runtime 依賴、buf/protoc 工具鏈、`proto/` 目錄骨架、`proto:check` script 接進 `pnpm run verify`（與 `verify:go` 並列的 codegen-up-to-date 檢查）」**拆為先行的依賴-only slice `P1-S6a`**（零行為、只立工具鏈與依賴；RED = 失敗的存在性/契約斷言：`proto:check` 未串接前紅、generated stub 與 `.proto` 不一致時 exit≠0）。`P1-S6a` 由 lead-editor 於 INDEX 登記為 `P1-S6 -> P1-S6a -> {P1-S2}` 的節點。**本 slice（P1-S6）不引入任何第三方 runtime 依賴**（全由 P1-S6a 提供），只承載下列行為：
- **In-scope（行為-only，依賴/工具鏈在 P1-S6a）**:
  - `proto/ingest.proto`：在 P1-S6a 建立的 `proto/` 骨架下，**新增唯一 RPC** `rpc Append(AppendRequest) returns (AppendResponse)`（單向 unary，**無** Update/Delete/Overwrite/Rewrite/Upsert RPC）並重跑 codegen。
    - `AppendRequest { string source_id = 1; uint64 sequence = 2; bytes canonical_event = 3; }`
      —— `canonical_event` 是**已 redact 的 S0.2 canonical bytes**（control plane 端產生，kernel 端不再持有原始 secret；見 §6 credential non-leak）。
    - `AppendResponse`：`oneof` 結果 —— 成功 `Receipt { uint64 sequence; string content_hash; string prev_hash; string entry_hash; }` 或 typed 錯誤（`AppendError { enum Code { SEQUENCE_GAP; SEQUENCE_REPLAY; STALE_SEQUENCE; MALFORMED; } string detail; }`）。**typed 錯誤面不暴露任何「改寫既有 entry」的合法路徑。**
    - generated Go stub（buf/protoc → `kernel/internal/ingestpb/`，置於 `internal/` 下，外部無法 import）。
  - `kernel/cmd/kernel/main.go`：獨立進程 gRPC server entrypoint，包住（wrap）**P1-S4 的 durable append + monotonic per-source sequence** 與 **P1-S5 的 transactional outbox 投遞路徑**；server 端**強制 append-only + monotonic sequence**（重寫/越序一律拒）。
  - **append-only client**（`kernel/internal/client/client.go` 或 control-plane 側經 proto 生成的 thin client）：**只暴露 `Append(...)`**，型別層無任何 mutate/overwrite 方法。
  - server 端 fail-closed 強制：對 (a) 重寫既有 sequence、(b) 送過時/重放 sequence、(c) gap（越過下一個期望 sequence）、(d) 畸形/未知 RPC payload → 一律 **deny**（回 typed `AppendError`，非 fail-open 接受），且 **kernel 自身落一筆 audit 事件**（誰、source_id、被拒的 sequence、reason、result=denied）。
  - **RED 對抗測試**（Go `go test`）：client/proto 結構上無改寫面（編譯期＋執行期雙證）；server 對改寫/越序/畸形請求一律 deny+audit。
  - proto 契約純度測試：control plane **不 deep-import** kernel internal（depguard + `internal/` 邊界），只用 proto。
- **Out-of-scope（明確不做，註記留給哪個後續 slice / phase）**:
  - **mTLS / 進程身分 hardening 的 production 化** → 本 slice 先以「typed proto + 分離進程」**示意**身分分離；完整 tenant-keyed / gateway-per-tenant 身分邊界 → **P3**（roadmap §3.3，gateway-per-tenant + per-tenant-keyed kernel partition）。
  - **TS 端 client 整合**（control plane 真正以此 client 送事件）→ **P2**（roadmap §3.2，Personal beachhead 串 kernel）。本 slice 的 client 是 Go-side reference + 契約測試；TS 消費留 P2。
  - **外部錨定**（RFC-3161 / transparency-log witness / WASM verifier）→ **P4**（roadmap §3.4，F1 升級為完整 Tessera）。
  - **durable storage 引擎本身**（SQLite-backed tile store / outbox table schema）→ 由 **P1-S4 / P1-S5** 提供；本 slice 只**包住**它們的既有 public surface，不重做持久化。
  - **synchronous-commit-before-effect 的時序測試** → 主由 P1-S5（outbox + commit-before-effect）承載；本 slice 只確保 `Append` 在回 `Receipt` 前已走完「durable commit」這一步（不在 commit 前回成功）。**無 double-coverage gap（明確勾稽）**：端到端時序不變量由 **P1-S5 的 `commit_gate_test.go::TestCommitBeforeEffect`（`commitObservedAt < effectObservedAt`）證明**；P1-S6 只以 `append_test.go` 的斷言「`Receipt` 從不在 durable commit 完成前回傳（commit 失敗 → 不回 Receipt）」覆蓋 RPC 邊界這一段。兩者互補、無「皆未擁有」的縫。

## (4) Design delta + modules + public interface + dependency direction

- **Design delta**:
  - 現況（**更正：P1-S2 並未建立 proto / codegen / gRPC runtime**）：P1-S2 是「Go canonical-bytes + entryHash + checkpoint conformance」，其 Out-of-scope **明確把「跨進程 / gRPC ingest proto / kernel 作為獨立 process」延到 P1-S6**；P1-S1..P1-S5 **無任何 slice 擁有** `proto/ingest.proto`、buf/protoc codegen、`proto:check` script、或 gRPC runtime 依賴（`package.json` 目前無 `proto:check`）。P1-S4 提供 durable append + monotonic per-source sequence；P1-S5 提供 transactional outbox + commit-before-effect + producer 端去重。**目前 kernel 尚非「獨立進程」、亦無「只能 append 的跨進程 client」**——control plane 與 kernel 仍是 in-process 契約（S0.5 v0 明確自註「NOT process-isolated」）。
  - **本 slice 群組的所有權（依賴變更不與行為變更同 slice，slice-spec §4）**：proto-first 契約 + codegen + `proto:check` 接進 cascade + **gRPC/protobuf runtime 依賴**，是**新增第三方依賴 + 工具鏈**，依 slice-spec §4「依賴變更須單獨成一個 slice」**拆為先行的依賴-only slice `P1-S6a`**（見下「新依賴宣告」與 §8 Depends-on）。**P1-S6（本 slice）只承載行為**：`IngestService.Append` 的 server enforcement + append-only client + 對抗測試，依賴 `P1-S6a` 已就位的 runtime/codegen。
  - 本 slice 的最小變更：把 kernel 提升為**獨立 gRPC 進程**（`cmd/kernel`），control plane 只能透過 `proto/ingest.proto` 的 `Append` RPC 與它對話（zero shared internals）；**型別層**（proto 只有 `Append`、client 只有 `Append`）+ **server 端 enforce**（重寫/越序/畸形一律 deny+audit）共同把 architecture-approach.md「被審計者結構上無法改寫 audit」從 S0.5 的「同進程、僅無改寫 API」升級為「**不同進程 + 無改寫 RPC 面 + server 強制**」。
  - 狀態機差：`Append(source_id, sequence)` 對每個 `source_id` 維護一個**期望的下一個 sequence**（`next[source_id]`，由 P1-S4 的 durable sequence 提供）：`sequence == next` → 接受、durable commit、回 `Receipt`、`next++`；`sequence < next`（已存在）→ `SEQUENCE_REPLAY`/`STALE_SEQUENCE` deny+audit（**不覆蓋**）；`sequence > next`（跳號）→ `SEQUENCE_GAP` deny+audit；payload 無法 parse / 非 canonical → `MALFORMED` deny+audit。

- **Modules touched（每個一句唯一責任，high cohesion 自證）**:
  - `proto/ingest.proto`（在 **P1-S6a** 建立的 `proto/` 骨架下新增 service）— **唯一責任**：定義 kernel ingest 的**唯一對外契約**（單向 `Append` + typed `Receipt`/`AppendError`），是 control plane ↔ kernel 的 zero-shared-internals 邊界。
  - `kernel/cmd/kernel/main.go`（新增）— **唯一責任**：以獨立進程啟動 gRPC server，wiring（注入）P1-S4 durable+sequence store 與 P1-S5 outbox 到 server handler；**不含**業務邏輯（薄 main）。
  - `kernel/internal/server/append.go`（新增）— **唯一責任**：實作 `Append` handler 的 append-only + monotonic-sequence fail-closed 強制（重寫/越序/畸形 → typed deny + 落 audit），呼叫 P1-S4/P1-S5 的 public surface。
  - `kernel/internal/client/client.go`（新增）— **唯一責任**：提供**只暴露 `Append` 的** Go client wrapper（型別層無 mutate 面），供契約測試與 P2 消費參考。
  - `kernel/internal/ingestpb/`（generated）— **唯一責任**：proto 生成的 Go message/stub，置於 `internal/` 使其**無法被 kernel 外部 import**（Go internal package 邊界 = 編譯器級封裝）。

- **PUBLIC interface（新增/變更的對外公共面；內部實作不列）**:
  - **proto（跨 plane 唯一公共面）**:
    ```proto
    syntax = "proto3";
    package agentos.ingest.v1;

    service IngestService {
      // 唯一 RPC：單向 append。沒有 Update/Delete/Overwrite/Upsert。
      rpc Append(AppendRequest) returns (AppendResponse);
    }

    message AppendRequest {
      string source_id       = 1; // per-source monotonic sequence 的 key（P3 才綁 tenant 身分）
      uint64 sequence        = 2; // 該 source 的期望下一個序號（kernel enforce monotonic）
      bytes  canonical_event = 3; // 已 redact 的 S0.2 canonical bytes（kernel 不持有原始 secret）
    }

    message Receipt {
      uint64 sequence     = 1;
      string content_hash = 2; // "sha256:"-prefixed（版本化前綴，不硬編 blake3）
      string prev_hash    = 3; // "sha256:"-prefixed
      string entry_hash   = 4; // "sha256:"-prefixed
    }

    message AppendError {
      enum Code {
        CODE_UNSPECIFIED = 0; // proto3 預設 0 = 未指定 → 視為 deny（fail-closed）
        SEQUENCE_GAP     = 1; // sequence > next：偵測到跳號
        SEQUENCE_REPLAY  = 2; // sequence 已存在：拒絕覆蓋（append-only）
        STALE_SEQUENCE   = 3; // sequence < next：過時
        MALFORMED        = 4; // payload 無法 parse / 非 canonical
      }
      Code   code   = 1;
      string detail = 2; // 只含欄位名/靜態理由，不回放 canonical_event 內容（防 leak）
    }

    message AppendResponse {
      oneof result {
        Receipt     receipt = 1;
        AppendError error   = 2;
      }
    }
    ```
  - **Go append-only client 公共面**（型別層即無改寫面）:
    ```go
    // 唯一暴露的方法是 Append；沒有 Update/Delete/Overwrite/Rewrite。
    type AppendOnlyClient interface {
        Append(ctx context.Context, sourceID string, sequence uint64, canonicalEvent []byte) (Receipt, error)
    }
    ```
  - **無**新增 TS 公共面（TS 消費 → P2）；**本 slice 無新增第三方 runtime 依賴**——gRPC/protobuf runtime 與 codegen 工具鏈由**先行的依賴-only slice `P1-S6a`** 提供（見下方新依賴宣告與 §8 Depends-on）。本 slice 只**消費**已就位的 runtime/stub。

- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    control plane (TS) ─┐
                        ▼  (僅經 proto/ingest.proto，zero shared internals)
                proto/ingest.proto  ◀── kernel/internal/ingestpb (generated, internal/)
                        │
    kernel/cmd/kernel ──▶ kernel/internal/server/append ──▶ P1-S4 durable+sequence (public surface)
                                                       └──▶ P1-S5 outbox (public surface)
    kernel/internal/client ──▶ proto stub (Append only)
    ```
  - **跨 plane 純度**：control plane 只 import 由 `proto/ingest.proto` 生成的 client，**不得 deep-import** `kernel/internal/*`（Go `internal/` 編譯器級阻擋 + depguard 規則）。kernel **不得** import control plane / SDK（P1-S1 既有的三條跨 plane deny rule）。verifier（`internal/verify`，P1-S3）**不得** import server 寫入路徑——本 slice **增補**一條 depguard rule `verify-no-server`（deny `github.com/agent-os/kernel/internal/server`、`.../internal/client` 對 `internal/verify` 的可見性反向：即 `internal/verify` 的 deny-list 含 `internal/server`）進 P1-S1 既有 `.golangci.yml`，使「standalone verifier 只依公共 chain+checkpoint+pubkey」由指令證明。
  - 僅經 public surface 消費（無 deep import）: ☑ 是（kernel 內部全置於 `internal/`；對外只有 proto + `cmd/kernel` binary）。
  - **新依賴宣告（本 slice = 零新依賴；依賴全在先行的 `P1-S6a`）**:
    - **`P1-S6a` 擁有的新依賴**：`google.golang.org/grpc`（server runtime）+ `google.golang.org/protobuf`（message runtime）+ buf/protoc-gen-go/protoc-gen-go-grpc（generate-time 工具鏈）。方向＝kernel adapter 層依賴平台 lib（inward，不反向）；cycle＝無（grpc 不依賴本專案）；理由＝實作獨立進程 ingest 的最小手段，YAGNI 下無更簡替代（裸 TCP 自寫 framing 風險更高）。**依 slice-spec §4「依賴變更不與行為變更同 slice」，這些一律在 `P1-S6a` 引入，本 slice depends-on `P1-S6a`。**
    - **本 slice（P1-S6）新增第三方依賴 = 0**：只新增 `ingest.proto` 的 service 定義 + 重跑 codegen（消費 P1-S6a 的工具鏈）+ server/client Go 程式（用 P1-S6a 引入的 runtime）。

## (5) Test-first plan（先寫的 RED 測試）

> Go plane：RED = 一個會失敗的 `go test`（在 server/client 實作尚未存在/未滿足時非零退出）。測試置於被測檔同目錄（`*_test.go`）。執行入口統一經 `pnpm run verify`（級聯 `verify:go` → `kernel/` 內 `go test ./...` + `golangci-lint`，S0.8 承接）。

- 測試檔（新增）:
  - `kernel/internal/server/append_test.go`（server fail-closed + audit）
  - `kernel/internal/client/client_test.go`（append-only client、契約純度）
  - `kernel/internal/server/conformance_test.go`（與 TS 釘定常量 byte-for-byte：genesis prevHash / entryHash / receipt 形態——僅本 slice 觸及 hashing 邊界處需對齊）

- **RED 測試清單（每條對應一個行為/不變量）**:
  - [ ] **append-only 正常路徑**：對 `source_id=S`、`sequence=0,1,2` 連續 `Append` → 各回 `Receipt`，`prev_hash` 串接（首筆 `prev_hash == GENESIS_PREV_HASH = "sha256:"+64×"0"`），`entry_hash` 以 S0.5 釘定的 `frame(canonical_event ‖ prev_hash ‖ sequence)` 之 `sha256:`-prefix 計算。
  - [ ] 安全對抗式（**no rewrite surface — 型別層**）：client 介面只暴露 `Append`；reviewer 嘗試呼叫 `Update`/`Delete`/`Overwrite` 應**編譯失敗**（`go build` 非零）——證明改寫面在型別層不存在。
  - [ ] 安全對抗式（**重寫既有 sequence — server fail-closed**）：先 `Append(S, 0)` 成功，再 `Append(S, 0, 不同 canonical_event)` → 回 `AppendError{SEQUENCE_REPLAY}`（**不覆蓋**既有 entry；durable store 內 sequence 0 的 entry_hash 不變），且 kernel 落一筆 `result=denied` 的 audit 事件。
  - [ ] 安全對抗式（**過時 sequence**）：`next=3` 時 `Append(S, 1)` → `AppendError{STALE_SEQUENCE}` + audit deny。
  - [ ] 安全對抗式（**gap 越序**）：`next=1` 時 `Append(S, 5)` → `AppendError{SEQUENCE_GAP}` + audit deny（gap detection 不靜默接受）。
  - [ ] 安全對抗式（**畸形 / 未知 payload — fail-closed**）：`canonical_event` 為非 canonical bytes / 空 / 超大畸形 → `AppendError{MALFORMED}` + audit deny；`AppendError.Code` 預設 0（`CODE_UNSPECIFIED`）絕不被當成 success（proto3 zero-value 不可 fail-open）。
  - [ ] 安全對抗式（**audit 完整性**）：每筆 deny 各 emit 一筆形狀完整的 kernel-side audit（含 source_id、被拒 sequence、reason=靜態字串、result=denied）；deny 路徑不漏 audit。
  - [ ] 安全對抗式（**credential non-leak**）：把 runtime 組裝的 canary（`["CANARY","SECRET",uuid].join("-")`，記憶體構造、不入 fixture）放進 `AppendError.detail` 的觸發輸入與 deny reason 路徑 → 斷言 `detail`/audit/log **不回放** canary 原值（reason 只含欄位名/靜態理由）。
  - [ ] 安全對抗式（**契約純度 — 跨 plane**）：以 depguard 規則斷言 control plane 對 kernel 的依賴只經 proto stub，且 `kernel/internal/*` 無法被外部 import（`go build` 對外部偽 import 應失敗）；kernel 不 import control plane / SDK。
  - [ ] **cross-language conformance（觸及 hashing 處，REUSE P1-S2 共享 golden vector）**：對同一 `canonical_event`/`prev_hash`/`sequence`，Go server 算出的 `entry_hash` == `computeEntryHash`（透過 P1-S2 的 `internal/chain.ComputeEntryHash`，其已 byte-for-byte 對齊 S0.5）。**conformance 向量來源 = P1-S2 已擁有的共享 fixture `kernel/testdata/golden-vectors.json`（TS 產、非 Go 自證）**，本 slice **消費、不另立** kernel-internal-only fixture，避免與 S0.5 漂移。完整 TS↔Go 雙向對拍由 P1-S7 收口；本 slice 只驗 server 路徑算出的 entry_hash 對齊既有 golden。
- **首次紅燈證據（貼 exit≠0；server/client/ingest service 尚未實作）**:
  > **EXECUTION-TIME EVIDENCE（gate-as-written 才算數）**：`verify:go` = `bash scripts/verify-go.sh`，其第 29 行在 `kernel/` 內跑 `go vet ./... && go test ./... && golangci-lint run`。RED transcript **必須以重跑該 script（`pnpm run verify:go`）捕獲**，不是手跑 `go test`——確保 gate-as-written 真的會抓到此 RED。
  ```
  $ pnpm run verify:go        # = bash scripts/verify-go.sh（在 kernel/ 內跑 go test ./...）
  --- FAIL: TestAppend_RejectsSequenceReplay (server not implemented)
      append_test.go: undefined: server.NewIngestServer
  FAIL    github.com/agent-os/kernel/internal/server
  verify:go: FAIL — Go gate failed
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）

- [ ] **Test-first 成立**：實作前先有 §5 的 Go RED 測試，已貼首次紅燈 exit≠0（reviewer 須經 git history / 還原實作重跑再確認 RED 為真）。
- [ ] `pnpm run verify` **exit 0**（含級聯 `verify:go`：`kernel/` 內 `go test ./...` + `golangci-lint`（depguard）皆綠；S0.8 cascade 承接）。
  ```
  $ pnpm run verify
  ... verify:go: go test ./...  ok      golangci-lint: 0 issues
  ... exit code: 0
  ```
- [ ] **dependency-boundary check 綠（雙腿）**：
  - TS 腿：`pnpm run deps:check` exit 0（control plane 無 deep-import kernel internal）。
  - Go 腿：`(cd kernel && golangci-lint run ./...)` exit 0（depguard：kernel 不 import control-plane/SDK（P1-S1 三條 deny rule）；`internal/verify` 不 import `internal/server`/`internal/client`（本 slice 增補的 `verify-no-server` rule，reviewer 親植違規 fixture 證 exit≠0）；`internal/` 邊界生效）。
  > S0.8 後 Go 腿經 `verify:go` 已併入 `pnpm run verify`；本條由該 cascade 強制（plane dir = `kernel/` 已存在 → fail-closed 要求其 gate 齊全）。
- [ ] **low coupling / high cohesion 遵守**：跨 plane 僅經 `proto/ingest.proto`（zero shared internals）；kernel 內部全在 `internal/`；append-only client 只暴露 `Append`；無 cyclic / 無 deep import。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` 輸出 `secret-scan: clean`；reviewer 自設 canary 後在 6 sink（workspace/logs/artifacts/snapshots/traces/fixtures）+ kernel audit payload + `AppendError.detail` grep **0 命中**（kernel 只存**已 redact 的 canonical bytes**，原始 secret 從不進 kernel）。
- [ ] **Docs 更新**：`proto/ingest.proto` 的契約語義（單向 Append、typed 錯誤碼、append-only 無改寫面）+ kernel 為**獨立進程**、`cmd/kernel` 啟動方式、`verify:go` 如何涵蓋本 slice，寫進 kernel README / 對應 design doc；明寫「**本 slice 達成的是 proto/型別層無改寫面 + server fail-closed 強制 + 進程分離；mTLS/tenant-keyed 身分硬化在 P3、TS client 整合在 P2、外部錨定在 P4**」（避免過度宣稱）。
- [ ] **Adversarial code review = PASS**（fresh-context、!= author、refute-by-default）— 主攻面：**§4.5 audit gap/tamper**（重寫/越序/畸形是否真被 deny+audit、有無 fail-open 縫隙）、**§4.7 low coupling/high cohesion**（契約純度、`internal/` 邊界、proto 是否意外暴露改寫面）、**§4.2 fail-closed**（畸形/未知 RPC、`CODE_UNSPECIFIED` zero-value 是否被當成 success）、**§4.3 credential non-leak**（`detail`/audit 不回放 canary）。連結/摘要: <...>
- [ ] **（安全不變量類 slice）Independent Verifier Pass** 已執行並 clean：對抗式探測「改寫既有 entry / 越序 / 畸形 / 旁路 mutate API」皆 fail-closed 被拒並 audited（HELD），且確認 doc **未**宣稱已達成 P3 的 tenant-keyed 身分隔離。

## (7) Rollback

- 回退方式: `git revert <merge-sha>`（含 `proto/ingest.proto` 的 service 變更 + `cmd/kernel` + `internal/server`/`internal/client` + 測試）。
- 可逆性: **本 slice 程式碼層安全可逆**——它新增「獨立進程 server + append-only client + proto service」，無 schema 遷移、無破壞性變更（P1-S4/P1-S5 的持久化由它們自身的 slice 擁有，本 slice 只包住其 public surface）。
- **不可逆審計面（slice-spec §7）**：kernel 為 **append-only / hash-chained**；任何已寫入的 entry **不得改寫**——回退**不刪歷史**，靠 **forward-correcting event** 修正（這正是本 slice 要 enforce 的不變量本身）。回退只移除「跨進程 ingest 路徑」，不觸碰已寫入鏈。

## (8) Depends-on / blocks

- **Depends-on**:
  - **P1-S6a（依賴-only 先行 slice，本 slice 群組內先行）**—— 提供 `google.golang.org/grpc` + `google.golang.org/protobuf` runtime、buf/protoc 工具鏈、`proto/` 骨架、`proto:check` 接進 `pnpm run verify`。**更正**：此前置**不**由 P1-S2 提供（P1-S2 是 canonical/entryHash/checkpoint conformance，明確把 gRPC 延到 P1-S6）；依 slice-spec §4 拆為 P1-S6a。
  - **P1-S2**（pinned primitives：`internal/chain` 的 `ComputeEntryHash` / `GenesisPrevHash` + `internal/canonical`）—— 本 slice 觸及 hashing 邊界處（§5 conformance 測試）byte-for-byte 對齊它，不重定義常量。
  - **P1-S5**（transactional outbox + synchronous-commit-before-effect）—— 提供 outbox 投遞路徑與「commit-before-effect」的 durable commit 步驟；本 slice 的 `Append` handler 在回 `Receipt` 前須走完該 durable commit（不在 commit 前回成功）。
  - （傳遞性）**P1-S4**（durable append + monotonic per-source sequence）—— 經 P1-S5 鏈上依賴；本 slice 包住其 sequence/durable 的 public surface 來 enforce monotonic + gap detection。
  - （phase 前置）**S0.5**（pinned TS 契約常量：genesis prevHash / entryHash via `frame()` / checkpoint-over-HEAD）—— 本 slice 觸及 hashing 邊界處須 byte-for-byte 對齊。
  - （gate 前置）**S0.8**（`verify` polyglot 級聯，plane dir 預設 `kernel/`，fail-closed）—— 承接 `verify:go`，使本 slice 的 Go gate 一進場即無法繞過 `pnpm run verify`。
- **Blocks**:
  - **P2**（Personal beachhead c24）—— TS control plane 真正以本 slice 的 ingest proto/client 把事件送進 kernel。
  - **P3**（Tenant-Sealed Fleet c3）—— gateway-per-tenant / tenant-keyed kernel partition 建在本 slice 的「kernel 獨立進程 + 單向 ingest 契約」之上。
- 確認 slice DAG 無 cycle: ☑ 是（P1-S6 → {P1-S6a(→P1-S2), P1-S2, P1-S5(→P1-S4→P1-S3→P1-S2→P1-S1), S0.5, S0.8}，皆指向較早 rank / earlier slice，無回邊。INDEX.md 以直接邊 `P1-S6 -> {P1-S6a, P1-S2, P1-S5}` 表達，P1-S6a 為依賴-only 先行 slice）。

---

## 附註：本 slice 的對抗面（keyRisk 對照，供 reviewer 主攻）

**主要風險 = 改寫面外洩。** reviewer 須具名嘗試以下破口（任一成立即 FAIL）：

1. **proto 暴露可變更既有 entry 的路徑**：檢查 `ingest.proto` 是否真的**只有** `Append`、是否有任何帶「可指定任意 sequence 覆蓋」語義的欄位（如 `overwrite=true`、upsert 旗標、可寫 `entry_hash` 的 request 欄位）。`AppendRequest` 不得含任何讓 client 直接寫定 `entry_hash`/`prev_hash` 的欄位——這些只能由 server 計算回傳。
2. **server 對重寫/越序/畸形 fail-open**：reviewer 親送 (a) 重複 sequence、(b) `sequence < next`、(c) `sequence > next`、(d) 畸形 bytes、(e) `AppendError.Code` zero-value 被誤判成功，逐一確認回 typed deny + audit，**且 durable store 內既有 entry 不變**。
3. **client 結構上仍有改寫面**：reviewer 嘗試 `go build` 呼叫不存在的 mutate 方法應失敗；確認 client 沒有偷暴露 raw gRPC stub 讓人繞過 `Append`-only 封裝。
4. **control plane deep-import kernel internal**：reviewer 跑 depguard（`golangci-lint run ./...`）+ 嘗試在 control plane 偽 import `kernel/internal/*` 應**編譯失敗**（Go internal 邊界），確認跨 plane 只走 proto。
5. **credential 經 deny 路徑回放**：reviewer 把 canary 塞進觸發 `MALFORMED`/`SEQUENCE_*` 的輸入，確認 `AppendError.detail`、kernel audit reason、log 皆不含 canary 原值（kernel 只存已 redact 的 canonical bytes）。
