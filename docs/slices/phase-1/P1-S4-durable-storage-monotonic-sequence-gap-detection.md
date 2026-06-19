# SLICE-P1-004: durable append-only storage + kernel-enforced monotonic per-source sequence + gap detection

- **Phase**: P1（roadmap §3.1 — Go evidence kernel；architecture-approach.md §3「先簡後繁」+「ingest 完整性使 attest-the-negative 誠實」）
- **Branch**: slice/p1-004-durable-storage-monotonic-sequence-gap-detection
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~280、files <~5（`store.go` + `store_test.go`、`sequence.go` + `sequence_test.go`、`internal/store/testdata/` torn-tail fixture）、modules <~2（`internal/store`、`internal/sequence`）
  > **檔案所有權**：`kernel/go.mod`、`kernel/.golangci.yml` 為 **SLICE-P1-001（P1-S1）** 擁有並已 merge——本 slice **不建立、不擁有**它們，只對既有 `.golangci.yml` **增補** `internal/store`/`internal/sequence` 的 depguard rule。`verify:go` 進場時**已是 enforcing**（P1-S1 完成翻轉），本 slice 不重述 skip→enforcing transition。

> **語言/平面定位（讀前必看）：** 本 slice 是 **Go evidence kernel 內部、single-process** 的持久化 + per-source sequence 狀態，落在 `kernel/internal/`（編譯器級封裝，外部不可 import）。它 **不** 觸碰 TS control plane、**不** 引入跨進程 gRPC、**不** 引入 producer 端 outbox。本 slice 把 P0-S5（`SLICE-P0-005`）釘下的 in-memory TS 契約，在 Go 端落成 durable、且**重啟後可重建鏈與 per-source sequence 狀態**的儲存層。**只有指令輸出是真相**：任何「durable / fail-closed / 重啟後 verify」的宣稱，皆以 `go test` / `pnpm run verify`（含級聯 `verify:go`）的 exit code 為憑。

## (1) ID + Title
SLICE-P1-004 — 把 kernel 的 append-only log 落到 **durable、append-only 的本地儲存**（fsync 後才算 committed、無改寫/截斷 API），並由 **kernel enforce 每個 source 的 monotonic sequence**；**缺序（gap）被偵測為錯誤而非靜默接受**，且重啟後鏈與 per-source sequence 狀態皆由 durable log 重建。

## (2) Goal（一句話）
在 Go kernel 內新增一個只可 append、fsync-after-write 才回 committed receipt 的 durable store，並以 kernel 端 per-source 狀態 enforce「`expected = last_seen + 1` 以外的 ingest sequence 一律 fail-closed 拒收（gap / regression / replay）」，且該狀態與鏈於重啟後皆從 durable log 重建。

> 本句含兩個被同一不變量綁住的面（durable append-only 持久化、per-source monotonic sequence + gap detection），二者**不可分割**：sequence 狀態必須由 durable log 重建才誠實——若 store 與 sequence 是兩個獨立 slice，重啟後就會出現「狀態與 log 不同步 → gap 漏報（fail-open）」的縫。故合為一個 cohesive slice，責任仍單一：「**讓 ingest 完整性在崩潰/重啟下誠實**」。

## (3) In-scope / Out-of-scope
- In-scope:
  - **`kernel/internal/store`（durable append-only file/WAL）**：
    - `Append(record) -> (committedOffset, error)`：序列化一筆 record（含 chain-position `sequence`、`prevHash`、`entryHash`、已 redact 的 canonical event bytes、per-source `sourceId` + `sourceSeq`）→ append 到本地檔 → **`fsync` 成功後才回 committed**；fsync 前進程死亡的半截寫入，重載時**必須被偵測並拒絕**（fail-closed，不得當成完好鏈尾）。
    - `Load() -> ([]LogRecord, headEntryHash, error)`：重啟後從檔重載、**重算 head**、跑既有 verifier 做啟動自檢；遇半截/截斷/壞 framing → 回 error（fail-closed），**不靜默截斷成「看似完好的較短鏈」**。
    - **無 `Update` / `Delete` / `Truncate` / `Seek-write` 公共面**（append-only by construction；型別/介面層即無改寫面，呼應 architecture-approach「control plane 無改寫權」於 kernel 內部的延伸）。
  - **`kernel/internal/sequence`（per-source monotonic 狀態）**：
    - kernel 端記每個 `sourceId` 的 `lastSeq`；`Admit(sourceId, sourceSeq) -> error`：
      - `sourceSeq == lastSeq + 1` → 接受、推進 `lastSeq`；
      - `sourceSeq > lastSeq + 1` → `ErrSequenceGap`（缺序，**偵測為錯誤**，非靜默接受）；
      - `sourceSeq <= lastSeq` → `ErrSequenceRegression`（回放較舊/重複 sequence → 拒收）。
    - 首見 source（無 `lastSeq`）的起始序號規則在 doc 釘死（採 P0-S5 的 0-based：首筆 `sourceSeq == 0`；非 0 即 gap）。
  - **重建（recovery）**：`sequence` 狀態 **不可僅存記憶體**；重啟時由 durable log 的 `sourceSeq` 重放重建 `lastSeq`（store 是 sequence 狀態的單一真相來源）。
  - **啟動自檢**：`Load()` 後對重載鏈跑既有 chain verifier（P1-S3 的 Go verifier）；重載鏈須仍 verify（hash 串接 + sequence 連續），否則 fail-closed。
  - **Go 邊界落地（增補規則，非建檔）**：`store`/`sequence` 置於 P1-S1 既有 `kernel/` module 的 `internal/` 下（外部 plane 無法 import）；對 P1-S1 既有 `.golangci.yml` **增補** depguard rule —— `internal/store` **不得** import `internal/sequence`、二者皆**不得** import control-plane / SDK / verifier（`internal/verify`）寫入路徑。**不重建 `go.mod`/`.golangci.yml`**（P1-S1 擁有）；`verify:go` 已 enforcing（P1-S1）。
- Out-of-scope（明確不做，註記留給哪個後續 slice）:
  - **transactional outbox（producer/control-plane 端）+ synchronous-commit-before-effect 時序** → 留給 **SLICE-P1-005**（本 slice 只提供「fsync 後才 committed」這個*被 commit-before-effect 依賴的底層保證*；不實作 producer 端 outbox，也不做 commit↔effect 的時序測試）。
  - **跨進程 gRPC ingest path（kernel 作為獨立進程，control plane 只能 append）** → 留給 **SLICE-P1-006**（本 slice 的 `Append`/`Admit` 是 in-process Go API，尚非 RPC 表面）。
  - **跨語言 conformance（TS 產的鏈在 Go verify、反之）** → **由 SLICE-P1-007 擁有**（TS↔Go 雙向對拍）；本 slice 的啟動自檢**重用** P1-S3 的 Go verifier（同進程、同語言重算），但**不**宣稱 P1-S3「擁有」cross-language conformance（P1-S3 自身已把 TS↔Go 雙向延到 P1-S7）。本 slice 不重複定義 hash/frame 常量。
  - **外部錨定 / Tessera tile log / RFC-3161 / WASM verifier** → **P4**（roadmap §3.4）。
  - **per-tenant 獨立 Merkle tree / 獨立簽章 key** → **P3**（roadmap §3.3）；本 slice 的 store 是單一鏈、單一 source-namespace 表。
  - **producer 端 sequence 配發語義** → 由 **P1-S5 / P1-S6** 的 producer 落地；**跨 slice alignment 風險（flag for P1-S5/P1-S6 eng review）**：本 slice 的 kernel 端 `Admit` 釘死「首見 source 起始 `sourceSeq == 0`、其後 `lastSeq+1`」。**P1-S5 outbox 與 P1-S6 gRPC client 的 producer 必須發 0-based、連續 per-source sequence**，否則 ingest 會 desync（首筆非 0 即被 `ErrSequenceGap` 拒）。本 slice 不實作 producer，只 enforce kernel 端規則。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**:
  - 現況（P1-S3 後）：Go kernel 已有 in-memory append-only log + Go verifier，hash/frame/genesis/checkpoint 常量 byte-for-byte 對齊 P0-S5 的 TS 契約。**尚無持久化**：進程死亡即失憶，且 sequence 僅是「append 進來的順序」，**無 per-source 的 ingest 完整性概念**。
  - 本 slice 補兩件事：(a) 把 log 落到 durable 檔（fsync-after-write semantics + 重載/自檢 + 無改寫面）；(b) 在 kernel enforce **per-source** 的 ingest 完整性（monotonic + gap detection + regression/replay 拒收），且該狀態由 durable log 重建。
  - **關鍵設計分辨（避免污染 P0-S5 byte-for-byte 契約）：** 鏈內 `sequence`（chain position，用於 `computeEntryHash(event, prevHash, sequence)`）與 ingest 的 `sourceSeq`（per-`sourceId` 的單調序）是**兩個不同欄位**。本 slice **不改動** `entryHash` / `frame` / `checkpointBytes` / genesis 的任何定義（那些屬 P0-S5 / P1-S3）；per-source sequence 是**新增的 ingest 完整性層**。
  - **`sourceId` / `sourceSeq` 為 out-of-leaf metadata（釘死，方案 a）：** `SourceID` 與 `SourceSeq` 是 `LogRecord` struct 的**頂層 metadata 欄位**（與 `EntryHash`/`Canonical` 同層），與 record **一起持久化**，但**不**被序列化進 `event` leaf、**不**進 `canonicalBytes`、**不**餵 `computeEntryHash`。因此 `entryHash` 與 cross-language conformance **完全不受影響**（pinned TS `LogEntry` = `{sequence, event, prevHash, entryHash}`，本就無 sourceId/sourceSeq；本 slice 維持一致）。**`computeEntryHash` 仍只吃 `(event, prevHash, sequence-chain-position)`。** 此為單一事實，全 doc 一致；不存在「sourceId/sourceSeq 進 leaf」的描述。
- **Modules touched（每個一句唯一責任，high cohesion 自證）**:
  - `kernel/internal/store`（新增）— **唯一責任**：把 log record durable 落地（append-only、fsync-after-write 才 committed）並能於重啟後**完好或拒絕**地重載（半截即拒，不靜默截斷）。
  - `kernel/internal/sequence`（新增）— **唯一責任**：以 per-`sourceId` 的 `lastSeq` 狀態 enforce monotonic ingest，對 gap / regression / replay 回具名 error（fail-closed）。
  > **不在本 slice 觸及（P1-S1 已擁有）**：`kernel/go.mod`、`kernel/.golangci.yml` 由 P1-S1 建立；本 slice 只**增補**前述 `internal/store`/`internal/sequence` 的 depguard rule（對既有檔的 EDIT），不重述 module bootstrap 或 verify:go 翻轉。
- **PUBLIC interface（新增/變更的對外公共面；internal 套件對 *kernel 外* 不可見，此處列 kernel *內部* 的 package public surface）**:
  ```go
  // package store  (kernel/internal/store)
  type LogRecord struct {
      Sequence   uint64 // chain position (P0-S5 contract; feeds computeEntryHash)
      PrevHash   string // "sha256:"-prefixed
      EntryHash  string // "sha256:"-prefixed
      SourceID   string // ingest completeness namespace
      SourceSeq  uint64 // per-source monotonic ingest sequence
      Canonical  []byte // already-redacted canonical event bytes (S0.2/S0.7)
  }

  // Append durably persists rec; returns only AFTER fsync succeeds. No update/delete/truncate.
  func (s *Store) Append(rec LogRecord) (committedOffset uint64, err error)

  // Load replays the durable file, recomputes head, and rejects any torn/truncated tail.
  func (s *Store) Load() (records []LogRecord, headEntryHash string, err error)

  // package sequence  (kernel/internal/sequence)
  var ErrSequenceGap = errors.New("sequence gap: missing record(s) before this sourceSeq")
  var ErrSequenceRegression = errors.New("sequence regression: stale or duplicate sourceSeq")

  // Admit enforces sourceSeq == lastSeq+1; advances lastSeq on success, else returns a named error.
  func (t *Tracker) Admit(sourceID string, sourceSeq uint64) error

  // Rebuild reconstructs per-source lastSeq from durable records (state is NOT memory-only).
  func (t *Tracker) Rebuild(records []store.LogRecord) error
  ```
  > **不對外（非公共面）**：檔案 framing 格式、WAL 編碼、offset 算法、tmp/rename 細節——皆 `internal` 實作，不洩進 record 型別（不進 `LogRecord` 公共面）。但**因本 slice 是首個落地 record 到磁碟的 slice、且 torn-tail RED fixture 需可構造**，故在此釘死 at-rest framing（內部契約，供 `store.Append`/`Load` 與 torn-tail fixture 構造用）：
  >
  > **(internal) on-disk record-at-rest framing：** 每筆 record 以 **`[8-byte big-endian body-length][body]`** 寫入（body = record 的確定性序列化 bytes，例如 length-prefixed 各欄位或單一 JSON line）。`Append` = 寫完整 `[len][body]` 後 `fsync` 才回 committed。「torn / half-written tail」定義為：(t1) 檔尾只有部分 length-prefix（< 8 bytes）；(t2) length-prefix 完整但 body 不足宣告長度（body 被截）。`Load()` 逐筆讀 `[len]` 再讀 `len` bytes body；遇 (t1)/(t2) → 回 error（**拒絕**，不靜默截斷成「較短但看似完好」的鏈）。
  > **與 S0.5 leaf `frame()` 的明確分離：** 此 at-rest framing 是**儲存層**用途（區隔磁碟上相鄰 record），與 S0.5 的 `frame()`（用於 `computeEntryHash` 的 hashing 輸入）**互不相干、不可混用**——兩者各自有 8-byte BE length-prefix 只是巧合的編碼選擇，語義與作用域不同（hashing vs storage）。本 slice **不**改動 S0.5 `frame()`。
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle；adapters → application → domain）:
    ```
    kernel/cmd | kernel/ingest(後續 P1-S6) ──▶ kernel/internal/sequence ──▶ kernel/internal/store
                                          ──▶ kernel/internal/verify (P1-S3, 啟動自檢) ──▶ kernel/internal/{chain,canonical} (P1-S2 常量)
    store ──▶ Go stdlib (os/bufio/encoding/binary/crypto)  ; sequence ──▶ store(型別) + stdlib
    ```
    （`store` 不 import `sequence`；`sequence` 只依賴 `store` 的 **record 型別**做 rebuild，不反向。`verifier` 不 import `store`/`sequence` 的寫入路徑——啟動自檢由上層把 `Load()` 出來的 records 餵給 verifier，保持「verifier 只吃資料、不碰 log 內部」與 P0-S5 一致。）
  - 僅經 public surface 消費（無 deep import）: ☑ 是（跨 plane 無 import；Go 內部僅經各 package 的 exported surface）。
  - 新依賴宣告（逐一證明 inward + acyclic + justified）:
    - **無新第三方依賴**。store 僅用 Go stdlib（`os`、`bufio`、`encoding/binary`、`crypto/sha256`），fsync 用 `(*os.File).Sync()`。理由：架構明令「在護城河上發明 crypto / 引第三方持久化」屬風險，YAGNI——P1「先簡」只需 stdlib 的 append + fsync + length-prefixed framing。
    - **depguard 規則**（**增補**進 P1-S1 既有 `.golangci.yml`，非新建檔）：方向=inward（`internal/store` 不得 import `internal/sequence` 或任何 control-plane import path；二者不得 import `internal/verify` 寫入路徑）、cycle=無（store↔sequence 單向）、理由= HARD CONSTRAINT A 的 Go 端執法，由既有 `verify:go` 承接。
- **P0-S5 contract conformance（本 slice 觸及持久化但**不重定義** hash/sign，故此處只「不破壞」並「重用」）**:
  - genesis prevHash = `"sha256:" + 64×"0"`、`entryHash = sha256(frame(canonicalBytes(event) ‖ prevHash ‖ sequence))`、checkpoint = Ed25519 over `frame(headEntryHash ‖ length)`、`"sha256:"` 版本化前綴——**全部沿用 P1-S3/P0-S5 既有實作，本 slice 一個常量都不改**。store 持久化的是「已算好的 record」，`Load()` 後重算 head 時呼叫的是 P1-S3 的 `computeEntryHash`/verifier，**不另寫一份**（避免兩份定義漂移 → 跨語言 conformance 由 P1-S3 golden 保證）。

## (5) Test-first plan（先寫的 RED Go 測試）
- 測試檔: `kernel/internal/store/store_test.go` + `kernel/internal/sequence/sequence_test.go`（新增）；torn-write fixture 置 `kernel/internal/store/testdata/`。
- 執行指令（Go RED 先行；本 slice 的「RED」是 `go test` 非零）:
  ```bash
  cd kernel && go test ./internal/store/... ./internal/sequence/...
  ```
- RED 測試清單（每條對應一個行為/不變量；實作前皆應紅）:
  - [ ] **durable round-trip / 重啟後仍 verify**：`Append` 三筆（fsync 後）→ 新建 `Store` 對同一檔 `Load()` → 重載 records 餵 P1-S3 verifier 回 `ok`，且 `headEntryHash` 等於最後一筆 `EntryHash`。
  - [ ] **per-source monotonic（happy path）**：`Admit("src-a", 0)`、`Admit("src-a", 1)`、`Admit("src-a", 2)` 皆成功；兩個 source 各自獨立計數（`src-b` 從 0 起不受 `src-a` 影響）。
  - [ ] **安全對抗式（gap detection — 退出條件直接命中 roadmap §3.1）**：`Admit("src-a", 0)` 後 `Admit("src-a", 2)`（丟掉中間 1）→ 回 `ErrSequenceGap`，**不**接受、`lastSeq` 不前進。
  - [ ] **安全對抗式（first-seen 起始序號 != 0 → gap，0-based 規則的 tested invariant）**：對一個從未見過的 source 首次 `Admit("src-new", 1)`（首見卻非 0）→ 回 `ErrSequenceGap`（**不**靜默接受），證明「首見 source 起始 `sourceSeq` 必須 == 0」是被測試強制的不變量、非僅散文。
  - [ ] **安全對抗式（regression / replay 拒收）**：`Admit("src-a", 0..2)` 後 `Admit("src-a", 1)`（回放較舊）與 `Admit("src-a", 2)`（重複）→ 皆回 `ErrSequenceRegression`，fail-closed 拒收。
  - [ ] **安全對抗式（fail-closed：半截 / 未 fsync 寫入）**：以 testdata 模擬「最後一筆 framing 被截斷一半」的檔 → `Load()` 回 error（不得回「較短但看似完好」的鏈）；以及「寫到一半（length-prefix 已寫、body 未寫完）」→ 同樣拒絕。
  - [ ] **安全對抗式（sequence 狀態由 durable log 重建，非僅記憶體 → 防 fail-open 漏報）**：`Append` 含 `src-a` 至 `sourceSeq=2` → 新 `Tracker.Rebuild(Load())` → 對該 source `Admit("src-a", 2)` 回 `ErrSequenceRegression`（證明重啟後仍記得 `lastSeq=2`）、`Admit("src-a", 4)` 回 `ErrSequenceGap`（證明重建後仍偵測缺序，不因重啟而 fail-open）。
  - [ ] **安全對抗式（no rewrite surface）**：store 的 exported API **無** `Update`/`Delete`/`Truncate`/`Seek`+write（編譯期：reviewer 呼叫不存在方法應 `go build` 失敗；測試以「只暴露 Append/Load」斷言）。
  - [ ] **安全對抗式（credential non-leak）**：record 持久化的是 **已 redact 的 canonical bytes**（S0.2/S0.7 出口）；測試把一個 runtime 組裝的 canary（不落 fixture 原文，呼應 test-and-acceptance §3.2）放進 event free-form 欄位 → 經 redaction 後 `Append` → 讀回檔 bytes grep 不到 canary 原值。
- 首次紅燈證據（貼 exit≠0；package 尚未存在 / 函式未實作）:
  ```
  $ cd kernel && go test ./internal/store/... ./internal/sequence/...
  # 期望（RED）：
  #   no Go files in .../internal/store    或   undefined: store.Store / sequence.Tracker
  go: build failed
  exit code: 1
  ```
  > **RED 真實性（防假測試，呼應 adversarial-code-review §4.8）**：reviewer 須能用「暫時把 `Admit` 的 gap 分支改成 `return nil`」這類 mutation 讓 gap 測試由綠轉紅；以及把 `Load()` 的 torn-tail 檢查拿掉讓「半截 → error」測試轉紅——證明測試真的在斷言這些不變量。

## (6) Definition of Done（每條附指令證據）
- [ ] **Test-first 成立**：實作前先有對應 RED（首次紅燈已貼於 §5；含 mutation 可使之轉紅的說明）。
- [ ] `pnpm run verify` **exit 0**（含級聯 `verify:go`；`verify:go` 已由 P1-S1 enforcing，本 slice 在新增 store/sequence 後維持綠）
  ```
  $ pnpm run verify
  ... verify:go ... ok
  exit code: 0
  ```
- [ ] `cd kernel && go test ./...` **exit 0**（store + sequence 全綠；含 durable round-trip、gap、regression、torn-tail、rebuild）
- [ ] **`verify:go` 邊界閘綠（本 slice 的窄義務 = 證明新增的 store/sequence 規則非 no-op）**：`golangci-lint run ./...`（depguard）exit 0 —— `internal/store` 未 import `internal/sequence`、二者未 import control-plane / SDK / `internal/verify` 寫入路徑；無 cycle。
  > **HARD CONSTRAINT A（Go 端）**：`verify:go` 的 skip→enforcing 翻轉由 **P1-S1 擁有**（本 slice **不**重述）；本 slice 的對抗義務**僅限本 slice 新增的規則**——reviewer 須在 **clean checkout** 上植入「`internal/store` import `internal/sequence`（或 deep-import 跨 plane）」的違規 fixture，親跑 `golangci-lint run` 確認 **exit≠0**（only-command-output-is-truth），移除後 exit 0；並確認 `store` 的 exported API **無** `Update`/`Delete`/`Truncate`/`Seek`+write（§5 no-rewrite-surface 的編譯期斷言）。
- [ ] **dependency-boundary check 綠**：TS 腿 `pnpm run deps:check` exit 0（本 slice 不動 `src/`，僅確認未引入回邊）；Go 腿如上。
- [ ] **low coupling / high cohesion 遵守**：`store`/`sequence` 各單一責任；verifier 只吃 `Load()` 出的 records（不 import store 內部）；無新跨 module / cyclic 依賴。
- [ ] **secret-scan 乾淨**：source / testdata / 持久化檔 fixture 無 secret-like 值；canary 為 runtime 組裝（不入 fixture 原文）；`Append` 寫出的 bytes 經 redaction，reviewer canary 在持久化檔 0 命中。
- [ ] **Docs 更新**：在 `kernel/README.md`（或 kernel doc）說明「durable store = append-only + fsync-after-write 才 committed + 重載自檢 + 無改寫面；per-source sequence 由 durable log 重建；transactional outbox / commit-before-effect = P1-S5；gRPC ingest = P1-S6」，避免過度宣稱（本 slice **未**達成跨進程隔離與 commit-before-effect）。
- [ ] **Adversarial code review = PASS**（fresh-context；主攻面：§4.5 audit gap/tamper —— 試「半截寫入被當完好」「sequence 狀態僅記憶體 → 重啟後 gap 漏報 fail-open」「torn-tail 被靜默截斷」「呼叫隱藏的改寫面」）— 連結/摘要: <...>
- [ ] **（安全不變量類 slice）Independent Verifier Pass 已執行並 clean**：對抗式探測 gap/regression/replay 皆 fail-closed、torn/未-fsync 重載皆拒絕、sequence 狀態確由 durable log 重建——皆以 `go test` 輸出為 HELD 證據；並確認 doc 未宣稱已達 P1-S5/P1-S6 之能力。

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（僅還原 `kernel/internal/store`、`kernel/internal/sequence` 與其測試，以及對 `.golangci.yml` 增補的 store/sequence depguard rule；**`kernel/go.mod` 與 `.golangci.yml` 本體屬 P1-S1，本 slice 回退不刪除它們**——回退後 `kernel/` module 與 `verify:go` enforcing 仍在，僅少了 store/sequence 套件與其邊界規則）。
- 可逆性: **程式碼層安全可逆**（純新增 module、無改既有 TS）。**資料/audit 層前瞻**：本 slice 引入**durable、append-only** 的證據檔——一旦有真實鏈寫入，**回退程式碼不得改寫/刪除已寫入的歷史檔**（slice-spec §7：audit 為 append-only，糾錯靠 forward-correcting event，不改寫歷史）。回退僅停用 *新寫入路徑*，既存檔以 forward-fix 處理。Phase 1 開發期間的測試檔位於 testdata / 臨時目錄，回退即清臨時目錄，無外部副作用。

## (8) Depends-on / blocks
- **Depends-on**:
  - **SLICE-P1-001（P1-S1）**（kernel module bootstrap：`kernel/go.mod` + `.golangci.yml` depguard + `verify:go` enforcing 已就位）—— 本 slice 在其既有 module 內新增套件並**增補**（非新建）depguard rule。
  - **SLICE-P1-003**（Go kernel 的 in-memory append-only log + standalone Go verifier）—— 本 slice 重用其 record 型別與 verifier（`internal/verify`）做啟動自檢，**不重定義** hash/sign 常量。
  - **SLICE-P1-002**（pinned primitives `internal/chain`/`internal/canonical`）—— 啟動自檢的 `computeEntryHash` 來源。
  - （契約前置，已 merge）**SLICE-P0-005**（TS evidence-kernel v0 契約：常量真相來源）、**SLICE-P0-008**（`verify:go` cascade）、**SLICE-P0-003**（deps 哲學）。
- **Blocks**:
  - **SLICE-P1-005**（transactional outbox + synchronous-commit-before-effect）—— 需要本 slice 的「fsync 後才 committed」作為 commit-before-effect 的底層保證。
  - **SLICE-P1-006**（跨進程 gRPC ingest path）—— 需要本 slice 的 durable store + `Admit` 作為 ingest 落地與完整性 enforcement 的後端。
- 確認 slice DAG 無 cycle: ☑ 是（INDEX.md 直接邊 `P1-S4 -> {P1-S3}`；P1-S3 → P1-S2 → P1-S1，S0.5 為 P0 更低 rank；P1-S5/P1-S6 → P1-S4，皆從高 rank 指向**嚴格較低** rank，無回邊 ⇒ DAG）。
