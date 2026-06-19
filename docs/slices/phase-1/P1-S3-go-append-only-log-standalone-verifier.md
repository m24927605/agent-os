# SLICE-P1-003: Go AppendOnlyLog（in-memory 參考）+ standalone verifier（tamper/reorder/gap/bad-sig 黃金測試）

- **Phase**: P1（roadmap §3.1「Go evidence kernel — 先簡後繁」：先 simple signed append-only hash-chain + standalone verifier；對齊 architecture-approach.md §4 Phase 1）
- **Branch**: slice/p1-003-go-append-only-log-standalone-verifier
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~240、files <~6（`internal/log/log.go`、`internal/verify/verify.go`、`cmd/verifier/main.go` + 各自 `_test.go`）、modules <~2（`internal/log`、`internal/verify`）
- **Slice JSON id**: `P1-S3`（本檔以 slice-spec §6 編號慣例落為 `SLICE-P1-003`；兩者同指此 slice）

> **本檔的 EXECUTION-TIME EVIDENCE 規則（繼承 phase-0 INDEX §2.1）：** §5/§6 中所有指令 transcript 與
> exit code（`exit code: 1`、`... ok`…）**都是樣板佔位、不是已達成的結果**；必須在執行時被**真實輸出覆蓋**，
> 覆蓋前不得據此宣稱 slice 已綠/done。First-RED 必須是寫任何 Go 實作前真實跑出的 `go test` 失敗輸出並 commit
> （test-first），adversarial reviewer 須經 git history / 親自還原實作重跑再確認 RED 為真。

---

## (1) ID + Title

SLICE-P1-003 — 在 Go evidence kernel（`kernel/`）內新增**只有 append 的 `AppendOnlyLog`**（回 hash-chained
receipt + checkpoint over head，沿用 P1-S2 的 pinned primitives）與一個**僅依賴 public chain + checkpoint +
publicKey 的 standalone verifier**（lib + `cmd/verifier` CLI）：對完好鏈回 exit 0、對 tamper / reorder / gap /
bad-sig 回非零（黃金測試）。`kernel/` module 與 enforcing `verify:go`（`go.mod` + `.golangci.yml` + depguard +
`internal/`）**由 P1-S1 已建立**；本 slice 在其上新增 log/verify/CLI 並**增補一條** depguard rule（`verify` 不得
import `log`），使 `pnpm run verify` 級聯維持單一 exit 0。

## (2) Goal（一句話）

新增 Go 的 `AppendOnlyLog`（無 update/delete 面、append 回 `{sequence, contentHash, prevHash, entryHash}` +
checkpoint over head）與一個只吃 `entries + checkpoint + publicKey`、不 import log internals 的 standalone
verifier（對完好鏈 exit 0、對 tamper/reorder/gap/bad-sig 回第一個破點 `{brokenAt, reason}` 並 exit≠0）。

> 出現「以及」即拆分——本 slice 的 log 與 verifier 雖是兩個 module，但**單一意圖** = 「立起 Go 端 in-memory 的
> append-only 證據鏈 + 其獨立驗證器，並以黃金測試鎖定破鏈偵測」。log 是 verifier 的被測對象，二者構成一個
> 不可再分的最小可驗收行為增量（沒有 log 就無從產生鏈供 verifier 驗）。

## (3) In-scope / Out-of-scope

- **In-scope：**
  - `kernel/internal/log/log.go`：`AppendOnlyLog`（in-memory 參考實作，標註 `reference only, not durable`）。
    `Append(event) AppendReceipt`，**型別/方法面上無 `Update`/`Delete`/任何改寫面**（append-only by
    construction）。receipt 攜 `Sequence/ContentHash/PrevHash/EntryHash`；另暴露 `Entries()`（回 copy）與
    `Checkpoint()`（checkpoint **over chain head**，非 per-entry 簽）。沿用 **P1-S2 的 pinned primitives**
    （`frame`、`computeEntryHash`、`checkpointBytes`、`GenesisPrevHash`、`canonicalBytes`、Ed25519 sign）——
    **不重新發明**這些常量（DRY；P1-S2 已釘死且為 TS↔Go conformance 的 byte-for-byte 來源）。
  - `kernel/internal/verify/verify.go`：`VerifyChain(chain, publicKey) VerifyResult` — 重算 prev-hash 串接、
    驗 `sequence` 單調（`entry.Sequence == i`）、驗 prev-hash linkage、重算 `entryHash` 比對、驗 checkpoint
    length/head、驗 **Ed25519 checkpoint 簽章**；回 `{Ok:true, Length}` 或第一個破點 `{Ok:false, BrokenAt,
    Reason}`。**verifier 只吃 `entries + checkpoint + publicKey`，不 import `internal/log`**（獨立性名實相符，
    由 depguard 鎖定）——它與 log **共用 P1-S2 的 pinned 純函式**（同一 hash/frame 定義是「獨立重算」的前提，
    不是耦合：見 §4 dependency-direction 的「shared pure primitives, not internals」說明）。
  - `kernel/cmd/verifier/main.go`：standalone verifier **CLI** — 從 stdin / `--chain <file>` 讀
    `SignedChain` JSON + `--pubkey <file>`（PEM/DER Ed25519 public key），呼叫 `VerifyChain`，**完好鏈
    print `ok length=N` 並 exit 0；任何破鏈 print `broken at <seq>: <reason>` 並 exit 非 0（建議 exit 1）**。
    CLI **只依賴 public chain + checkpoint + publicKey**（不依賴任何 log 實例 / 私鑰 / log internals）。
  - **depguard rule 增補（對 P1-S1 既有 `kernel/.golangci.yml` 的 EDIT，非新建）：** 在 P1-S1/P1-S2 既有的
    `.golangci.yml` 內**增補一條** rule：`kernel/internal/verify` 不得 import `kernel/internal/log`（使 standalone
    名實相符）；P1-S1 的三條跨 plane deny rule 與 P1-S2 的 `canonical 不得 import chain` 規則沿用不改。
    **`kernel/go.mod`、`kernel/.golangci.yml` 由 P1-S1 擁有並已 merge，本 slice 不重建**；`verify:go` 進場時**已是
    enforcing**（P1-S1 完成翻轉）。**P1-S2 已建立的 primitives 套件分為兩個**：`kernel/internal/chain`（`Frame`/
    `ComputeEntryHash`/`CheckpointBytes`/`GenesisPrevHash` + `sign.go` 的 `SignCheckpoint`/`VerifyCheckpoint`）與
    `kernel/internal/canonical`（`CanonicalBytes`）——由本 slice depends-on，不在本 slice 內新建。
  - **RED 黃金測試（test-first，先紅）：** `kernel/internal/log/log_test.go` + `kernel/internal/verify/verify_test.go`
    + `kernel/cmd/verifier/main_test.go`，涵蓋：intact→ok、tamper 中間 event→broken、reorder→broken、
    gap（移除中間一筆，seq 1,2,4）→broken、錯 publicKey→broken；CLI 的 intact→exit 0 / broken→exit≠0。

- **Out-of-scope（明確不做，註記留給哪個後續 slice）：**
  - durable 持久化（SQLite-backed tile store / fsync WORM）/ **monotonic per-source 多來源 sequence**
    （per-tenant、多 producer 協調）→ **P1-S4**（本 slice 的 sequence 單調是**單一 log 內、in-memory**）。
  - transactional outbox / **synchronous-commit-before-effect** 時序保證 → **P1-S5**。
  - 跨進程 gRPC ingest path（kernel 作為 separate process / identity，control plane 只能 append）→ **P1-S6**。
  - **TS↔Go 雙向 cross-language conformance**（TS 產生的鏈在 Go verifier 驗、反之亦然）→ **P1-S7**。
    本 slice 的 Go log 與 verifier **必須**沿用 P1-S2 pinned 常量以使 P1-S7 可行，但**不在本 slice 跑跨語言對拍**。
  - 真實 Tessera tile-log / RFC-3161 外部錨定 / WASM verifier build → **P4**（roadmap §3.4；本 slice 是「先簡」）。

## (4) Design delta + modules + public interface + dependency direction

- **Design delta：** 在 P1-S2（Go plane scaffolding + pinned primitives）之上，新增「能 append 成鏈」與「能獨立
  驗鏈」兩個能力。型別/方法面上排除改寫（無 `Update`/`Delete`）把 architecture-approach.md「control plane 無
  改寫權」在 Go 語言層先以「無改寫 API」近似（真正的 separate-process / identity 隔離在 P1-S6；本 slice **不**
  宣稱已達進程級不可改寫——見 §6 對抗面註記）。verifier 與 log **語言/封裝上分離**：verifier 不 import log 套件，
  只重算 public surface 上的鏈，使「standalone」名實相符。

- **Modules touched（每個一句唯一責任，high cohesion 自證）：**
  - `kernel/internal/log/log.go`（新增）— **唯一責任**：定義「只可 append、回 hash-chained receipt + checkpoint
    over head」的 in-memory 參考 log，沿用 P1-S2 primitives 計算 `entryHash`/checkpoint。
  - `kernel/internal/verify/verify.go`（新增）— **唯一責任**：對外部交付的 `entries + checkpoint + publicKey`
    獨立重算並驗證鏈完整性（hash + sequence 單調 + linkage + checkpoint 簽章），回第一個破點；**不持有、不讀取**
    任何 log 實例狀態。
  - `kernel/cmd/verifier/main.go`（新增）— **唯一責任**：把 `VerifyChain` 包成 process exit-code 介面（完好→0、
    破鏈→非 0），供 auditor 以「信任 ~一個小 binary、不信任我們平台」的方式獨立驗章。
  - `kernel/.golangci.yml`（**EDIT，非新增**；檔案由 P1-S1 擁有）— **唯一責任**：對既有 depguard 設定**增補一條**
    rule `internal/verify` 不得 import `internal/log`（使 standalone verifier 名實相符）；P1-S1 的跨 plane deny rule
    與 P1-S2 的 `canonical 不得 import chain` 沿用不改。**`kernel/go.mod` 與 `verify:go` skip→enforcing 翻轉屬
    P1-S1，本 slice 不重建、不重述**。

- **PUBLIC interface（新增/變更的對外公共面；internal 實作不列）：**
  > Go 慣例：以下型別/函式為各 `internal/` 套件的 exported 識別符（kernel 模組**內部**可見；對 control plane /
  > SDK 不可見——`internal/` 封裝 + depguard 雙重保證）。CLI 的「公共面」是其 **stdin/flags/exit-code 契約**。

  ```go
  // package log  (kernel/internal/log)
  // GENESIS_PREV_HASH 等常量沿用 P1-S2（不在此重新定義）。
  type AppendReceipt struct {
      Sequence    int
      ContentHash string // "sha256:"-prefixed（演算法前綴版本化，不硬編未來 blake3:）
      PrevHash    string
      EntryHash   string
  }
  type LogEntry struct {
      Sequence  int
      Event     any // 結構性事件表示（P1-S2 canonical 吃 map[string]any；不引入 AuditEvent Go struct）
      PrevHash  string
      EntryHash string
  }
  type Checkpoint struct {
      Length        int
      HeadEntryHash string
      Signature     string // base64，Ed25519 over checkpointBytes(headEntryHash, length)
  }
  type SignedChain struct {
      Entries    []LogEntry
      Checkpoint Checkpoint
  }
  // AppendOnlyLog：append-only by construction —— 介面上**沒有** Update/Delete。
  type AppendOnlyLog interface {
      Append(event any) AppendReceipt   // event = 結構性表示（map[string]any），對齊 P1-S2 canonical
  }
  // InMemoryAppendOnlyLog（reference only, NOT durable）— 另暴露：
  //   Entries() []LogEntry      // 回 copy，不洩內部 slice
  //   Checkpoint() Checkpoint   // checkpoint over chain head（非 per-entry）
  func NewInMemoryAppendOnlyLog(pub ed25519.PublicKey, priv ed25519.PrivateKey) *InMemoryAppendOnlyLog

  // package verify  (kernel/internal/verify) — 只吃 public chain + publicKey，不 import internal/log
  type VerifyResult struct {
      Ok       bool
      Length   int    // when Ok
      BrokenAt int    // when !Ok（第一個破點 sequence）
      Reason   string // when !Ok（人類可讀；見下「Reason 字串非契約面」）
  }
  func VerifyChain(chain SignedChain, publicKey ed25519.PublicKey) VerifyResult
  ```
  > **Reason 字串非 byte-for-byte 契約面（避免脆弱的跨語言 string coupling）：** pinned TS `verify.ts` 的 `reason`
  > 為較完整的散文（`"entry hash mismatch (tampered content)"`、`"prev-hash linkage broken (reorder/insert/tamper)"`、
  > ``"sequence not monotonic: expected ${i}, got ${entry.sequence}"``、`"checkpoint signature invalid"`…）。本 slice
  > **採方案 (a)：Go `Reason` 字串 verbatim 採用 TS `verify.ts` 的散文**（同一 reason 文字，便於人讀對照），但**明確聲明
  > `Reason` 字串本身不屬 S0.5 byte-for-byte pinned 契約**——pinned 的只有 `Ok`（bool）與 `BrokenAt`（int，且其值對齊
  > TS verifyChain 的 check 順序：missing → sequence → linkage → entryHash → checkpoint.length → head → signature）。
  > Go 測試**斷言 `Ok` + `BrokenAt` 為硬契約、`Reason` 以 substring/穩定子句比對**（不依賴全文逐字），P1-S7 跨語言對拍
  > 亦只比對 `Ok`/`BrokenAt`，不比對 `Reason` 全文。

  - **CLI 契約（`cmd/verifier`，process-level public surface）：**
    - 輸入：`--chain <file>`（或 stdin）= `SignedChain` JSON；`--pubkey <file>` = Ed25519 public key（PEM/DER）。
    - 輸出/退碼：完好鏈 → stdout `ok length=<N>`、**exit 0**；破鏈 → stderr `broken at <seq>: <reason>`、
      **exit 1**；輸入無法解析 / 缺 pubkey / 任何內部錯誤 → **exit 非 0（fail-closed，絕不 exit 0）**。

- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）：**
  - 箭頭圖（向內、無 cycle）：
    ```
    cmd/verifier ──▶ internal/verify ──▶ internal/chain     (Frame/ComputeEntryHash/CheckpointBytes/GenesisPrevHash/SignCheckpoint/VerifyCheckpoint)  [P1-S2]
                                     ──▶ internal/canonical  (CanonicalBytes)                                                                          [P1-S2]
                                     ──▶ crypto/ed25519, crypto/sha256, encoding/json   [stdlib]
    internal/log ──▶ internal/chain     (同上 pinned primitives)   [P1-S2]
                 ──▶ internal/canonical (CanonicalBytes)           [P1-S2]
                 ──▶ crypto/ed25519, crypto/sha256                 [stdlib]
    ```
    - **關鍵（standalone 名實相符）：`internal/verify` 不 import `internal/log`。** verify 與 log 都 import P1-S2 的
      **兩個 pinned 純函式套件**：`internal/chain`（`Frame`/`ComputeEntryHash`/`CheckpointBytes`/`GenesisPrevHash` +
      `SignCheckpoint`/`VerifyCheckpoint`）與 `internal/canonical`（`CanonicalBytes`）。depguard 規則 = 允許
      `internal/{verify,log} → internal/{chain,canonical}`、**禁** `internal/verify → internal/log`。
      這是 **shared pure primitives, not shared internals**：用「同一個 hash/frame 定義去重算」正是獨立驗證的
      *前提*（若 verifier 用不同定義重算，就無法判斷鏈是否完整）；它不讓 verifier 依賴 log 的**狀態或實作**。
      depguard 規則把「verify import log」設為禁止（error），使這條獨立性**由指令證明**而非口頭宣稱。
  - 僅經 public surface 消費（無 deep import）：☑ 是（跨平面：kernel 與 TS control plane **零** import，僅未來
    經 gRPC proto 對話——本 slice 不引入 gRPC，故跨平面 import 面 = 空）。
  - 新依賴宣告（逐一證明 inward + acyclic + justified）：
    - **無新第三方依賴。** log/verify/CLI 僅用 Go **stdlib**（`crypto/ed25519`、`crypto/sha256`、
      `encoding/json`、`encoding/pem`、`flag`、`os`）+ P1-S2 既有的 pinned primitives 套件。
      方向=inward（cmd→verify→primitives；log→primitives）；cycle=無（verify 不依賴 log，log 不依賴 verify）；
      理由=不在護城河上 hand-roll crypto（用 stdlib ed25519/sha256），且零新增 supply-chain 表面（DRY/YAGNI）。
    - **depguard / golangci-lint（dev 依賴，非 runtime）：** 經 `verify:go` cascade（S0.8）要求；它執法邊界，
      不被 production 程式碼 import。理由=HARD CONSTRAINT A 的 Go 端指令化執法（test-and-acceptance.md §8）。

- **P1-conformance 契約常量（沿用 P1-S2 / 對齊 pinned TS 契約 SLICE-P0-005；本 slice 不得偏離一個 byte）：**
  - **genesis prevHash** = `"sha256:" + 64 個 "0"`（real value，非空字串、非省略欄位）。
  - **entryHash** = `sha256( frame( canonicalBytes(event) ‖ prevHash ‖ sequence ) )`，`"sha256:"`-prefixed；
    `frame()` 對每個 part 以 **8-byte big-endian length-prefix** 串接（無分隔歧義）；`sequence` 以
    `String(sequence)` 的 UTF-8 bytes 入 frame（對齊 TS `textEncoder.encode(String(sequence))`）。
  - **canonicalBytes(event)** = S0.2 deterministic canonical serialization（遞迴 key 排序、UTF-8、拒
    non-finite/undefined）**在 redaction（by-key + by-value，S0.7）之後**。Go 端必須對相同 event 重算出
    **相同的 canonical bytes**（此為 P1-S7 跨語言對拍的根；本 slice 由 P1-S2 primitives 保證，不另實作）。
  - **checkpoint** = Ed25519 簽 `frame( headEntryHash ‖ length )` —— checkpoint **over chain head**（Tessera
    模型），**非 per-entry 簽**。空鏈時 `headEntryHash = GENESIS_PREV_HASH`、`length = 0`（邊界，見 §5）。
  - **演算法前綴版本化：** hash 一律帶 `sha256:` 前綴，**不得**對未來 `blake3:` 硬編斷言（前綴比較須容版本）。

## (5) Test-first plan（先寫的 RED Go 測試）

> **方法論（test-and-acceptance.md §1）：先寫會失敗的 `go test`（RED），再寫最小實作轉 GREEN，再 refactor。**
> 本 slice 是**安全不變量類 slice**（audit gap/tamper、credential non-leak），故 §5 **必含對抗式 RED**。

- 測試檔：
  - `kernel/internal/log/log_test.go`
  - `kernel/internal/verify/verify_test.go`
  - `kernel/cmd/verifier/main_test.go`

- **RED 測試清單（每條對應一個行為/不變量；先紅）：**
  - [ ] **Append-only / monotonic（log）：** 連續 `Append` 三筆 → `Sequence` 0,1,2；每筆 `PrevHash` == 前一筆
        `EntryHash`；首筆 `PrevHash` == `GENESIS_PREV_HASH`（`"sha256:"+64*"0"`）。
  - [ ] **Receipt 形狀（log）：** `ContentHash` / `PrevHash` / `EntryHash` 皆 `"sha256:"`-prefixed、非空。
  - [ ] **No-rewrite surface（compile-time，log）：** 型別層確認 `AppendOnlyLog` **無** `Update`/`Delete`；
        reviewer 嘗試呼叫不存在的方法應使 `go build`/`go vet` 失敗（編譯期保證，非 runtime if-check）。
  - [ ] **Chain verifies（verify）：** 完好鏈 + 正確 publicKey → `VerifyChain` 回 `{Ok:true, Length:3}`。
  - [ ] **對抗式 — tamper：** 改動中間一筆（i=1）的 event 內容（如 `resource = "/etc/passwd"`）→ 硬契約
        `{Ok:false, BrokenAt:1}`，`Reason` 含子句 `entry hash mismatch`（substring 比對，非全文）。
  - [ ] **對抗式 — reorder：** 對調 entries[0] 與 entries[1]（保留各自原 `sequence`）→ `{Ok:false, BrokenAt:0}`；
        因 entry[0] 現為原 seq 1 → check 順序在 sequence 步即破（`Reason` 含 `sequence not monotonic`）。
  - [ ] **對抗式 — gap（gap detection；harness 語義釘死）：** 從 0,1,2 三筆移除中間一筆，**保留各 entry 的原始
        `sequence`**（即 entries = `[{seq:0,...},{seq:2,...}]`，呈現於 index 0,1）→ verifier 在 i=1 處比對
        `entry.sequence(=2) != i(=1)` → `{Ok:false, BrokenAt:1, Reason: "sequence not monotonic: expected 1, got 2"}`。
        **harness 約定 = re-present-with-original-sequence**（不重排序號），故破點確定為 sequence-not-monotonic 而非
        prev-hash linkage——與 pinned TS verifyChain 的 check 順序（sequence 先於 linkage）一致、可預期。「缺一筆被
        偵測，而非靜默接受」。
  - [ ] **對抗式 — bad sig：** 用**不同**的 publicKey 驗 checkpoint → `{Ok:false, BrokenAt: len(entries)}`，
        `Reason` 含子句 `checkpoint signature invalid`（substring 比對）。
  - [ ] **邊界 — 空鏈 fail-open（防誤判，§key-risk 主攻面，兩個方向都斷言）：**
        (i) **intact 空鏈** = 0 筆 entries + `Checkpoint(){headEntryHash==GENESIS_PREV_HASH, length==0, signature=正確簽章}`
        → `VerifyChain` 回 `{Ok:true, Length:0}`（對齊 pinned TS：空鏈 `headEntryHash=GENESIS_PREV_HASH`、`length===0`、
        head=entries.at(-1)?? GENESIS）。
        (ii) **forged 空鏈** = 0 筆 entries 但 checkpoint 被竄改（改 `headEntryHash` ≠ GENESIS、或 `length` ≠ 0、或
        替換 `signature`）→ `VerifyChain` 回 `{Ok:false}`（**絕不** 因「沒有 entry 可重算」而 fail-open 判 ok——這是
        primary fail-open surface）。
        單筆鏈（1 筆）→ 完好 ok、tamper/bad-sig → broken。**此條直擊 §key-risk 與 reviewer §4.5 攻擊目標。**
  - [ ] **對抗式 — credential non-leak：** leaf 用 S0.2/S0.7 canonical（已 redact）；把 canary（runtime 組裝、
        明顯非真憑證，如 `["CANARY","SECRET",uuid].join("-")` 的 Go 等價）塞進 event 的 free-form 欄位 →
        斷言 `receipt` / `checkpoint` / `entries` 的序列化輸出**不含** canary 原值（只見 `[REDACTED]`）。
        canary **只在記憶體構造、不寫入任何 fixture 檔**（INDEX §2.1 第 4 點；secret-scan 不誤報）。
  - [ ] **CLI（cmd/verifier）：** 餵完好鏈 JSON + 正確 pubkey → stdout `ok length=3`、**exit 0**；餵 tamper /
        reorder / gap / bad-sig 之一 → stderr `broken at <seq>: <reason>`、**exit 非 0**；餵無法解析的輸入 /
        缺 pubkey → **exit 非 0（fail-closed）**。

- **首次紅燈證據（貼 exit≠0；套件/實作尚未存在 → 編譯失敗即 RED）：**
  ```
  $ cd kernel && go test ./internal/verify/...
  # internal/verify
  internal/verify/verify_test.go:NN:NN: undefined: VerifyChain
  FAIL    .../kernel/internal/verify [build failed]
  exit code: 1
  ```
  > test-and-acceptance.md §1.2：RED 必須因**斷言/缺實作**而紅（此處為 build-failed，缺 `VerifyChain`/`log`
  > 套件），非 import-typo；reviewer 須以 §3.3 第 4 步（還原實作後重跑 → 紅；還原回 → 綠）確認 RED 為真。

## (6) Definition of Done（每條附指令證據）

- [ ] **Test-first 成立**：實作前先有對應 RED 測試（首次紅燈 exit≠0 已貼於 §5，且 commit 早於實作 commit）。
- [ ] **`pnpm run verify` exit 0**（單一真相來源；**含級聯 `verify:go`**——`verify:go` 已由 P1-S1 enforcing，本 slice
      在新增 log/verify/CLI + 增補 depguard rule 後維持 `go vet ./... && go test ./... && golangci-lint run` 全綠，
      見 S0.8 / `scripts/verify-go.sh`）：
  ```
  $ pnpm run verify
  ... verify:go: ok
  ... secret-scan: clean
  exit code: 0
  ```
- [ ] **Go gate 綠（verify:go 內含）**：
  ```
  $ cd kernel && go vet ./... && go test ./... && golangci-lint run ; echo "exit=$?"
  ok   .../kernel/internal/log
  ok   .../kernel/internal/verify
  ok   .../kernel/cmd/verifier
  exit=0
  ```
- [ ] **standalone verifier 黃金測試（Phase-1 exit 條目）**：完好鏈 → CLI exit 0；tamper/reorder/gap/bad-sig →
      CLI exit≠0：
  ```
  $ cd kernel && go test ./cmd/verifier/... -run TestVerifierCLI -v ; echo "exit=$?"
  --- PASS: TestVerifierCLI/intact_exit_0
  --- PASS: TestVerifierCLI/tampered_exit_nonzero
  --- PASS: TestVerifierCLI/gap_exit_nonzero
  exit=0
  ```
- [ ] **dependency-boundary check 綠（HARD CONSTRAINT A，Go 端指令化）**：depguard 確認 `internal/verify`
      **未** import `internal/log`、kernel **未** import control-plane / SDK；`internal/` 封裝外部不可見。
      （TS 端 `pnpm run deps:check` 不受影響、維持 exit 0——本 slice 不動 `src/`。）
  ```
  $ cd kernel && golangci-lint run ; echo "depguard exit=$?"   # 違反邊界即非 0
  exit=0
  ```
- [ ] **low coupling / high cohesion 遵守**：log/verify/CLI 各單一責任；verifier 只吃 `entries+checkpoint+
      publicKey`（不 import log internals）；無新跨 module / cyclic 依賴（verify⊥log，僅共用 P1-S2 純函式）。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` 輸出 `secret-scan: clean`；reviewer 自設 canary 後在 6 個
      sink（workspace/logs/artifacts/snapshots/traces/fixtures）+ chain/receipt/checkpoint 序列化輸出 grep 0
      命中（kernel 只存**已 redact** 的 canonical bytes）。
- [ ] **Docs 更新**：在 `kernel/README.md`（或 phase-1 INDEX）明寫「**P1-S3 為 in-memory 參考 log + standalone
      verifier；非 durable、非跨進程隔離、非多來源 sequence**；durable=P1-S4、outbox/commit-before-effect=P1-S5、
      gRPC separate-process=P1-S6、TS↔Go conformance=P1-S7」，避免過度宣稱 tamper-evidence / 進程級不可改寫。
- [ ] **Adversarial code review = PASS**（fresh-context、!= author、refute-by-default；§4.5 audit gap/tamper
      與 §4.7 coupling/cohesion 為主攻面；reviewer 親自重跑 `pnpm run verify` + `cd kernel && go test ./...`）—
      連結/摘要：<...>。
- [ ] **（安全不變量類 slice）Independent Verifier Pass 已執行並 clean**：對抗式探測 tamper/reorder/gap/bad-sig
      皆使 verifier broken（exit≠0）、完好鏈 ok（exit 0）（**HELD**）；空鏈/單筆鏈邊界不 fail-open；credential
      non-leak HELD；並確認 doc **未**宣稱 P1-S3 已達進程級不可改寫 / 多來源 ingest 完整性（那是 P1-S4/S5/S6）。

> **DoD 釘選（slice-spec §6 / adversarial-code-review §5 MERGE GATE）：** 只有 reviewer 親跑且 exit 0 的輸出
> 算數；作者自述「我跑過了」不採信。任一必跑指令無法產生 exit code → verdict 一律 `BLOCKED`（不得 PASS）。

## (7) Rollback

- 回退方式：`git revert <merge-sha>`。同時移除 `kernel/`（或還原其缺 gate 狀態）會使 `verify:go` cascade 退回
  **skip exit 0**（S0.8 語義：plane 不存在 → skip）——回退後 `pnpm run verify` 仍可綠，**不**留下「plane 存在
  卻缺 gate」的 fail-closed 紅燈。
- 可逆性：**安全可逆**。本 slice 為 **in-memory 參考實作，無持久化、無外部副作用、無真實 durable append**，回退
  不毀任何已落地證據。
  - **前瞻（slice-spec §7）：** 一旦 P1-S4 起 kernel 變 durable，已寫入的鏈為 **append-only**，回退靠
    **forward-correcting event**，**不得改寫歷史**——本 slice 的 in-memory 性質使此前瞻在 P1-S3 階段尚不適用，
    但 doc 須先聲明此紀律，避免後續 slice 誤以為可 `git revert` 掉已 append 的 durable 紀錄。

## (8) Depends-on / blocks

- **Depends-on：**
  - **SLICE-P1-002（P1-S2）**（**直接邊**；P1-S2 自身 depends-on P1-S1，故 kernel module + enforcing `verify:go`
    透過 P1-S2 鏈上承接）— **pinned primitives**：`internal/chain`（`Frame`/`ComputeEntryHash`/`CheckpointBytes`/
    `GenesisPrevHash` + `SignCheckpoint`/`VerifyCheckpoint`）與 `internal/canonical`（`CanonicalBytes`）。**event 型別**：
    P1-S2 的 canonical 吃已 decode 的 `map[string]any`（**不**引入 AuditEvent Go struct）；本 slice 的 `LogEntry.Event`
    沿用同一結構性表示。本 slice **不重新實作**這些常量，只消費它們（DRY；conformance byte-for-byte 來源）。
  - **SLICE-P0-008（S0.8）** — `verify:go` polyglot cascade（fail-closed）：本 slice 一旦建立 `kernel/`，
    cascade 即要求 Go gate 配齊，故 S0.8 是把本 slice 的 Go gate「無法繞過 `pnpm run verify`」的前置。
  - （契約根，間接）**SLICE-P0-005（pinned TS 契約）/ S0.2 / S0.7** — 定義 genesis/entryHash/checkpoint/
    canonical+redaction 的 byte-for-byte 規格；P1-S2 已把它們搬進 Go，本 slice 沿用。
- **Blocks：**
  - **SLICE-P1-004（P1-S4）** — durable 持久化 + monotonic per-source sequence + gap detection（多來源）：
    建在本 slice 的 in-memory `AppendOnlyLog` + verifier 之上。
  - **SLICE-P1-005（P1-S5）** — transactional outbox + synchronous-commit-before-effect。
  - **SLICE-P1-006（P1-S6）** — 跨進程 gRPC ingest（kernel as separate process/identity，control plane 只能
    append）：本 slice 的 `AppendOnlyLog` 公共面是其 ingest 語義的型別來源。
  - **SLICE-P1-007（P1-S7）** — TS↔Go 雙向 cross-language conformance：本 slice 的 Go verifier 是被對拍的一端。
- 確認 slice DAG 無 cycle：☑ 是（INDEX.md 直接邊 `P1-S3 -> {P1-S2}`；P1-S2 → P1-S1，故 kernel module 透過鏈上承接。
  P1-S2 不依賴 P1-S3；S0.5/S0.8 為 P0，rank 更低；P1-S3 blocks 的 S4/S5/S6/S7 rank 更高，無回邊 ⇒ DAG）。

---

## Adversarial Review

> 本區段在 merge 前由 **fresh-context、!= author** 的 reviewer 依 `docs/standards/adversarial-code-review.md`
> §4 八面填寫並貼真實指令輸出；verdict = PASS 才可 merge。**主攻面（依本 slice 性質）：**
>
> - **§4.5 Audit gap / tamper（核心）：** 親手構造 tamper/reorder/gap/bad-sig，確認 verifier 皆 broken 且回
>   正確 `BrokenAt`；特別攻 **空鏈/單筆鏈邊界**（§key-risk 的 fail-open 面）——對空鏈偽造 checkpoint、對單筆鏈
>   抽空 head，確認**不被誤判為 ok**。
> - **§4.7 Low coupling / high cohesion（核心，blocking）：** 親跑 depguard 確認 `internal/verify` 未 import
>   `internal/log`（「standalone」名實相符，非共用 internals 而退化成 reorder/gap 偵測失效）；確認 log/verify
>   各單一責任、無 god module、無 cycle。
> - **§4.2 Fail-closed：** CLI 對無法解析輸入 / 缺 pubkey / 內部錯誤 → exit≠0（絕不 exit 0 偽綠）。
> - **§4.3 Credential leak（6 sinks + audit payload）：** canary 流經 event free-form 欄位 → 確認 chain/
>   receipt/checkpoint/CLI 輸出 0 命中（kernel 只存已 redact 的 canonical bytes）。
> - **§4.8 Claimed behavior：** 依 §3.3 第 4 步還原 Go 實作後重跑 `go test`（須紅）、還原回（須綠），確認
>   RED→GREEN 為真、測試非 always-green；並確認本 slice **未偷做** out-of-scope（durable / 多來源 sequence /
>   gRPC / 跨語言對拍）。
> - 其餘面（§4.1 deny-by-default、§4.4 cross-tenant、§4.6 idempotency/resume）依 §4 反濫用規則標 `N/A` 並附
>   結構性理由（本 slice 在 evidence kernel 的 audit 層，結構上不做 policy 決策、不跨租路由、不持久化故無
>   resume 面——P1-S4/S5 才引入），不可留白。

*本檔不含任何 secret-like 值。所有「綠/通過」欄位皆為樣板，必須在執行時被真實指令輸出與 exit code 覆蓋
（only command output is truth）；凡與 `AGENTS.md` 衝突，以 `AGENTS.md` 為準。*
