# SLICE-P1-005: transactional outbox（producer 端）+ synchronous-commit-before-effect 時序保證

- **Phase**: P1（roadmap §3.1 Go evidence kernel；本 slice 落在 **producer/auditee 端**的 ingest-completeness 環節，**不**寫跨進程 gRPC 線傳——那是 P1-S6）
- **Branch**: slice/p1-005-transactional-outbox-sync-commit-before-effect
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~280、files <~5（`outbox.go` + `outbox_test.go`、`commit_gate.go` + `commit_gate_test.go`、`internal/outbox/testdata/` crash-state fixture）、modules <~2（`kernel/internal/outbox`、`kernel/internal/commitgate`）；**`kernel/go.mod`/`.golangci.yml` 屬 P1-S1，不計入**。
  > **尺寸復核（採 producer-端去重後）**：本 slice 含 outbox（durable 落地 + per-source sequence 配發 + delivered-set 去重 + crash-resume）+ commitgate（happens-before）+ 4 類測試（時序 / fail-closed / crash-injection / 去重）。若實作逼近 slice-spec §3 的 ~300 行 soft target（或 hard cap 400），**拆為兩個 slice**：P1-S5a = `outbox`（durable + sequence 配發 + delivered-set 去重，單一責任「producer 端證據落地與去重」）、P1-S5b = `commitgate`（commit-before-effect happens-before，depends-on P1-S5a）。兩者各自仍單一責任、acyclic。

> **EXECUTION-TIME EVIDENCE（沿用 phase-0/INDEX.md §2.1）：** 本 doc §5/§6 中所有 transcript 與 exit code（`go test … FAIL`、`pnpm run verify … exit 0` 等）**都是樣板佔位，不是已達成的結果**；必須在執行時被**真實輸出覆蓋**才可據以宣稱綠/done。`only command output is truth`。
> **First-RED 必須早於實作且真實捕獲**；per-slice 實作內圈 loop cap ≈ 6（無 unbounded loop）；canary 是「明顯非機密」的 sentinel，只在記憶體組裝、不寫入任何 fixture 檔（避免 secret-scan 誤報/漏報）。

---

## (1) ID + Title
SLICE-P1-005 — 在 producer/auditee 端新增 **transactional outbox**（證據先寫入本地交易性 outbox 並標記 `pending`，與「放行 side effect」之間有明確的 happens-before），並提供一個 **commit-before-effect gate**：caller 取得「證據已 durably committed（`fsync` 完成）」回執後**才**可放行對應的 side effect。以一條時序測試證明 **commit 早於 effect**；以 crash-injection 測試證明 **commit 後、deliver 前崩潰 → resume 不重複 append（idempotent）**。

## (2) Goal（一句話）
讓「證據 durably committed」成為任何 side effect 的**結構性前置（happens-before）**：未拿到 durable-commit 回執，effect 路徑**不可能**繼續；且 outbox 在 producer 端以 durable `delivered-set` 去重，重送相同 `(sourceId, sequence)` + 相同 `contentHash` 必為 **outbox no-op**（at-least-once 投遞 + producer 端 idempotent 去重，**不**依賴 kernel 端提供 idempotent append）。

## (3) In-scope / Out-of-scope
- In-scope:
  - `kernel/internal/outbox`：producer 端 **transactional outbox**——`Enqueue(record) -> CommitReceipt`：在**單一本地交易**內把 evidence record 以 `pending` 狀態落地並 **`fsync` 完成**後才回 receipt；提供 `MarkDelivered(seq)`、`PendingSince(...)`（resume 時重投未確認者）。outbox record 攜 `(sourceId, sequence, contentHash, canonicalBytes, state)`。
  - `kernel/internal/commitgate`：**commit-before-effect gate** API——`Guard(ctx, record, effect func() error) error`：先 `outbox.Enqueue`（durable commit）→ **取得 receipt 後**才呼叫 `effect()`；任何在 commit 前的失敗 ⇒ 回 error 且 **effect 從不被呼叫**（fail-closed）。
  - **at-least-once 投遞到 kernel + producer 端去重（方案 a，自洽於 P1-S4 既有面）**：投遞目標以 **P1-S4 的 durable append** 為介面（`Store.Append` + `Tracker.Admit(sourceID, sourceSeq)`；本 slice 不碰 gRPC 線傳，見 Out-of-scope）。**P1-S4 的 `Admit` 對 replay 回 `ErrSequenceRegression`（硬錯誤），不提供 no-op-return-receipt 的 idempotent dedup、亦無 contentHash 衝突偵測**——因此**去重在本 slice 的 outbox producer 端完成**，不依賴 kernel 端提供它不具備的語義：outbox 持一個 **durable 的 `delivered-set`**（以 `(sourceId, sequence)` 為鍵 + 記錄該筆的 `contentHash`），resume/重送時：
    - 該鍵已在 delivered-set 且 `contentHash` 相同 ⇒ **outbox 自身 no-op**（**不**對 kernel `Admit`，避免 `ErrSequenceRegression`）；
    - 該鍵已在 delivered-set 但 `contentHash` 不同 ⇒ outbox 回 `ErrContentConflict`（fail-closed，**不**重投、不覆寫）；
    - 該鍵不在 delivered-set ⇒ 投遞（kernel `Admit` 只會見到**新的** sourceSeq）。
    > **結論**：kernel 端 `Admit` 永遠只見單調遞增的新 sourceSeq；「resume 不重複 append」由 outbox 的 delivered-set 保證，**完全自洽於 P1-S4 既有 public 面**，不要求 P1-S4 新增 idempotent append 或 `ErrSequenceConflict`。
  - **monotonic per-source sequence（producer 端）**：outbox 為每個 `sourceId` 配發嚴格遞增、無重號的 `sequence`；sequence 由 outbox 在 enqueue 時於交易內配發（單一寫者序列化），不由 caller 任意指定。
  - RED 測試（Go `go test`，見 §5）：
    - **時序**：commit 已完成（`fsync` 已回）**之後** effect 才被允許（以注入式 clock/觀測器斷言 `commitObservedAt < effectObservedAt`）。
    - **commit-before-effect fail-closed**：commit 階段失敗 ⇒ effect 從不被呼叫。
    - **crash @ committed-but-not-delivered**：在 commit 後、`MarkDelivered` 前殺進程 → resume 後 outbox 重投 → **producer 端 delivered-set 去重**使**不重複 append**（事件數守恆、無 gap、無重複；kernel 端 `Admit` 只見新 sourceSeq）。
    - **去重鍵正確性（producer 端）**：重送相同 `(sourceId, sequence)` + 相同 `contentHash` = **outbox no-op**（不打 kernel）；相同 `(sourceId, sequence)` 不同 `contentHash` = outbox 回 `ErrContentConflict`（拒絕、不重投、不覆寫）。
- Out-of-scope（明確不做，註記留給哪個後續 slice）:
  - **跨進程 gRPC ingest 線傳（proto wire 形狀、connect/grpc server、TS↔Go 跨進程）** → 留給 **P1-S6**（本 slice 的「投遞介面」以 P1-S4 的 durable append 函式為目標，gRPC 形狀與跨進程身分隔離在 S6 落地）。
  - **完整 control-plane orchestration（XState task/resume ledger 串接、Approval Inbox 觸發）** → **P2**。
  - **外部錨定（RFC-3161 / transparency log）、Tessera tile log、WASM verifier** → **P4**。
  - **多來源跨節點的全域排序 / 分散式共識** → 非本 phase 範圍；本 slice 的 sequence 是**單一 producer 進程內、per-source 單調**，不宣稱跨節點全序。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: P1-S4 已交付 kernel 端 **durable append**（append-only、hash-chained、`fsync` 落地）。本 slice 在 **producer/auditee 端**補上「effect 之前先有 durable evidence」的**結構性順序**：新增本地 transactional outbox（evidence 先 `pending` 落地）+ commit-before-effect gate（拿到 durable receipt 才放行 effect）+ at-least-once 投遞與 idempotent 去重。**消除毀證窗口**：崩潰時序上不可能出現「effect 已發生但無證據」。
- **Modules touched（每個一句唯一責任，high cohesion 自證）**:
  - `kernel/internal/outbox`（新增）— **唯一責任**：producer 端 evidence record 的**交易性、`fsync`-durable、per-source 單調序列**的本地落地與 pending/delivered 狀態機；不知道 effect 是什麼、不知道 gRPC。
  - `kernel/internal/commitgate`（新增）— **唯一責任**：強制「先 durable-commit、後放行 effect」的 happens-before；不知道 evidence 如何落地（只持有 outbox 的 public 介面）、不知道 effect 的業務語意（只收一個 `effect func() error`）。
  - （投遞去重的 idempotency key 比對**借用** P1-S4 的 append 端 public 介面；本 slice **不**改 P1-S4 內部。）
- **PUBLIC interface（Go；新增/變更的對外公共面；internal 實作不外洩——見下方 internal/ 封裝）**:
  - `package outbox`
    - `type RecordInput struct { SourceID string; CanonicalBytes []byte; ContentHash string }`（**caller 提供的輸入**：`CanonicalBytes` 為**已 redact** 的 S0.2 canonical bytes、`ContentHash` 為其 content address。**不含 `Sequence`、不含 `State`**——`Sequence` 由 outbox 在 enqueue 交易內**配發**（§3「sequence 由 outbox 配發、不由 caller 指定」的型別強制：caller 結構上無法塞 sequence），`State` 由 outbox 管理）。
    - `type Record struct { SourceID string; Sequence uint64; ContentHash string; CanonicalBytes []byte; State State }`（**outbox 落地後的記錄**；`State` ∈ `{Pending, Delivered}`；kernel 只存已 redacted 內容，見 §6 credential 非外洩）。
    - `type CommitReceipt struct { SourceID string; Sequence uint64; ContentHash string; Durable bool }`（`Durable==true` 表示 `fsync` 已回；`Sequence` 為 outbox 配發之值）。
    - `type Outbox interface { Enqueue(rec RecordInput) (CommitReceipt, error); MarkDelivered(sourceID string, seq uint64) error; PendingSince(sourceID string, after uint64) ([]Record, error) }`（**無** `Update`/`Delete`/`Rewrite` 面——append-only by construction）。
  - `package commitgate`
    - `type Gate interface { Guard(ctx context.Context, rec outbox.RecordInput, effect func() error) error }`（語義：先 `Enqueue` 取得 `Durable==true` 的 receipt，**才**呼叫 `effect`；commit 失敗 ⇒ 回 error，`effect` 從不被呼叫）。
  - **去重契約（producer 端 delivered-set，自洽於 P1-S4 既有面，不要求 kernel 端 idempotent append）**：outbox 持 durable `delivered-set`（鍵 = `(SourceID, Sequence)`，值含已投遞的 `ContentHash`）。重送相同 `(SourceID, Sequence)` + 相同 `ContentHash` ⇒ **outbox no-op**（不對 kernel `Admit`，回原 `CommitReceipt`）；相同 `(SourceID, Sequence)` 但 `ContentHash` 不同 ⇒ 回 `ErrContentConflict`（fail-closed，**不**重投、不覆寫）。**kernel 端 P1-S4 `Admit` 只見新 sourceSeq**——本 slice **不**在 kernel 端重定義 append、**不**要求 P1-S4 新增 `ErrSequenceConflict`。
- **P1-conformance 契約常量（凡本 slice 觸及 hashing/canonical 處，必 byte-for-byte 對齊 S0.5）**:
  - 去重所用的 `ContentHash` **就是** S0.2 / S0.5 的 content address：`sha256:` + hex(sha256(canonicalBytes))，演算法前綴**版本化**（`sha256:` now；不得 hardcode 排除未來 `blake3:`）。
  - `CanonicalBytes` 必須是 **redaction 之後**的 S0.2 確定性 canonical 序列（recursive key sort、UTF-8、reject non-finite/undefined、object 缺 `undefined` 屬性省略）。**本 slice 不重新定義 canonical/entryHash**；entryHash/checkpoint 的計算屬 P1-S2/S4，本 slice 只把**已 canonical+redacted 的 bytes** 與其 content address 在 outbox 內搬運與去重。
  - genesis prevHash、entryHash framing（8-byte big-endian length-prefix）、checkpoint = Ed25519 over `frame(headEntryHash, length)`：本 slice **不改動**，只是其上游產物的承載者；任何序列化必須與 S0.5 pin 的常量一致（cross-language conformance 由 P1 的 TS↔Go 黃金測試守住，本 slice 的去重鍵以 content address 參與該一致性）。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle；adapters ──▶ application ──▶ domain）:
    ```
    commitgate (application: 強制 happens-before)
        │  只持有 outbox 的 public interface（不知落地細節）
        ▼
    outbox (domain/application: 交易性 durable 落地 + per-source 單調序列 + producer 端 delivered-set 去重)
        │  經 P1-S4 的 public Store.Append/Tracker.Admit 投遞（不 deep-import S4 internal）；去重在 outbox 自身
        ▼
    P1-S4 durable append (public surface: Store.Append / Tracker.Admit)   Go stdlib: os(.Sync/fsync), crypto/sha256, encoding/binary
    ```
    - `commitgate` **不**反向被 `outbox` 依賴（無 cycle）；effect 的業務語意以 `func() error` 注入，不讓 orchestration concern 滲進 kernel。
  - **僅經 public surface 消費（無 deep import）**: ☑ 是（由 `verify:go` depguard 強制、reviewer 親跑證明）。`commitgate` 只 import `outbox` 的 package public 面；投遞只經 P1-S4 的 public `Store.Append`/`Tracker.Admit` 介面，**不** import 其 `internal/` 未匯出識別符。
  - **Go internal/ 封裝（HARD CONSTRAINT A 的編譯器級強制）**: `outbox`、`commitgate` 皆置於 `kernel/internal/`，使 control plane / SDK / 任何 kernel 外部 module **在編譯期即無法 import** kernel 內部——天然封裝、與「kernel != control plane（不同進程/身分/語言）」對齊。
  - **depguard（golangci-lint）規則（隨本 slice 進 `.golangci.yml`，由 `verify:go` 強制）**:
    - kernel **禁止** import control-plane / SDK（無反向依賴）。
    - `commitgate` **禁止** deep-import 任何 `outbox` 子 internal（只允 package public 面）。
    - producer 端模組**禁止** import verifier 寫入路徑（verifier 只讀，維持「獨立 verifier 只依公共 chain+checkpoint+pubkey」）。
  - **新依賴宣告（逐一證明 inward + acyclic + justified）**: **無新第三方依賴**。僅用 Go stdlib：`os`（`File.Sync` = `fsync` durability）、`crypto/sha256`（content address，沿用 S0.5 演算法）、`encoding/binary`（8-byte big-endian framing，對齊 S0.5）、`context`、`sync`（單寫者序列化 per-source sequence）。理由：YAGNI/DRY——durability 與 hashing 用 stdlib 即足，引入嵌入式 DB 會擴大攻擊面且超尺寸。

## (5) Test-first plan（先寫的 RED 測試 — Go `go test`，RED 先行）
- 測試檔（新增）: `kernel/internal/outbox/outbox_test.go`、`kernel/internal/commitgate/commit_gate_test.go`
- 測試入口（plane 為 `kernel/`，由 S0.8 cascade 承接）:
  - 開發內圈直接跑：`cd kernel && go test ./internal/outbox/... ./internal/commitgate/...`
  - 統一 gate：`pnpm run verify`（級聯 `verify:go` → `cd kernel && go vet ./... && go test ./... && golangci-lint run`）
- RED 測試清單（每條對應一個可觀察行為/不變量）:
  - [ ] **時序：commit-before-effect**（核心 exit 條件）— 注入式觀測器記錄 `commitObservedAt`（`Enqueue` 回 `Durable==true` 的瞬間）與 `effectObservedAt`（`effect()` 被呼叫的瞬間）；斷言 `commitObservedAt` 嚴格早於 `effectObservedAt`。（時序以 happens-before 的**呼叫順序 + 注入 fake clock** 斷言，非 wall-clock sleep——無 flaky、無 unbounded wait。）
  - [ ] **commit 失敗 ⇒ effect 從不被呼叫（fail-closed）** — 注入「`fsync` 失敗 / enqueue 交易 rollback」→ `Guard` 回 error 且觀測器顯示 `effect()` 呼叫次數 == 0。
  - [ ] **per-source 單調 sequence** — 同一 `sourceId` 連續 enqueue → sequence 嚴格遞增、無重號；併發 enqueue（多 goroutine）下仍無重號（單寫者序列化）。
  - [ ] **crash @ committed-but-not-delivered → resume 不重複 append（producer 端 delivered-set idempotency）** — 模擬「`Enqueue` 已 `fsync`、`MarkDelivered` 前進程死亡」：重建 outbox（讀回 durable state 含 delivered-set）→ `PendingSince` 取回未投遞者 → 重投：已在 delivered-set 同 contentHash 者 outbox no-op、未投遞者才打 P1-S4 `Admit` → 斷言事件總數守恆、無重複 entry、verifier（P1-S3 Go verifier）對結果鏈回 `ok`、kernel 端從未收到重複 sourceSeq（不觸發 `ErrSequenceRegression`）。
  - [ ] **去重鍵正確性（producer 端，不打 kernel）** — 重送相同 `(sourceId, sequence)` + 相同 `contentHash` ⇒ **outbox no-op** 回原 receipt（不對 kernel `Admit`）；相同 `(sourceId, sequence)` 不同 `contentHash` ⇒ outbox 回 `ErrContentConflict`（fail-closed，**不**重投、不覆寫）。
  - [ ] 安全對抗式（**audit gap / tamper**，§4.5）：在 commit 與 effect 之間殺進程後，重啟掃描——**不得**出現「有 effect 痕跡但 outbox 無對應 `pending`/`delivered` 證據」的狀態（attest-the-negative 誠實）。
  - [ ] 安全對抗式（**credential non-leak**，§4.3）：以 runtime 組裝的 canary 放進 effect payload 的 free-form 欄位；斷言 outbox durable file / receipt / 日誌 / 任何序列化輸出中**不出現** canary 原值——kernel 只存**已 redacted** 的 S0.2 canonical bytes（canary 在記憶體組裝，不寫 fixture 檔）。
  - [ ] 安全對抗式（**no rewrite surface**）：型別層確認 `Outbox` / append 介面**無** `Update`/`Delete`/`Rewrite`；reviewer 嘗試呼叫不存在方法應 `go build` 失敗（append-only by construction）。
- 首次紅燈證據（貼 exit≠0；**兩個 package 各一條 RED 入口**）:
  ```
  # (1) commitgate 首次 RED（package 尚未存在 → build-failed 紅）
  $ cd kernel && go test ./internal/commitgate/...
  package github.com/agent-os/kernel/internal/commitgate: build failed
  ./commit_gate_test.go: cannot find package ".../internal/commitgate"
  FAIL    github.com/agent-os/kernel/internal/commitgate [setup failed]
  exit code: 1     # ← 此處貼執行時真實輸出（RED 必須早於實作）

  # (2) outbox 首次 RED（同樣 build-failed 紅）
  $ cd kernel && go test ./internal/outbox/...
  package github.com/agent-os/kernel/internal/outbox: build failed
  FAIL    github.com/agent-os/kernel/internal/outbox [setup failed]
  exit code: 1
  ```
  > **RED 必須升級為「斷言失敗的紅」（不只 build-failed）：** 上列 build-failed 只證明檔案不存在，**不**證明測試在斷言 commit-before-effect / 去重不變量。依 adversarial-code-review §3.3 第 4 步，實作期須**先讓兩個 package 可編譯（stub 回 `nil`/no-op）再跑測試**，取得「**斷言失敗**的 RED」——例如 commit-before-effect 觀測器斷言 `commitObservedAt < effectObservedAt` 在 stub 下失敗（紅）、去重斷言在 stub 下失敗（紅）。**commitgate 與 outbox 兩條 assertion-failure RED transcript 皆須貼**；reviewer 須在 clean worktree 還原實作（`git stash`）重跑確認因**斷言失敗**而 exit≠0，再還原確認 exit 0，否則 §4.8 只能標 `N/A` 不得 `HELD`。

## (6) Definition of Done（每條附指令證據 — only command output is truth）
- [ ] **Test-first 成立**（首次 RED 已貼於 §5；RED 早於實作，git history 可證）
- [ ] `pnpm run verify`（含級聯 `verify:go`）**exit 0**
  ```
  $ pnpm run verify
  ... verify:go: ok
  ... exit code: 0     # ← 執行時覆蓋
  ```
- [ ] `pnpm run verify:go` 維持綠（已 enforcing；P1-S1 擁有翻轉）：在既有 enforcing cascade 上新增 `internal/outbox`/`internal/commitgate` + 增補 depguard rule 後，`go vet ./... && go test ./... && golangci-lint run` 皆綠。
- [ ] **dependency-boundary check 綠（Go 腿）**：`cd kernel && golangci-lint run`（depguard）exit 0 —— `commitgate` 只經 `outbox` public 面、去重只經 P1-S4 public append、producer 不 import verifier 寫路徑、kernel 不 import control plane；`internal/` 封裝使外部無法 import kernel 內部。
- [ ] **low coupling / high cohesion 遵守**：`outbox`（durable 落地 + 單調序列）與 `commitgate`（happens-before）各單一責任；無新跨 module / cyclic 依賴；effect 業務語意以 `func() error` 注入，orchestration concern 不滲進 kernel。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` 輸出 `secret-scan: clean`；reviewer 自設 runtime-assembled canary 後，在 outbox durable file / receipt / logs / artifacts / snapshots / traces / fixtures + append payload **grep 0 命中**（kernel 只存已 redacted canonical bytes）。
- [ ] **核心時序不變量 HELD**：`commitObservedAt < effectObservedAt` 測試綠；commit 失敗 ⇒ effect 呼叫次數 0；crash-then-resume 不重複 append（事件守恆、verifier `ok`）。
- [ ] **Docs 更新**：本 doc 即交付物；`docs/slices/phase-1/INDEX.md`（**由 P1-S7 / lead-editor 統一建立並擁有** P1 slice DAG + no-cycle 證明 + 退出條件勾稽，對齊 `docs/slices/phase-0/INDEX.md` 格式）已登記 P1-S5 節點與邊 `P1-S5 -> {P1-S4}`（依 INDEX 鄰接表）；本 doc 明寫「本 slice 僅 **producer 端 outbox + commit-gate + producer 端去重**，跨進程 gRPC 線傳在 **P1-S6**」。
- [ ] **Adversarial code review = PASS**（fresh-context、!= author、refute-by-default；主攻面：§4.5 audit gap/tamper「在 commit 與 effect 之間殺進程後不得有 effect 無證據」、§4.6 idempotency「重送相同 sequence/contentHash 必 no-op」、§4.7 coupling）— 連結/摘要: <...>
- [ ] **Independent Verifier Pass（安全不變量類 slice）**：獨立者對抗式探測「先放行 effect 再非同步寫證據的毀證窗口」「去重鍵選錯導致 resume 重複/漏 append」皆無法構造成功；並親自重跑 `pnpm run verify`（含 `verify:go`）exit 0。

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（僅還原 `kernel/internal/outbox`、`kernel/internal/commitgate` 與其測試，以及對 `.golangci.yml` 增補的 outbox/commitgate depguard rule；**`kernel/go.mod` 與 `.golangci.yml` 本體屬 P1-S1，不刪除**——回退後 `kernel/` module 與 `verify:go` enforcing 仍在）。
- 可逆性: **producer 端程式碼安全可逆**（無 schema 遷移、無外部副作用）。**前瞻（append-only 不可改寫）**：若回退時 outbox 已對 P1-S4 kernel 投遞並 durable append 過真實 evidence，**該已 append 的鏈為 append-only**——回退靠 **forward-correcting event**（再 append 一筆修正事件），**不得改寫/刪除歷史**（slice-spec §7、AGENTS.md「不可逆 audit append」）。本 slice 的 outbox `pending`/`delivered` 本地狀態可安全丟棄重建（resume 由 P1-S4 去重保證不重複 append）。

## (8) Depends-on / blocks
- Depends-on（P1 編號已定案，無 hedge）:
  - **P1-S1**（kernel module bootstrap：`kernel/go.mod` + `.golangci.yml` depguard + `verify:go` enforcing 已就位）— 本 slice 在其既有 module 內新增 `internal/outbox`/`internal/commitgate`，並**增補**（非新建）depguard rule。
  - **P1-S4**（kernel 端 durable append + per-source sequence：`Store.Append` / `Tracker.Admit`）— **硬性前置**：本 slice 的「投遞」以 P1-S4 的 durable append + `Admit` 為目標；**去重在本 slice 的 outbox producer 端**（delivered-set），不要求 P1-S4 新增 idempotent append。
  - **P1-S2**（pinned primitives：`ContentHash` = `sha256:` + hex(sha256(canonicalBytes))，content-address 演算法）+ **P1-S3**（standalone Go verifier `internal/verify`）— P1-S3 verifier 用於 §5 crash-resume 測試斷言結果鏈 `ok`。（P1 編號已定案：S2=primitives、S3=log+verifier、S4=durable+sequence；verifier **不**併入 S4。）
  - **SLICE-P0-005**（pinned TS 契約 / conformance 常量：genesis prevHash、entryHash framing、checkpoint 簽章範圍、content address `sha256:` 版本化）— 本 slice 的 `ContentHash` 去重鍵須與之 byte-for-byte 對齊。
  - **SLICE-P0-008**（`verify:go` polyglot cascade）— 由 P1-S1 翻為 enforcing，本 slice 承接（**不**自行建立 go.mod/.golangci.yml）。
- Blocks:
  - **P1-S6**（跨進程 gRPC ingest 線傳）— S6 把本 slice 的「投遞介面」由 in-process append 介面替換為 typed gRPC ingest proto + 跨進程身分隔離；本 slice 的去重契約（`(sourceId, sequence, contentHash)`）與 commit-before-effect happens-before 是其前置。
  - **P2** orchestration（task/resume ledger 串接本 outbox 的 `PendingSince`/`MarkDelivered` 做 idempotent resume）。
- 確認 slice DAG 無 cycle: ☑ 是（P1-S5 → {P1-S1, P1-S4(→P1-S3→P1-S2→P1-S1), P1-S2, P1-S3, P0-005, P0-008}，全部指向較早 rank；無回邊。INDEX.md 的鄰接表以 `P1-S5 -> {P1-S4}` 表達其在 P1 DAG 內的直接邊，傳遞依賴經 P1-S4 鏈上承接）。
