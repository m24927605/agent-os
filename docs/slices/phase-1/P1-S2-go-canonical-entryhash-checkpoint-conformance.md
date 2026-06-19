# SLICE-P1-002: Go canonical-bytes + entryHash + checkpoint，byte-for-byte conform 到 TS S0.5 契約（cross-language golden vectors 鎖定）

- **Phase**: P1（architecture-approach.md §4「先簡後繁」：P1 = simple signed append-only hash-chain + standalone verifier + ingest 完整性，**非** Tessera tile-log / RFC-3161 / WASM verifier——那些是 P4）
- **Branch**: slice/p1-002-go-canonical-entryhash-checkpoint-conformance
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~240、files <~7（`canonical.go` + `canonical_test.go`、`chain.go` + `chain_test.go`、`sign.go` + `sign_test.go`、`testdata/golden-vectors.json`、`scripts/gen-golden-vectors.ts`；**`kernel/go.mod` 與 `kernel/.golangci.yml` 由 P1-S1 擁有、不計入本 slice，本 slice 只對既有 `.golangci.yml` 增補一條 depguard rule**）、modules（Go package）<~2（`internal/canonical`、`internal/chain`）
  > **檔案所有權**：`kernel/go.mod`、`kernel/.golangci.yml`、`kernel/internal/version/*` 為 **SLICE-P1-001（P1-S1）** 擁有並已 merge；本 slice **不重新建立**它們，僅（a）新增 `internal/canonical` + `internal/chain` 套件與 golden fixture、（b）對 P1-S1 既有的 `.golangci.yml` **增補**一條 depguard rule（`internal/canonical` 不得 import `internal/chain`）。fixture 產生器 `scripts/gen-golden-vectors.ts` 的 LOC 計入本 slice（fixture provenance = TS 產、非 Go 自證，為 honest conformance 的 load-bearing 條目）。
- **Pillar / Feature**: F1；audit / evidence-kernel；cross-language conformance 的 primitive 基線（gating c1/c2 的證據可被 TS 與 Go 互驗）

> **鐵律重申（Looping Engineering）：只有指令輸出是真相。** 本 slice 為 PLAN（slice-doc），不寫任何 Go 程式碼。
> 任何「綠 / 通過 / conform」的宣稱，在實作期都必須附上實際 `go test` / `pnpm run verify`（含 `verify:go`）的 exit code。
> 本 slice 觸及 hashing/signing，**必須** byte-for-byte honour S0.5 釘死的 conformance 常量（見 §4「契約常量錨點」）。

---

## (1) ID + Title

SLICE-P1-002（slice JSON id：P1-S2）— 在 Go evidence kernel 實作 `canonicalBytes(event)`（重現 S0.2 確定性序列化 + S0.7 redaction）、`frame()`（8-byte big-endian 長度前綴）、`computeEntryHash`、`checkpointBytes` 與 Ed25519 簽 / 驗，並以**一份共享 golden-vector fixture** 鎖定其輸出與 TS 參考實作（`src/audit/kernel/log.ts` + `src/audit/canonical.ts` + `src/audit/redact.ts`，SLICE-P0-005 釘定）**byte-for-byte 相同**。

## (2) Goal（一句話）

在 Go 端產出與 TS 參考實作 byte-for-byte 一致的 `canonicalBytes(event)` → `entryHash` → `checkpoint signature`，並以靜態 golden-vector fixture 把這三個 primitive 的輸出**單向**鎖死（向量不符即 `go test` FAIL）。

## (3) In-scope / Out-of-scope

- **In-scope:**
  - `kernel/internal/canonical/canonical.go` — `CanonicalBytes(event) ([]byte, error)`：重現 S0.2 的確定性 JSON（遞迴 key 排序、UTF-8、`JSON.stringify` 相容的 string/number escape；拒絕非有限數 `NaN`/`±Inf`、`bigint`、top-level `undefined`、array-nested `undefined`，fail-closed throw → Go 回 `error`），且**先 redact 再 canonicalize**（redact-before-canonicalize）。
  - `kernel/internal/canonical` 內的 redaction：by-KEY（`SECRET_KEY` regex，與 `src/audit/redact.ts` 同一字面）+ by-VALUE（`SECRET_VALUE` regex，命中 substring 取代為 `[REDACTED]`），對齊 S0.7。
  - `kernel/internal/chain/chain.go` — `Frame(parts ...[]byte) []byte`（每段 8-byte BE 長度前綴）、`ComputeEntryHash(event, prevHash, sequence) (string, error)`（`sha256:`-prefixed）、`CheckpointBytes(headEntryHash string, length int) []byte`；以及 `GenesisPrevHash` 常量。
  - `kernel/internal/chain/sign.go`（或 `kernel/internal/sign`）— Ed25519 簽 / 驗 wrapper：`SignCheckpoint(priv, headEntryHash, length) (sigBase64 string)`、`VerifyCheckpoint(pub, headEntryHash, length, sigBase64) bool`。
  - `kernel/testdata/golden-vectors.json` — **共享 conformance fixture**：每個向量含 `event`（AuditEvent input）、`canonicalBytesHex`、`entryHash`、`prevHash`、`sequence`，外加 checkpoint 向量（`headEntryHash`、`length`、`publicKeyPemOrHex`、`signatureBase64`），**以及一個帶 canary 的 redaction 向量**（事件某 free-form 欄位含 secret-shape，期望 canonicalBytes 內**不含** canary、含 `[REDACTED]`）。fixture 由 TS 參考實作產生（產生器在 §5.4 描述，本 slice 只鎖定向量、不寫雙向 harness）。
  - RED 測試：`kernel/internal/canonical/canonical_test.go`、`kernel/internal/chain/chain_test.go`、`kernel/internal/chain/sign_test.go` — 對 golden 向量逐筆比對 Go 算出的 `canonicalBytes(hex)` / `entryHash` / checkpoint signature；任一不符即 fail。
  - **增補 depguard rule（對 P1-S1 既有 `.golangci.yml` 的 EDIT，非新建檔）**：在 P1-S1 已建立的 `kernel/.golangci.yml` 內**增補一條** rule —— `internal/canonical` 不得 import `internal/chain`（禁反向依賴）；P1-S1 已建立的「kernel 任何 package 不得 import control-plane / SDK」三條跨 plane deny 規則**沿用不改**。編輯後須**重跑 P1-S1 的 depguard 非 no-op 對抗檢查**（植入命中 deny 的違規 import → `golangci-lint run` exit≠0），確認增補未破壞既有規則。本 slice **不**觸碰 `verify:go` 的 skip→enforcing 翻轉（那是 P1-S1 已完成的契約）；本 slice 進場時 `verify:go` **已是 enforcing**，只需保持 `go vet ./... && go test ./... && golangci-lint run` 全綠。

- **Out-of-scope（明確不做，註記留給哪個後續 slice）:**
  - 完整 `AppendOnlyLog` 串接（多筆 append 串 prev-hash chain）/ standalone verifier CLI（讀鏈 + 驗簽 + 非零 exit on tamper）→ 留給 **P1-S3**。本 slice 只做**單筆**的 primitive（`ComputeEntryHash` 吃外部給定的 `prevHash`/`sequence`，**不**自己維護鏈狀態）。
  - durable storage / monotonic per-source sequence / gap detection / transactional outbox → 留給 **P1-S4**。
  - 跨進程 / gRPC ingest proto / kernel 作為獨立 process & identity → 留給 **P1-S6**。
  - **雙向** cross-language conformance（Go 產鏈 → TS 驗、TS 產鏈 → Go 驗）的端到端收口 → 留給 **P1-S7**。本 slice 先以**靜態 golden 向量單向**鎖定 primitives（向量由 TS 產、Go 驗），不建端到端 harness、不在本 slice 跑 TS 端對 Go 產物的驗證。
  - `blake3:` 等未來 hash 演算法 → 不做；但**前綴必須版本化**（`sha256:` 為常量、不硬編成假設只會有 sha256；見 §4 契約常量錨點 #5）。

## (4) Design delta + modules + public interface + dependency direction

### Design delta（對現狀的最小變更）

- **現狀**：**`kernel/` Go module 已由 P1-S1 建立**（`go.mod` module path `github.com/agent-os/kernel` + `.golangci.yml` depguard + `internal/version` placeholder），且 `verify:go` cascade **已是 enforcing**（P1-S1 把它從 skip 翻為 real gate）。TS 端已有完整的 byte-level 契約：`src/audit/kernel/log.ts`（`GENESIS_PREV_HASH`、`frame`、`computeEntryHash`、`checkpointBytes`）、`src/audit/canonical.ts`（`canonicalJson` 確定性序列化）、`src/audit/redact.ts`（by-key + by-value redaction）。
- **本 slice 的差**：在**既有** `kernel/` module 內新增 `internal/canonical` + `internal/chain` 兩個套件，實作三個 primitive（canonical / entryHash / checkpoint sign），使 Go 對**同一個 event** 算出與 TS **完全相同**的 `canonicalBytes` / `entryHash` / checkpoint signature。**狀態機差**：無（本 slice 是純函式 primitive，無持久狀態、無鏈狀態）。**契約差**：`kernel/internal/canonical`、`kernel/internal/chain` 的 Go 公共面新增；TS 契約**不變**（Go 對齊 TS，不反向修改 TS）。**build 差**：`verify:go` 在本 slice 進場時**已 enforcing**（P1-S1 完成翻轉）；本 slice 只是讓它在新增套件後**維持綠**——不重新描述 fail-closed transition。

### Modules touched（每個一句唯一責任，high cohesion 自證）

- `kernel/internal/canonical`（新增）— **唯一責任**：把一個 AuditEvent **先 redact 再** 序列化成與 S0.2/S0.7 byte-for-byte 一致的 canonical UTF-8 bytes（含 fail-closed 的不可序列化值拒絕）。**不**做 hashing、不做 framing、不做 signing。
- `kernel/internal/chain`（新增）— **唯一責任**：在 canonical bytes 之上做 `frame()`（8-byte BE 長度前綴）+ sha256 → `entryHash`，以及 `checkpointBytes`，並持有 `GenesisPrevHash` 常量。**不**做 redaction/序列化（呼叫 `canonical`）、**不**自己維護鏈（吃外部 `prevHash`/`sequence`）。
- `kernel/internal/chain`（或同 package 的 `sign.go`）— Ed25519 簽 / 驗 wrapper。**唯一責任**：對 `CheckpointBytes` 的輸出做 Ed25519 sign / verify，base64 編碼，**不**重算 chain、**不**碰 event 內容。
  > 若 reviewer 認為 sign 與 frame/hash 屬不同關注點而要求拆出獨立 package `kernel/internal/sign`，這仍在 modules ≤ 2~3 的上限內；本 doc 預設置於 `internal/chain` 的 `sign.go`（同 package、單一檔職責），由 adversarial review 的 cohesion 維度裁量是否須拆。

### PUBLIC interface（新增的 Go 公共面；internal/ 對 kernel 外不可見）

> Go `internal/` 機制：`kernel/internal/*` 的 package **只能被 `kernel/` 下的程式碼 import**，對 kernel module 外（control plane / SDK / 未來 gRPC handler 之外的任何 module）**編譯期不可見**——這是 HARD CONSTRAINT A 的編譯器級封裝。下列「public」指的是 **kernel module 內部** package 的對外面（供 P1-S3/S4 的 log/verifier package 消費），而非 kernel 對 control plane 的面。

```go
// kernel/internal/canonical
func CanonicalBytes(event any) ([]byte, error)   // redact-before-canonicalize；不可序列化值 → error（fail-closed）
const Redacted = "[REDACTED]"

// kernel/internal/chain
// GenesisPrevHash == "sha256:" + strings.Repeat("0", 64)  // 與 TS GENESIS_PREV_HASH 同字面（64 個 "0"）
var GenesisPrevHash = "sha256:" + strings.Repeat("0", 64)
func Frame(parts ...[]byte) []byte                                  // 每段 8-byte BE 長度前綴
func ComputeEntryHash(event any, prevHash string, sequence int) (string, error)  // "sha256:"-prefixed
func CheckpointBytes(headEntryHash string, length int) []byte

// kernel/internal/chain (sign.go) 或 kernel/internal/sign
func SignCheckpoint(priv ed25519.PrivateKey, headEntryHash string, length int) string  // base64
func VerifyCheckpoint(pub ed25519.PublicKey, headEntryHash string, length int, sigBase64 string) bool
```

> **介面註記（與 TS 對齊處）：**
> - `event any` 對應 TS 的 `AuditEvent`，但 canonical 序列化是**結構性**的（遞迴 key 排序），不依賴具體 Go struct 的欄位順序——這正是 byte-for-byte 對齊的關鍵（見 §4 #1）。本 slice **不**引入 AuditEvent 的 Go struct 定義（那會是 P1-S6 的 proto-derived type）；canonical 直接吃已 decode 的 `map[string]any` / 巢狀結構，與 TS 的「對 redacted 物件遞迴」同形。
> - `ComputeEntryHash`/`CheckpointBytes` 的 `sequence`/`length` 以 `String(sequence)` 的**十進位字串** UTF-8 bytes 入 frame（對齊 TS `textEncoder.encode(String(sequence))`），**不是** binary int（見 §4 #4）。

### Dependency direction（low coupling 自證；HARD CONSTRAINT A）

```
kernel/internal/chain ──▶ kernel/internal/canonical (CanonicalBytes)
                      ──▶ crypto/sha256, crypto/ed25519, encoding/base64, encoding/binary  [Go stdlib]
kernel/internal/canonical ──▶ encoding/json (僅作 number/string escape 對齊), regexp  [Go stdlib]
（測試）kernel/internal/{canonical,chain} *_test.go ──▶ kernel/testdata/golden-vectors.json （read-only fixture）
```

- **方向**：`chain → canonical`（單向，無反向、無 cycle）。`canonical` **不** import `chain`（depguard 規則禁止）。兩者皆只依賴 Go stdlib。對齊 inward-pointing：canonical 是更「內」的 domain primitive，chain 在其上組合。
- **跨 plane**：本 slice **不** import 任何 control-plane / SDK / TS 內部。Go ↔ TS 的唯一耦合是**靜態 golden fixture（資料，非程式碼）**——Go 不 import TS、TS 不 import Go；fixture 是序列化的契約值。**零 shared internals。**
- **僅經 public surface 消費（無 deep import）**: ☑ 是（`chain` 經 `canonical` 的 exported `CanonicalBytes`；測試經 fixture 檔，不 reach into 對方 unexported）。
- **新依賴宣告（逐一證明 inward + acyclic + justified）**:
  - `kernel/internal/canonical → kernel/internal/chain`：**無此依賴**（方向相反，被 depguard 禁止；明列以證明不存在）。
  - `chain → canonical`：方向 = inward（domain primitive）、cycle = 無、理由 = entryHash 必須先有 canonicalBytes，組合關係天然單向。
  - **第三方依賴 = 0**：全部用 Go stdlib（`crypto/sha256`、`crypto/ed25519`、`encoding/binary`、`encoding/base64`、`encoding/json`、`regexp`）。對齊 TS 端「零新依賴（node:crypto）」。`go.mod` 不引任何 require。
- **depguard 規則（對 P1-S1 既有 `kernel/.golangci.yml` 的 EDIT；本 slice 只增補一條）**:
  - **本 slice 新增**：`kernel/internal/canonical` 的 deny list 含 `github.com/agent-os/kernel/internal/chain`（禁反向依賴，使 `chain → canonical` 為唯一方向）。
  - **沿用 P1-S1（不改）**：「kernel 任何 package 不得 import control-plane / SDK」的三條跨 plane deny rule（`github.com/agent-os/agent-os`、`agent-os/src`、`github.com/agent-os/sdk`）。
  - 未來 verifier（P1-S3）的 deny list 將含「`internal/verify` 不得 import `internal/log`」——本 slice 先不立（YAGNI），留 P1-S3 補。
  > **編輯既有檔的誠實揭露**：因本條是對 P1-S1 已 merge 的 `.golangci.yml` 的修改，merge 前須**重跑 P1-S1 的 depguard 非 no-op 對抗檢查**（§6 已列），確保增補 canonical-rule 未使既有跨 plane 規則退化。

## (5) Test-first plan（先寫的 RED 測試）

> 方法論：Go test-first（先寫會失敗的 `go test` = RED）。本 slice 為 PLAN，下列為**實作期**將先寫的 RED 測試與其首次紅燈長相。

### 5.1 測試檔位置與執行指令

- `kernel/internal/canonical/canonical_test.go`
- `kernel/internal/chain/chain_test.go`
- `kernel/internal/chain/sign_test.go`
- fixture：`kernel/testdata/golden-vectors.json`（測試以相對路徑 `testdata/` 讀取，Go 慣例）
- 執行：`(cd kernel && go test ./...)`；或經 cascade：`pnpm run verify:go`

### 5.2 RED 測試清單（每條對應一個行為 / 不變量）

- [ ] **canonicalBytes golden（key-order 不變）**：對 golden 向量 `v.event`，`CanonicalBytes(v.event)` 的 hex == `v.canonicalBytesHex`。fixture 含一個「鍵以非排序順序給入」的事件，證明 Go 的遞迴 key 排序與 TS 一致。
- [ ] **canonicalBytes golden（非 ASCII / escape）**：fixture 含一個 `resource` 帶非 ASCII（如中文、emoji）與需 escape 字元（`"`、`\`、控制字元）的事件，Go 算出的 hex 與向量一致（對齊 TS `JSON.stringify` 的 escape 規則——這是 §key risk 的核心邊界）。
- [ ] **canonicalBytes golden（空 object / 空 array / null）**：fixture 含巢狀空物件 `{}`、空陣列 `[]`、`null` 值欄位，Go 輸出與向量一致。
- [ ] **entryHash golden**：對向量 `(v.event, v.prevHash, v.sequence)`，`ComputeEntryHash` == `v.entryHash`，且格式為 `^sha256:[0-9a-f]{64}$`。fixture 含一個 `sequence` 為**大整數**（如 `9007199254740991` / 更大）的向量，證明 decimal-string 編碼與 TS `String(sequence)` 對齊（§key risk）。
- [ ] **genesis prevHash 常量**：`GenesisPrevHash == "sha256:" + strings.Repeat("0", 64)`（與 TS 字面相同；非空、非省略）。
- [ ] **checkpoint sign / verify round-trip**：`SignCheckpoint(priv, head, len)` 產生的 sig，`VerifyCheckpoint(pub, head, len, sig)` == true；改一 bit head 或 len → false（fail-closed）。
- [ ] **checkpoint golden（cross-language sig verify）**：fixture 提供 TS 端用某固定私鑰簽出的 `signatureBase64` + 對應 `publicKey`，Go 端 `VerifyCheckpoint(pub, v.headEntryHash, v.length, v.signatureBase64)` == true。**這證明 Go 接受 TS 簽的 checkpoint**（單向 cross-language 接受性）。
  > 註：Ed25519 簽名對同一訊息不保證 byte-相同（RFC 8032 是確定性的，故實務上相同；但本測試以「Go **verify** TS 的簽章」為斷言，而非比對 signature bytes，避免依賴 deterministic-signing 細節，較穩健）。
- [ ] **安全對抗式（credential non-leak）**：fixture 的 canary redaction 向量 —— 事件某 free-form 欄位（如 `resource` 或巢狀 `context.apiKey`）含 secret-shape 值；`CanonicalBytes` 的輸出**不含** canary 子字串、**含** `[REDACTED]`，且其 hex == 向量（證明 Go 的 redact-before-canonicalize 與 TS S0.7 對齊）。**canary 值在 fixture 中以片段組裝或以非完整 pattern 形式存放**，使 `scan_secrets.sh` 不命中（見 §6 secret-scan 條與 test-and-acceptance §3.2 canary 機制）。
- [ ] **安全對抗式（fail-closed 序列化）**：餵下方**釘死的 Go↔TS 等價子集**中每一類 → `CanonicalBytes` 回 `error`（不 silent coerce、不 panic），對齊 TS `canonicalJson` 的 throw。
  > **Go ↔ TS 對應註記（在本 slice 釘死，非 punt 給 P1-S7）**：TS 的 `undefined`/`NaN`/`Infinity`/`bigint` 在 Go 無 1:1 等價型別。本 slice 的 RED **必須完整覆蓋以下列舉子集**（P1-S2 為 baseline，P1-S7 雙向 harness **只能 EXTEND、不得 redefine** 此集合）：
  > 1. `math.NaN()` ↔ TS `NaN`（`!Number.isFinite` → throw）；
  > 2. `math.Inf(1)` / `math.Inf(-1)` ↔ TS `Infinity`/`-Infinity`（非有限數 → throw）；
  > 3. `json.Number` 超出 int64 範圍 ↔ TS `bigint`（無法序列化 → error）；
  > 4. 不支援型別值（`func`、`chan`）↔ TS top-level `undefined`/function/symbol（unserializable type → error）；
  > 5. array-nested 不可序列化元素（如 slice 內含 `func`/`chan`）↔ TS array-nested `undefined`（→ error，非靜默省略）。
  > 共 5 類，逐類一條 RED 斷言。

### 5.3 首次紅燈證據（實作期將貼 exit≠0；package / fixture 尚未存在）

```
$ (cd kernel && go test ./internal/...)
... build failed: no Go files in .../kernel/internal/canonical
（或：open testdata/golden-vectors.json: no such file；或 undefined: CanonicalBytes）
FAIL
exit status: 1
```

> RED 真實性（adversarial review §1.2 mutation 驗證將檢查）：測試是因**斷言失敗 / 向量不符**而紅，不是因 import error 永遠紅。實作轉綠後，reviewer 須能「把某 primitive 故意改壞一個 byte（如 frame 用 4-byte 長度前綴、或 sequence 改成 binary）」使對應 golden 測試轉紅，證明測試真的在斷言 byte-for-byte 對齊。

### 5.4 golden-vector fixture 的產生（誠實揭露：避免「Go 自證 Go」的循環）

- fixture **必須由 TS 參考實作產生**（`canonicalizeAuditEvent` / `computeEntryHash` / `checkpointBytes` / `node:crypto` Ed25519 sign），而**非**由 Go 自己算完再寫回 fixture——否則「Go conform 到 TS」退化為「Go conform 到 Go」，conformance 形同虛設。
- 產生方式（本 slice 內，屬 TS 端的小工具，計入 LOC）：一個 TS 一次性 script（如 `scripts/gen-golden-vectors.ts` 或一個 `vitest` 產出檔），讀固定 events + 固定測試私鑰 → 輸出 `kernel/testdata/golden-vectors.json`。**固定測試私鑰**只用於 fixture 簽章，非真實憑證、非任何 secret sink（它是測試金鑰，但仍**不得**寫成讓 scan_secrets 誤判的 PEM 私鑰字面——以程式產生並只寫 public key + signature 到 fixture，private key 不入 fixture）。
  > **私鑰處置（credential non-leak 對齊）**：fixture 只存 **public key** + **signature**，**不存 private key**。產生器在記憶體生成 keypair、簽完即丟。這使第 6 sink（secret-scan）對 fixture clean，同時 Go 仍能 verify。
- fixture 的「真相方向」：TS 是 reference，Go 對齊它。雙向（Go 產 → TS 驗）留 P1-S7。

## (6) Definition of Done（每條附指令證據）

- [ ] **Test-first 成立**：實作前先有 RED `go test`（canonical/chain/sign），首次紅燈已貼於 §5.3。
- [ ] `pnpm run verify`（**含級聯 `verify:go`**）exit 0
  ```
  $ pnpm run verify
  ... verify:go: ok ...
  exit code: 0
  ```
- [ ] **`pnpm run verify:go` 維持綠（已 enforcing；本 slice 不重新翻轉）**：在 P1-S1 已 enforcing 的 cascade 上，新增 `internal/canonical` + `internal/chain` + 增補一條 depguard rule 後，`go vet ./... && go test ./... && golangci-lint run` 仍全綠。
  ```
  $ pnpm run verify:go
  verify:go: Go plane present (.../kernel) — gate must be configured (fail-closed)
  ... go vet / go test ./... / golangci-lint（含新增 canonical→chain deny rule）...
  verify:go: ok
  exit code: 0
  ```
- [ ] **dependency-boundary check 綠**：
  - TS 腿 `pnpm run deps:check` exit 0（本 slice 不動 `src/`，TS 邊界不受影響）。
  - Go 腿 depguard（在 `golangci-lint run` 內）exit 0：`canonical` 不 import `chain`、kernel 不 import control-plane/SDK；`internal/` 封裝對 kernel 外不可見（編譯期）。reviewer 須親跑 `(cd kernel && golangci-lint run)` 並貼輸出。
- [ ] **low coupling / high cohesion 遵守**：`canonical`（序列化+redaction 一責）/ `chain`（frame+hash+sign 一責，呼叫 canonical）；無 cycle、無反向、無 deep import；跨 plane 僅靠 fixture 資料（零 shared internals）。
- [ ] **contract conformance（本 slice 核心 DoD）**：golden 向量逐筆 byte-for-byte 比對通過——`canonicalBytesHex` / `entryHash` / checkpoint signature verify 皆綠；涵蓋 §5.2 的邊界向量（key-order、非 ASCII/escape、空 object/array/null、大整數 sequence、canary redaction）。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` exit 0；fixture / source / `golden-vectors.json` **無** secret-shape 值（private key 不入 fixture，canary 以非完整 pattern 存放）；reviewer 自設 canary 後在 6 sink（workspace / logs / artifacts / snapshots / traces / fixtures）grep 0 命中；canonicalBytes 輸出證明 canary 已成 `[REDACTED]`。
- [ ] **Docs 更新**：README dev 區 / kernel README 標明「Go canonical/entryHash/checkpoint 已 byte-for-byte conform TS S0.5 契約（golden 向量單向鎖定）；雙向 conformance harness 為 P1-S7」，避免過度宣稱「已完成 cross-language 互驗」。
- [ ] **Adversarial code review = PASS**（fresh-context、非作者；主攻面見下）— 連結 / 摘要: <...>
  - 主攻 §4.3 **credential leak（6 sinks）**：canary 是否從某邊界（fixture / canonicalBytes / error 訊息）漏出？
  - 主攻 §4.7 **low coupling / high cohesion**：`canonical → chain` 反向？deep import？跨 plane import 對方 internals？depguard 是否被 `//nolint` 偷繞？
  - 主攻 §4.8 **claimed behavior**：golden 向量是否真由 **TS 產**（非 Go 自證）？mutation（改 frame 長度前綴 / 改 sequence 編碼 / 關掉 redaction）能否使對應向量測試轉紅？
  - 主攻 §4.2 **fail-closed**：不可序列化值是否一律 `error`（非 silent coerce、非 panic-as-success）？
- [ ] **（安全不變量類 slice）Independent Verifier Pass 已執行並 clean**：本 slice 觸及 **credential non-leak**（redaction 進 hash 前）與序列化 fail-closed，屬安全不變量 → 須跑 Independent Verifier Pass，對抗式探測 canary 外洩與 fail-closed 繞過皆 HELD。

> **DoD 範圍誠實揭露**：本 slice **不**承擔 roadmap §3.1 的「control plane 無法改寫已 append 紀錄」「sequence-gap 注入」「synchronous-commit-before-effect」「standalone verifier 對 tampered chain 回非零」等退出條件——那些分屬 P1-S3 / P1-S4 / P1-S6。本 slice 只貢獻 **primitive 層的 cross-language byte-for-byte conformance** 這一塊基線，且 `pnpm run verify`（含 `verify:go`）exit 0 是本 slice 自身的可驗收 gate。

## (7) Rollback

- **回退方式**：`git revert <merge-sha>`。移除 `kernel/` 目錄後，S0.8 的 `verify:go` cascade 自動退回 **skip exit 0**（plane 不存在），`pnpm run verify` 仍綠。
- **可逆性**：**安全可逆**。本 slice 為純函式 primitive + 測試 fixture + build gate 設定，**無持久化、無外部副作用、無真實 audit append**（不寫任何鏈、不簽真實 checkpoint）。
- **前瞻**：P1-S3 起的真實 kernel append 為 append-only；屆時回退靠 forward-correcting event，**不得改寫歷史**（slice-spec §7）。本 slice 因不 append，無此限制。

## (8) Depends-on / blocks

- **Depends-on**:
  - **SLICE-P1-001（P1-S1）**（kernel module bootstrap，**已 merge / 已存在於 `docs/slices/phase-1/P1-S1-go-kernel-bootstrap-verify-gate.md`**）——已建立 `kernel/go.mod`（module path `github.com/agent-os/kernel`）+ `.golangci.yml`（depguard，含三條跨 plane deny rule）+ `internal/version` placeholder，並把 `verify:go` 由 skip 翻為 enforcing。本 slice 在其上**只加** canonical/chain/sign primitive 與 golden 向量，並**增補一條** depguard rule；**不重建** go.mod/.golangci.yml（見 Size budget 檔案所有權）。
  - **SLICE-P0-005**（TS 契約來源：`GENESIS_PREV_HASH`、`frame`、`computeEntryHash`、`checkpointBytes`、`canonicalizeAuditEvent`、`redactSecrets`——byte-level 真相）。
  - **SLICE-P0-008**（`verify:go` cascade：本 slice 把它從 fail-closed 轉為 real gate）。
  - **SLICE-P0-002 / P0-007**（S0.2 canonical 序列化 / S0.7 value-scan redaction 的 TS 定義，Go 須重現之）。
- **Blocks**:
  - **P1-S3**（AppendOnlyLog 串接 + standalone verifier CLI——消費本 slice 的 `ComputeEntryHash`/`CheckpointBytes`/`GenesisPrevHash`/sign-verify）。
  - **P1-S4**（durable storage + monotonic sequence + gap detection——建在 chain primitive 上）。
  - **P1-S7**（雙向 cross-language conformance 端到端 harness——以本 slice 的 Go primitive + 單向 golden 向量為基線，擴成 Go 產鏈 → TS 驗 + TS 產鏈 → Go 驗）。
- **確認 slice DAG 無 cycle**: ☑ 是（依賴皆指向已完成的 P0 契約與 P1-S1 前置；本 slice 不被其 depends-on 反向依賴）。

## 契約常量錨點（byte-for-byte，須與 S0.5 / `src/audit/kernel/log.ts` 完全一致；任一不符 = conformance FAIL）

> 本節是 §key risk 的對抗清單。Go 實作期必須逐條 honour，golden 向量逐條覆蓋。

1. **canonicalBytes = S0.2 確定性序列化 AFTER redaction**：遞迴 key 排序（`Object.keys().sort()` → Go `sort.Strings`）、UTF-8、string escape 與 number 格式須與 TS `JSON.stringify` **完全一致**（含非 ASCII 不額外 escape 成 `\uXXXX`？——TS `JSON.stringify` 對非 ASCII **不** escape，Go 須對齊；控制字元 / `"` / `\` 則 escape）。`undefined` 屬性視為「absent」省略；array-nested `undefined` → throw/error。**redact 先於 canonicalize**（by-KEY `SECRET_KEY` + by-VALUE `SECRET_VALUE`，字面與 `src/audit/redact.ts` 對齊）。
2. **genesis prevHash** = `"sha256:" + 64 個 "0"`（非空、非省略欄位）。
3. **entryHash** = `sha256( frame( canonicalBytes(event), prevHash, sequence ) )`，`"sha256:"`-prefixed；`frame()` 每段以 **8-byte big-endian** 長度前綴（無分隔歧義）。`prevHash` 以其 UTF-8 字串 bytes 入 frame。
4. **sequence / length 編碼**：以 `String(sequence)` 的**十進位字串** UTF-8 bytes 入 frame（對齊 TS `textEncoder.encode(String(sequence))`），**非** binary int。`checkpointBytes = frame( headEntryHash(UTF-8 bytes), String(length)(UTF-8 bytes) )`。
5. **hash 演算法前綴版本化**：`sha256:` 為**常量前綴**，不得硬編成「永遠只有 sha256」的假設（未來 `blake3:` 可加；本 slice 只實作 sha256，但前綴是可版本化的常量）。
6. **checkpoint = Ed25519 簽章 over `checkpointBytes(headEntryHash, length)`**（對 chain HEAD，**非** per-entry 簽），base64 編碼。Go `VerifyCheckpoint` 須接受 TS 用同一公鑰對同一訊息產生的簽章。

---

*本文件不含任何 secret-like 值。所有「綠 / 通過 / conform」欄位在實作期皆須附真實指令的 exit code（only command output is truth）。凡與 `AGENTS.md` 衝突，以 `AGENTS.md` 為準。*
