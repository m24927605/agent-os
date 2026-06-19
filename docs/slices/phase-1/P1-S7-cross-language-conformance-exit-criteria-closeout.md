# SLICE-P1-007: cross-language conformance（TS↔Go 雙向）+ Phase-1 exit-criteria 收口

- **Phase**: P1（roadmap §3.1 — Go evidence kernel「先簡後繁」收口；本 slice 是 P1 的**最後一塊**：把跨語言 conformance 與全部退出條件串成可重跑驗收，不新增 kernel 行為）
- **Branch**: slice/p1-007-cross-language-conformance-exit-criteria-closeout
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~220（不含 generated stub / lockfile / golden 資料）、files <~7（cross-lang fixtures 產生器 × 2、TS↔Go conformance 測試 × 2、`docs/slices/phase-1/INDEX.md`、roadmap §3.1 勾稽、kernel README/docs 片段）、modules <~2（**跨 plane 僅經共享 fixture 資料 + S0.5/P1-S3 既有 public surface**，零 internals 共享）

> **本 slice-doc 的執行時鐵律（規範來源 = `docs/slices/phase-0/INDEX.md §2.1`；本 slice 建立的 `phase-1/INDEX.md §2.1` 將 verbatim 重述/連結該節，使 P1 自含、無前向循環）：**
> 1. **EXECUTION-TIME EVIDENCE**：本文件 §5/§6 的所有指令 transcript 與 exit code（`go test … FAIL`、`exit code: 1`、`pnpm run verify … exit code: 0`）**都是樣板佔位**，必須在執行時被**真實輸出覆蓋**；覆蓋前不得據此宣稱 slice 已綠/已 done（only command output is truth）。
> 2. **First-RED 必須真實捕獲且早於實作**：本 slice 的雙向 conformance RED 測試（TS 產鏈→Go verifier broken-on-tamper / Go 產鏈→TS `verifyChain` broken-on-tamper）必須在寫任何 fixture 產生器/橋接實作前真實跑出 exit≠0 並 commit；reviewer 須經 git history / 親自還原實作重跑再確認 RED 為真（adversarial-code-review.md §3.3 第 4 步）。
> 3. **Per-slice 實作 loop cap ≈6**：RED→GREEN→verify 內圈若 6 次迭代仍無法 GREEN，停止並重評 slice 邊界（可能切太大或 conformance 不對齊是上游 slice 的 bug，須退回 P1-S3/P1-S6 修，而非在本 slice 放寬斷言）。
> 4. **canary 是「明顯非機密」sentinel**，只在記憶體 runtime 組裝（`["CANARY","SECRET",uuid].join("-")`）、**絕不寫入任何 fixture 檔**（見 §5 credential non-leak 對抗測試；本 slice 風險最高的就是 fixture 入庫，必須 runtime 組裝）。

---

## (1) ID + Title

SLICE-P1-007（slice JSON id：P1-S7）— 建立 **TS↔Go 雙向 cross-language conformance**：TS 參考 log（`InMemoryAppendOnlyLog` + `verifyChain`，S0.5）產生的 `SignedChain` 匯出為**純資料 fixture** → Go verifier（P1-S3）驗 `ok`；Go kernel（P1-S3/P1-S6）產生的鏈匯出為純資料 → TS `verifyChain` 驗 `ok`（雙向 golden）；並對任一語言產的鏈做 **tamper / reorder / gap / bad-sig**，要求**另一語言**的 verifier 必回 broken（refute-by-default 的反向證據）。同時把 **Phase-1 全部 command-verifiable 退出條件**串成一條可重跑的驗收清單，並完成 `docs/slices/phase-1/INDEX.md` 與 roadmap §3.1 退出條件的勾稽。

## (2) Goal（一句話）

證明「**TS 產的鏈在 Go verifier 通過、Go 產的鏈在 TS verifier 通過（雙向 happy-path 黃金測試）**，且**任一語言對鏈做 tamper/reorder/gap/bad-sig 時另一語言 verifier 必回非零/broken**」，並把 P1 退出條件收成一條可重跑的驗收清單——本 slice **不新增任何 kernel 證據行為**，只新增跨語言一致性的**證據**與退出收口。

## (3) In-scope / Out-of-scope

- **In-scope**:
  - **共享 conformance fixture（純資料、語言中立）**：定義一個最小、語言中立的序列化格式承載一條 `SignedChain` —— `{ entries: [{ sequence, event(已 redact 的 canonical 對象), prevHash, entryHash }...], checkpoint: { length, headEntryHash, signature(base64) }, publicKey(SPKI/PEM 或 raw Ed25519 public bytes 的版本化編碼) }`。fixture **只含已 redact 的 canonical 事件內容 + hash + base64 簽章 + 公鑰**，**不含任何 private key、不含任何 secret**。
    - 格式選擇紀律：fixture 用**確定性的 JSON**（沿用 S0.2 canonical 規則的鍵序），使 TS 與 Go 兩端讀同一檔不產生歧義；`publicKey` 以**版本化編碼 `ed25519:<base64(SPKI DER)>`**（**不硬編**未來 algo）。
    > **publicKey 雙向載入的精確 parse path（釘死，否則 bad-sig 與 wrong-key 會被混淆）**：TS 端以 `node:crypto` export SPKI DER（`publicKey.export({type:"spki", format:"der"})`）→ base64。**Go 端 `crypto/ed25519.PublicKey` 是 raw 32-byte、非 SPKI**，故載入須 `x509.ParsePKIXPublicKey(der)` 再 type-assert 為 `ed25519.PublicKey`（得 raw 32 bytes）。本 slice **必含一條 round-trip RED**：TS export 的 SPKI → Go `x509.ParsePKIXPublicKey` 解出的 raw 32 bytes，與 Go 直接持有的同一把 key 的 raw bytes **逐 byte 相等**；反向亦然（Go 以 `x509.MarshalPKIXPublicKey` 產 SPKI → TS `createPublicKey` 載入成功）。確保 key 編碼 byte-exact，bad-sig（簽章被換）與 wrong-key（公鑰被換）為**兩個分離**的對抗變體、不互相掩蓋。
  - **方向 A（TS→Go golden）**：一個 TS 產生器（test-only）以 `InMemoryAppendOnlyLog` append **多筆**事件（含邊界事件，見下）→ `checkpoint()` → 匯出上述 fixture；Go 端 conformance 測試讀該 fixture → 餵 **P1-S3 Go verifier** → 斷言 `ok=true, length=N`。
  - **方向 B（Go→TS golden）**：一個 Go 產生器（test-only，用 P1-S3 的 Go append-only log + checkpoint）append 同一組邊界事件 → 匯出 fixture；TS 端 conformance 測試讀該 fixture → 餵 **`verifyChain`（S0.5）** → 斷言 `{ ok: true, length: N }`。
  - **雙向交叉等值（the actual conformance assertion）**：對「相同的事件序列 + 相同 keypair（test-only，runtime 生成）」，**TS 產的 fixture 與 Go 產的 fixture 在 `entries[*].entryHash`、`checkpoint.headEntryHash`、`checkpoint.signature` 上 byte-for-byte / base64-for-base64 相等**（或至少：兩語言各自 verifier 對「對方產的鏈」皆 `ok`，且 head/entryHash 相等）。這證明 `frame()` 8-byte big-endian length-prefix、`canonicalBytes` 鍵序、genesis prevHash、`sha256:` 前綴、checkpoint-over-HEAD 在兩語言一致。
  - **對抗式雙向（refute-by-default 的反向 golden）**：對任一語言產的 fixture，注入 **(a) tamper（改一筆 event 內容但不重算 hash）、(b) reorder（對調兩筆 entries）、(c) gap（抽掉中間一筆，保留各 entry 原始 sequence → 呈 0,2，verifier 在 index 1 比對 `sequence(2)!=i(1)`）、(d) bad-sig（替換 checkpoint.signature 或用錯 publicKey）**，斷言**另一語言** verifier 必回 broken（`ok=false` / 非零 exit）並指出第一個破點。**單向（同語言）tamper 不算數**——必須是「一語言 tamper → 另一語言 broken」。
    > **fixture 產生語義（與 pinned append API 一致，避免矛盾）**：happy-path 雙向交叉等值 fixture 的 `sequence` **由 append API 自動指派、連續 0-based**（TS `InMemoryAppendOnlyLog.append` 設 `sequence = #entries.length`；Go P1-S3 log 同形）——產生器**不**以 append API 塞任意/跳號 sequence。**gap / `sequence==2^53−1` 等「非連續或大值」fixture 一律由「對一條 API-合法產生的鏈做 post-hoc 純資料 MUTATION」**（tamper-style：移除一筆而保留原 sequence、或在已產鏈上替換某 entry 的 sequence 欄位）構造——**非**透過 append API。如此 happy-path 用 API-指派的連續 sequence、對抗變體用 mutation，兩者語義不矛盾、且都不偽造 append 行為。
  - **邊界事件覆蓋（防「對齊偽通過」）**：fixture 的事件序列**必須**包含：① redaction-canary 事件（某 free-form 欄位含 runtime 組裝的 canary，經 S0.7 value-scanning redaction 後在 canonical bytes 中為 `[REDACTED]`，用以證明兩語言 hash 的是**已 redact** 的相同 bytes）；② 非 ASCII / 多位元組 UTF-8 欄位（中文 / emoji，證明 UTF-8 編碼一致）；③ 巢狀物件 + 陣列（證明 recursive key sort 一致）；④ **大 `sequence`，上限封在 `Number.MAX_SAFE_INTEGER`（2^53−1 = 9007199254740991）**：以該確定值斷言兩語言對 `String(sequence)` 的十進位字串編碼逐 byte 相同（證明 sequence→bytes 一致）；⑤ genesis（第一筆，`prevHash == "sha256:"+64×"0"`）。空鏈與單筆鏈**亦各一條**（但**不得**只靠它們通過——它們是補充，非主體）。
    > **CONTRACT 限制（誠實揭露，不可在本 slice 偷測無法成立的值）**：pinned S0.5 的 `sequence` 是 JS `number`（`InMemoryAppendOnlyLog` 由 `#entries.length` 指派），且 `computeEntryHash` 以 `String(sequence)` 入 frame。**>2^53−1 的真 uint64 序號無法在 TS 參考 log 無損 round-trip**，故**本 slice 的雙向交叉等值測試上限 = 2^53−1**；**真 uint64（>2^53−1）序號的 cross-equality 不在 P1 範圍**——其生產者是 P1-S4 的 Go-side `uint64` per-source sequence，但與 TS 參考 log 的逐字 cross-equality 因 TS 表達力受限而 **deferred**（不在本 slice 宣稱）。本 slice 只保證「TS 能表達的範圍內（≤2^53−1）兩語言逐 byte 對齊」。
  - **Phase-1 exit-criteria 可重跑清單（釘死為 fail-closed 聚合腳本）**：新增 **`scripts/verify-p1-exit.sh`**（`set -euo pipefail`，逐條依序跑 §4 對照表的判定指令，**任一非零即整體非零、不吞錯**），並在 `package.json` 加 `"verify:p1-exit": "bash scripts/verify-p1-exit.sh"`。把 roadmap §3.1 的六條退出條件各對映到一條**已存在於先前 slice** 的判定指令（見 §4 對照表）。**本 slice 不重新實作任何被指向的指令**，只**編排 + 勾稽**它們。聚合腳本須含一個對抗自檢：暫時強制某子指令非零 → 聚合 exit≠0（fail-closed 證據，見 §6 DoD 勾選項與 §附註二 #5）。
  - **INDEX 與 roadmap 勾稽**：建立/更新 `docs/slices/phase-1/INDEX.md`（P1 slice DAG + 各 slice 對映哪條退出條件），並在 roadmap §3.1 的六個 checkbox 旁標注「由哪個 slice + 哪條指令證明」。
- **Out-of-scope（明確不做，註記留給哪個後續 slice / phase）**:
  - **WASM verifier**（讓不信任平台 / 瀏覽器 re-verify 鏈+簽章+外部錨點）→ **P4**（roadmap §3.4，F1 升級為完整 Tessera + WASM verifier）。本 slice 的 conformance 是「TS verifier ↔ Go verifier」兩個**原生** verifier 的互認，**不**產出 WASM。
  - **RFC-3161 / transparency-log 外部錨定**（external witness / inclusion proof）→ **P4**。本 slice 的鏈只到「hash-chain + Ed25519 checkpoint」，無外部錨點，conformance fixture 亦不含錨定欄位。
  - **Tessera tile log**（Merkle tile 結構、inclusion/consistency proof 的 tile 編碼）→ **P4**。本 slice conformance 針對的是「先簡」的 append-only hash-chain + checkpoint-over-HEAD，**非** tile log。
  - **多租戶 per-tenant 分區簽章**（per-tenant Merkle tree + per-tenant key）→ **P3**（roadmap §3.3）。本 slice 的 fixture 用**單一** test keypair；`source_id` 不綁 tenant 身分（與 P1-S6 一致）。
  - **改動任何 hash/frame/canonical/checkpoint 定義** → **嚴格禁止**。本 slice 是 conformance 的**消費者與驗證者**，不是定義者；若雙向不對齊，是上游（S0.5 / P1-S3 / P1-S6）的 bug，**修上游、不在此放寬斷言**（見 §「對抗面」）。
  - **TS control plane 真正以 ingest client 把事件送進 kernel 進程**（in-process → 跨進程 ingest 整合）→ **P2**（roadmap §3.2）。本 slice 的 Go「鏈」可直接由 P1-S3 in-memory log + checkpoint 產生，**不需**起 gRPC server（fixture 是純資料，產生器可直接呼叫 P1-S3 的 Go public surface）。

## (4) Design delta + modules + public interface + dependency direction

- **Design delta**:
  - 現況（P1-S6 後）：TS plane 有 S0.5 的 `InMemoryAppendOnlyLog` + `verifyChain`（pinned 常量）；Go plane 有 P1-S3 的 Go append-only log + Go verifier（已宣稱 byte-for-byte 對齊 S0.5）、P1-S4 durable + per-source sequence、P1-S5 outbox + commit-before-effect、P1-S6 獨立進程 + 單向 ingest proto + append-only client。**但「TS 產的鏈在 Go verify、Go 產的鏈在 TS verify」此刻只是各 slice 的 doc 宣稱，尚無一條 golden 測試把兩語言的 verifier 對「對方產出的真實鏈」互認**——P1-S4/S6 都把跨語言 conformance「指向 P1-S3 的 golden」，而那個 golden 的**完整雙向 + 邊界事件 + 反向 tamper** 版本由本 slice 收口。
  - 本 slice 的最小變更：新增**語言中立的 fixture 格式 + 兩個 test-only 產生器（TS 端、Go 端）+ 兩個 conformance 測試（Go 讀 TS fixture、TS 讀 Go fixture）**，把 S0.5 釘定的常量從「兩語言各自宣稱遵守」升級為「**用對方的真實輸出互相驗證**」。再把 P1 六條退出條件編排成可重跑清單並完成 INDEX/roadmap 勾稽。**零 kernel 行為變更**：所有 hash/sign/verify 邏輯都來自 S0.5 / P1-S3 的既有 public surface。
  - 狀態機差：無新狀態機。本 slice 是**驗證層**，只讀既有產物（鏈 + checkpoint + 公鑰）並斷言互認。

- **Modules touched（每個一句唯一責任，high cohesion 自證）**:
  - `conformance/cross-lang/chain-fixture.ts`（新增，test-only）— **唯一責任**：把 TS `SignedChain` + 公鑰序列化成語言中立 fixture / 從 fixture 反序列化（產生器 + loader，不含任何 verify 邏輯）。
  - `kernel/internal/conformance/fixture.go`（新增，test-only，置於 `internal/`）— **唯一責任**：Go 端對同一 fixture 格式的產生器 + loader（與 TS 端格式對稱），不含 verify 邏輯。
  - `conformance/cross-lang/ts-verifies-go.conformance.test.ts`（新增）— **唯一責任**：讀 Go 產的 fixture，餵 S0.5 `verifyChain`，斷言 happy-path `ok` + 四種 tamper 變體 broken。
  - `kernel/internal/conformance/go_verifies_ts_test.go`（新增）— **唯一責任**：讀 TS 產的 fixture，餵 P1-S3 Go verifier，斷言 happy-path `ok` + 四種 tamper 變體 broken。
  - `docs/slices/phase-1/INDEX.md`（新增）— **唯一責任**：P1 slice DAG + 退出條件 ↔ slice ↔ 判定指令的勾稽表（文件，無行為）。
  - `docs/roadmap.md` §3.1（編輯，標注證明來源）+ kernel README 片段 — **唯一責任**：記載 P1 退出條件的可重跑驗收入口（文件）。
  - `scripts/verify-p1-exit.sh` + `package.json` 的 `verify:p1-exit` 腳本 — **唯一責任**：`set -euo pipefail` 依序重跑既有判定指令並回傳聚合 exit code（純編排、fail-closed、不含新判定邏輯）。

- **PUBLIC interface（新增/變更的對外公共面；內部實作不列）**:
  - **跨 plane 的「公共面」= 語言中立 fixture schema 本身**（這是本 slice 唯一的跨 plane 契約，且它是**純資料、唯讀**，不引入任何新 RPC / 函式契約）：
    ```jsonc
    // cross-lang chain fixture（確定性 JSON，鍵序沿用 S0.2 canonical 規則）
    {
      "version": "agentos.cross-lang-chain.v1",
      "publicKey": "ed25519:<base64(SPKI DER)>",     // 版本化前綴，不硬編未來 algo
      "entries": [
        {
          "sequence": 0,
          "event": { /* 已 redact 的 canonical 事件對象；canonicalBytes 由兩語言各自重算 */ },
          "prevHash": "sha256:<hex>",                 // 首筆 == "sha256:"+64×"0"
          "entryHash": "sha256:<hex>"
        }
        /* ... */
      ],
      "checkpoint": {
        "length": 0,
        "headEntryHash": "sha256:<hex>",              // 空鏈時 == genesis prevHash
        "signature": "<base64(Ed25519 over frame(headEntryHash, length))>"
      }
    }
    ```
  - **無**新增 TS runtime 公共面（產生器/loader 是 test-only，不進 `src/index.ts` barrel）；**無**新增 Go public 套件（產生器/loader 在 `kernel/internal/conformance/`，外部不可 import）；**無**新增第三方依賴（TS 用 `node:crypto`；Go 用 `crypto/ed25519` + stdlib；fixture 是 JSON）。
  - **命令面**：`pnpm run verify:p1-exit`（fail-closed 聚合既有判定指令）；兩個 conformance 測試各自可被 `pnpm vitest run <path>` 與 `(cd kernel && go test ./internal/conformance/...)` 單獨重跑。

- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    TS conformance test ──▶ src/audit/kernel (verifyChain, SignedChain) [S0.5 public surface]
                       ──▶ conformance/cross-lang/chain-fixture (loader)
                            ▲
              (語言中立 fixture 資料：純 JSON，無程式碼依賴)   ← 唯一的跨 plane 連結
                            ▼
    Go conformance test ──▶ kernel/internal/verify (P1-S3 public surface within kernel)
                       ──▶ kernel/internal/conformance/fixture (loader)
    ```
  - **跨 plane 純度（本 slice 的關鍵自證）**：TS 與 Go **不互相 import**——它們唯一的耦合是「讀同一份純資料 fixture」。TS 測試只 import S0.5 的 `src/audit/kernel` public surface（`verifyChain` / `SignedChain` / `GENESIS_PREV_HASH` / `checkpointBytes` / `computeEntryHash`，皆 S0.5 已 export）；Go 測試只用 P1-S3 的 kernel-internal verifier（在 `kernel/` module 內，經其同 module 的 package 邊界）。**TS 不 import `kernel/internal/*`（Go internal 編譯器級阻擋），Go 不 import TS plane。** fixture 產生器/loader 各自留在自己 plane，不跨。
  - 僅經 public surface 消費（無 deep import）: ☑ 是（TS 側只碰 `src/audit/kernel` 既有 export；Go 側 conformance 在 `kernel/internal/conformance`，呼叫 P1-S3 verifier 的 kernel 內 public 函式，不 deep-import 寫入/storage 路徑）。
  - **新依賴宣告（逐一證明 inward + acyclic + justified）**:
    - **無新第三方依賴**（TS：`node:crypto`、`vitest`；Go：`crypto/ed25519`、`encoding/json`、`testing`，皆 stdlib/既有）。
    - **無新跨 module / 跨 plane import 邊**：本 slice 把跨 plane 耦合刻意降到「共享純資料 fixture」這個最弱形式（zero shared code），不製造任何 cycle（fixture 資料無方向性，產生器與 verifier 在各自 plane 內向內依賴）。

- **P1-conformance 契約常量（本 slice 觸及 hashing/signing 邊界——但只「驗證對齊」，一個常量都不重定義；全部沿用 S0.5 pinned）**:
  - **genesis prevHash** = `"sha256:" + 64×"0"`（S0.5 `GENESIS_PREV_HASH`）——空鏈 fixture 的 `checkpoint.headEntryHash` 必等於此；首筆 `prevHash` 必等於此。兩語言斷言相同。
  - **entryHash** = `sha256( frame( canonicalBytes(event) ‖ prevHash ‖ sequence ) )`，`sha256:`-prefixed，`frame()` 以 **8-byte big-endian length-prefix** 串接每一部分（S0.5 `computeEntryHash`）。conformance 測試的核心斷言就是「兩語言對同一 `(event, prevHash, sequence)` 算出相同 `entryHash`」。
  - **canonicalBytes(event)** = S0.2 確定性 canonical 序列（recursive key sort、UTF-8、reject non-finite/undefined、object 缺 `undefined` 屬性省略）**AFTER redaction（S0.7 by-key + by-value value-scanning）**。redaction-canary 邊界事件即用來證明「兩語言 hash 的是**已 redact** 的相同 bytes」。
  - **checkpoint** = Ed25519 簽章 over `frame( headEntryHash ‖ length )`（S0.5 `checkpointBytes`），是 **checkpoint over chain HEAD**（非 per-entry）。bad-sig 對抗變體針對此。
  - **content address / 演算法前綴版本化**：`sha256:`（不硬編對抗未來 `blake3:`）；fixture 的 `publicKey` 亦帶 `ed25519:` 版本前綴。
  > 任何「對齊」的宣稱，在兩語言 verifier 對「對方真實輸出」實跑出 `ok`（且反向 tamper 實跑出 broken）之前，一律不採信（only command output is truth）。

## (5) Test-first plan（先寫的 RED 測試）

> 本 slice 跨兩 plane：TS RED = 會失敗的 `pnpm vitest run`；Go RED = 會失敗的 `go test`。兩條 RED 都必須在寫 fixture 產生器/loader 實作前真實跑出 exit≠0 並 commit（INDEX §2.1 規則 2）。執行入口統一經 `pnpm run verify`（級聯 `verify:go`，S0.8 承接）。

- 測試檔（新增）:
  - `conformance/cross-lang/ts-verifies-go.conformance.test.ts`（TS 讀 Go fixture）
  - `kernel/internal/conformance/go_verifies_ts_test.go`（Go 讀 TS fixture）
  - （兩個產生器 `chain-fixture.ts` / `fixture.go` 的對稱性，由上述兩測試交叉驗證——一個 plane 產、另一個 plane 驗）

- **RED 測試清單（每條對應一個行為/不變量）**:
  - [ ] **方向 A happy-path（TS→Go）**：TS 產生器以 S0.5 `InMemoryAppendOnlyLog` append §3「邊界事件序列」→ 匯出 fixture → Go verifier（P1-S3）讀入 → 斷言 `ok=true, length=N`。（RED：Go fixture loader / 對 cross-lang fixture 的 Go 端讀取尚未存在時，`go test` 因 undefined symbol / 解析失敗而非零。）
  - [ ] **方向 B happy-path（Go→TS）**：Go 產生器以 P1-S3 Go log append 同一序列 → 匯出 fixture → TS `verifyChain` 讀入 → 斷言 `{ ok: true, length: N }`。（RED：TS fixture loader 尚未存在時 vitest 因 import / 解析失敗而非零。）
  - [ ] **雙向交叉等值（核心 conformance）**：對「相同事件序列 + 相同 test keypair」，斷言 TS 產的 `entries[i].entryHash` === Go 產的 `entries[i].entryHash`（逐筆），且 `checkpoint.headEntryHash` 與 `checkpoint.signature` 兩語言相等（或至少：對方 verifier 皆 `ok` 且 head/entryHash 相等）。（RED：兩語言對齊未被驗證前此斷言不存在。）
  - [ ] **publicKey 編碼 round-trip（防 bad-sig 與 wrong-key 混淆）**：TS export 的 `ed25519:<base64(SPKI DER)>` → Go `x509.ParsePKIXPublicKey` 解出 raw 32 bytes 與同一 key 逐 byte 相等；Go `x509.MarshalPKIXPublicKey` 產的 SPKI → TS `createPublicKey` 載入成功且驗章通過。（RED：編碼 parse path 未實作前此斷言失敗。）
  - [ ] **邊界事件覆蓋（防偽通過）**：上述序列**必須**含 redaction-canary 事件、非 ASCII/emoji 欄位、巢狀物件+陣列、`sequence == 2^53−1`（`Number.MAX_SAFE_INTEGER`，**不**測 >2^53−1）、genesis 首筆；另加空鏈與單筆鏈各一條。斷言每一類在兩語言皆對齊（**不得**只測空鏈/單筆就宣稱通過——reviewer 須確認 fixture 真的含這些邊界，否則 §4.8 claimed-behavior BROKEN）。
  > **預期破點釘死（對齊 pinned `verify.ts` 的 check 順序：missing → sequence → prevHash linkage → entryHash → checkpoint.length → head → signature）。** 跨語言斷言**只比對 `ok=false` 與 `brokenAt`（硬契約），不比對 reason 全文**（reason 非 byte-for-byte 契約面，見 P1-S3）；下列 reason 子句僅供人讀對照。
  - [ ] 安全對抗式（**tamper → 跨語言 broken**）：對 TS 產的 fixture 改第 i 筆 `event` 內容但**不重算 `entryHash`**（且不改 sequence/prevHash）→ **Go** verifier 回 `{ok:false, brokenAt:i}`（破在 entryHash 步，reason 含 `entry hash mismatch`）；對 Go 產的 fixture 同樣 tamper → **TS** `verifyChain` 回 `{ ok:false, brokenAt:i }`。（refute-by-default：必須是跨語言方向。）
  - [ ] 安全對抗式（**reorder → 跨語言 broken**）：對調某語言 fixture 的 entries[0] 與 entries[1]（**保留各自原始 sequence**）→ **另一語言** verifier 回 `{ok:false, brokenAt:0}`——因 index 0 處 `entry.sequence(=1) != i(=0)`，**先在 sequence 步破**（reason 含 `sequence not monotonic`），而非 prevHash linkage。（pin 此預期，使兩語言檢同一破點。）
  - [ ] 安全對抗式（**gap → 跨語言 broken**）：抽掉中間一筆、**保留原始 sequence**（呈 0,2）→ **另一語言** verifier 在 index 1 處 `entry.sequence(=2)!=i(=1)` → `{ok:false, brokenAt:1}`（sequence 步破，reason 含 `sequence not monotonic`）；`checkpoint.length` 不匹配為次要防線（若 sequence 步已破則先回該破點）。
  - [ ] 安全對抗式（**bad-sig → 跨語言 broken**）：替換 `checkpoint.signature`（或用**錯誤** publicKey 驗）→ **另一語言** verifier 回 `{ok:false, brokenAt: len(entries)}`（entries 全對、破在 checkpoint signature 步，reason 含 `checkpoint signature invalid`）。
  - [ ] 安全對抗式（**credential non-leak**）：redaction-canary 事件的 canary 以 runtime 組裝（不入 fixture 原始碼）；append 經 S0.7 value-scanning redaction，斷言 fixture 檔內、canonical bytes、`entryHash` 計算輸入、測試輸出 **0 命中** canary 原值（只見 `[REDACTED]`）；且 `pnpm run secret-scan` 對 fixture 產生器與測試檔 clean（canary 完整 pattern 在靜止原始碼中不成形）。
  - [ ] 安全對抗式（**契約純度 — 跨 plane**）：TS 測試不 import 任何 Go 路徑、Go 測試不 import 任何 TS 路徑；TS 不 deep-import `kernel/internal/*`（Go internal 編譯器級阻擋）；`pnpm run deps:check`（TS 腿）+ `golangci-lint`（Go 腿 depguard）皆綠——唯一跨 plane 連結是純資料 fixture。
  - [ ] **退出條件可重跑清單**：`verify:p1-exit`（或 INDEX 指令清單）依序重跑 §4 對照表的六條指令，全綠回 exit 0；任一非零則聚合非零（fail-closed，不吞錯）。（RED：聚合腳本尚未串接前，contract 斷言「清單涵蓋全部六條退出條件」失敗。）
- **首次紅燈證據（貼 exit≠0；fixture loader / 產生器 / conformance 測試尚未實作）**:
  ```
  # TS 腿（方向 B：讀 Go fixture）先紅
  $ pnpm vitest run conformance/cross-lang/ts-verifies-go.conformance.test.ts
  ... FAIL  Cannot find module './chain-fixture.js' (loadCrossLangChain undefined)
  exit code: 1

  # Go 腿（方向 A：讀 TS fixture）先紅
  $ pnpm run verify:go        # 或 (cd kernel && go test ./internal/conformance/...)
  --- FAIL: TestGoVerifiesTSChain_HappyPath (fixture loader not implemented)
      go_verifies_ts_test.go: undefined: conformance.LoadCrossLangChain
  FAIL    agentos/kernel/internal/conformance
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）

> **硬性 gate（INDEX §2.1 規則 1）**：本節與 §5 的所有指令 transcript / exit code 皆為**樣板佔位**；在被**真實執行時輸出**覆蓋前，**任一勾選框不得打勾**（only command output is truth）。Author/Adversarial-reviewer 欄位（標頭）亦須以真實 id 覆蓋。

- [ ] **Test-first 成立**：實作前先有 §5 的 TS + Go 雙向 RED 測試，已貼首次紅燈 exit≠0（reviewer 須經 git history / 還原 fixture 產生器重跑再確認雙向 RED 為真——尤其要確認「tamper→broken」在拿掉 verifier 對齊後不會偽綠）。
- [ ] `pnpm run verify` **exit 0**（含級聯 `verify:go`：`kernel/` 內 `go test ./...`（含 `internal/conformance`）+ `golangci-lint` 皆綠；TS 側 `vitest` 含兩個 conformance 測試綠；S0.8 cascade 承接）。
  ```
  $ pnpm run verify
  ... vitest: conformance/cross-lang/*.conformance.test.ts  PASS
  ... verify:go: go test ./...  ok   golangci-lint: 0 issues
  ... exit code: 0
  ```
- [ ] **雙向 conformance 綠（happy-path）**：方向 A（TS→Go）與方向 B（Go→TS）各回 `ok`，且雙向交叉等值（entryHash 逐筆相等、checkpoint head/signature 相等）通過。
  ```
  $ pnpm vitest run conformance/cross-lang/ts-verifies-go.conformance.test.ts ; echo "exit=$?"   # 0
  $ (cd kernel && go test ./internal/conformance/...) ; echo "exit=$?"                            # 0
  ```
- [ ] **對抗式雙向 broken（refute-by-default）**：四種 tamper（tamper/reorder/gap/bad-sig）對「一語言產、另一語言驗」皆回 broken（測試斷言 `ok=false` / 非零；reviewer 親跑至少一個方向確認）。
- [ ] **Phase-1 exit-criteria 可重跑清單綠**：`pnpm run verify:p1-exit`（= `bash scripts/verify-p1-exit.sh`，`set -euo pipefail`）全綠 exit 0；六條退出條件各有對映 slice + 判定指令（見 §「Phase-1 退出條件對照表」），無「自述完成」。
- [ ] **聚合 fail-closed 已對抗證明**：暫時強制 `verify-p1-exit.sh` 內某一子指令回非零（如改一條為 `false`）→ 聚合 `pnpm run verify:p1-exit` **exit≠0**（證明不吞錯、不偽綠）；還原後 exit 0。兩段輸出皆貼。
- [ ] **dependency-boundary check 綠（雙腿）**：TS 腿 `pnpm run deps:check` exit 0（TS 測試不 import Go、不 deep-import kernel internal）；Go 腿 `golangci-lint run ./...` exit 0（depguard：conformance package 不反向 import 寫入/storage 路徑、不 import control-plane/SDK）。經 S0.8 `verify:go` 併入 `pnpm run verify`。
- [ ] **low coupling / high cohesion 遵守**：跨 plane 唯一連結是純資料 fixture（zero shared code）；產生器/loader/測試各留自己 plane；無 cyclic / 無 deep import；本 slice **零 kernel 行為變更**（不重定義任何 hash/sign/canonical 常量）。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` 輸出 `secret-scan: clean`；reviewer 自設 canary 後在 6 sink（workspace/logs/artifacts/snapshots/traces/fixtures）+ fixture 檔本身 + canonical bytes + 測試輸出 grep **0 命中**（fixture 只含**已 redact** 的 canonical 事件 + hash + base64 簽章 + 公鑰，**無 private key、無 secret**）。
- [ ] **Docs 更新**：`docs/slices/phase-1/INDEX.md` 建立（P1 slice DAG + no-cycle 證明 + 退出條件勾稽，且 **§2.1 verbatim 重述/連結 phase-0/INDEX.md §2.1 的 EXECUTION-TIME-EVIDENCE 規則**，對齊 phase-0/INDEX.md 慣例——解除前向循環）；roadmap §3.1 六個 checkbox 標注證明來源；kernel README/設計 doc 記載「**跨語言 conformance = TS verifier ↔ Go verifier 兩個原生 verifier 互認；WASM verifier / 外部錨定 / Tessera tile / per-tenant 簽章在 P3/P4**」（避免過度宣稱）。
  > 註：`phase-1/INDEX.md` 由 lead-editor 統一建立（本 slice 的 DoD 涵蓋其 §2.1 規則齊備）；P1-S5 等 slice 引用該 INDEX 登記其 DAG 邊。
- [ ] **Adversarial code review = PASS**（fresh-context、!= author、refute-by-default）— 主攻面：**§4.8 claimed behavior**（fixture 是否只測空鏈/單筆而掩蓋 redaction/非 ASCII/大 sequence 不對齊；雙向是否只測 happy-path 而沒測「一語言 tamper→另一語言 broken」）、**§4.7 low coupling/high cohesion**（跨 plane 是否真的只經純資料 fixture、有無偷共享 internals）、**§4.3 credential non-leak**（canary 是否被寫進 fixture 檔 / 是否 runtime 組裝）、**§4.5 audit gap/tamper**（gap/tamper 變體是否真被另一語言偵測、有無 fail-open）。連結/摘要: <...>
- [ ] **（安全不變量類 slice）Independent Verifier Pass** 已執行並 clean：fresh-context verifier 重跑 `pnpm run verify` + 雙向 conformance + `verify:p1-exit`，並對抗式探測「換一個非 ASCII / 大 sequence / redaction-canary 事件是否仍兩語言對齊」「把 tamper 改成同語言驗是否被偷換成偽通過」皆 HELD，且確認 doc **未**宣稱已達成 P4 的 WASM/external-anchoring 或 P3 的 per-tenant 簽章。

## (7) Rollback

- 回退方式: `git revert <merge-sha>`（含 cross-lang fixtures 產生器/loader、兩個 conformance 測試、INDEX.md、roadmap 勾稽、可選 `verify:p1-exit` 腳本）。
- 可逆性: **完全安全可逆**——本 slice **只新增驗證層與文件**，零持久化、零外部副作用、**零 kernel 行為變更**（不觸碰任何已寫入鏈、不改任何 hash/sign 定義）。回退後 kernel 的證據行為與 P1-S6 完全相同；唯一損失是「跨語言互認的 golden 證據與退出收口」。
- **不可逆審計面（slice-spec §7）**：本 slice **不寫任何 audit 歷史**（fixture 是 test-only、in-memory 產生 + 純資料匯出），故無 append-only 歷史需保護。若未來發現雙向不對齊，修法是**修上游（S0.5/P1-S3）並重產 golden**，**不得**改寫既有鏈或放寬 conformance 斷言。

## (8) Depends-on / blocks

- **Depends-on**:
  - **P1-S3**（standalone Go verifier + Go append-only log + checkpoint，byte-for-byte 對齊 S0.5）—— 本 slice 的 Go 端產生器/verifier 全部用它的 public surface；雙向 conformance 的「Go 腿」即驗證它真的與 S0.5 對齊。
  - **P1-S6**（gRPC ingest proto + kernel 獨立進程 + append-only client）—— 提供「kernel 已是獨立進程 / 只能 append」的脈絡，使本 slice 的退出收口涵蓋「control plane 無法改寫」「進程分離」兩條退出條件（其判定指令由 P1-S6 提供，本 slice 編排進清單）。
  - （phase 前置）**S0.5**（pinned TS 契約常量：genesis prevHash / entryHash via `frame()` 8-byte big-endian / checkpoint-over-HEAD / `sha256:` 版本化）—— 本 slice 的 TS 端 verifier 與所有 conformance 斷言以之為唯一真相，**一個常量都不重定義**。
  - （傳遞性，經 P1-S6/P1-S3）**P1-S4**（durable + monotonic per-source sequence + gap detection）、**P1-S5**（transactional outbox + synchronous-commit-before-effect）—— 提供「gap 注入報錯」「commit-before-effect 時序」兩條退出條件的判定指令，本 slice 只編排進可重跑清單，不重做。
  - （gate 前置）**S0.8**（`verify` polyglot 級聯，plane dir 預設 `kernel/`，fail-closed）—— 承接 `verify:go`，使本 slice 的 Go conformance 測試一進場即無法繞過 `pnpm run verify`。
- **Blocks**:
  - **P2**（Personal beachhead c24）—— P2 串本機 kernel 時，可信賴「TS 產的事件鏈可被 Go kernel 驗、Go kernel 產的鏈可被 TS verifier 驗」這條已 golden 化的不變量。
  - **P4**（c1 Oversight-of-Record / c2 Insurable Autonomy）—— WASM verifier（讓不信任平台 re-verify）以本 slice 的「兩個原生 verifier 互認 + 語言中立 fixture 格式」為基線；P4 的 WASM verifier 應對同一 golden fixture 亦回 `ok`/broken（本 slice 的 fixture 格式即未來 WASM verifier 的 conformance vector 起點）。
- 確認 slice DAG 無 cycle: ☑ 是（P1-S7 → {P1-S6(→{P1-S6a→P1-S2, P1-S5→P1-S4→P1-S3→P1-S2→P1-S1}), P1-S3}；加 phase 前置 {S0.5, S0.8}，皆指向較早 rank / earlier slice，無回邊。INDEX.md 以直接邊 `P1-S7 -> {P1-S3, P1-S6}` 表達）。

---

## 附註一：Phase-1 退出條件對照表（roadmap §3.1 ↔ slice ↔ 可重跑判定指令）

> 本 slice 的「退出收口」就是把下表編排成 `verify:p1-exit`（或 INDEX 指令清單），讓六條退出條件一次重跑、逐條看 exit code。**本 slice 不重新實作任何指令，只編排 + 勾稽。**

| roadmap §3.1 退出條件 | 由哪個 slice 交付 | 可重跑判定指令（exit code 即真相） |
|---|---|---|
| `pnpm run verify`（含級聯 `verify:go`）exit 0 | S0.8 + P1-S1（+ 全部 P1 slice 維持綠） | `pnpm run verify ; echo "exit=$?"`（須 0） |
| standalone verifier 對竄改鏈回非零、對完好鏈回 0（黃金測試） | P1-S3 | `(cd kernel && go test ./internal/verify/... ./cmd/verifier/...) ; echo "exit=$?"`（intact=0；tampered 案例斷言 broken / CLI exit≠0） |
| 對抗式：control plane 無法改寫已 append 紀錄（嘗試即失敗 + 被 audit） | P1-S6（runtime/codegen 由 P1-S6a） | `(cd kernel && go test ./internal/server/...) ; echo "exit=$?"`（重寫/越序 → typed deny + audit） |
| sequence-gap 注入：丟中間一筆 → gap detection 報錯 | P1-S4（+ P1-S6 ingest 路徑） | `(cd kernel && go test ./internal/sequence/... -run TestGap) ; echo "exit=$?"` |
| synchronous-commit-before-effect：先 commit 證據再放行副作用（時序測試） | P1-S5 | `(cd kernel && go test ./internal/commitgate/... -run TestCommitBeforeEffect) ; echo "exit=$?"` |
| cross-language conformance：TS 產的鏈在 Go verifier 通過、反之亦然 | **P1-S7（本 slice）** | `pnpm vitest run conformance/cross-lang/ts-verifies-go.conformance.test.ts && (cd kernel && go test ./internal/conformance/...)` |
| 每個 slice Adversarial Review = PASS | 全部 P1 slice | 各 slice `## Adversarial Review` 區段 PASS（process gate，非單一指令；INDEX 逐 slice 勾稽） |

> 指令路徑以對應 slice merge 後的真實檔案為準（上表已對齊各 slice 釘定的 package 名：`internal/verify`、`cmd/verifier`、`internal/server`、`internal/sequence`、`internal/commitgate`、`internal/conformance`）；本 slice 在 INDEX.md 以 merge 後的真實路徑落定，並在 `scripts/verify-p1-exit.sh`（`set -euo pipefail`）內以**真實**指令串接（fail-closed：任一非零 → 聚合非零，不吞錯）。

## 附註二：本 slice 的對抗面（keyRisk 對照，供 reviewer 主攻）

**主要風險 = 對齊偽通過（conformance 名實不符）。** reviewer 須具名嘗試以下破口（任一成立即 FAIL）：

1. **fixture 只覆蓋簡單情形以掩蓋不對齊**：reviewer 檢查 fixture 是否**真的**含 redaction-canary 事件、非 ASCII/emoji、巢狀物件+陣列、`sequence == 2^53−1`（不是 >2^53−1，後者 TS 參考無法表達、屬 deferred）、genesis 首筆——而非只有空鏈/單筆。具體攻法：把一個含中文+emoji+巢狀陣列+ `sequence=2^53−1` 的事件加進序列，確認兩語言 `entryHash` 仍逐筆相等；若測試只在空鏈/單筆通過、加邊界事件就裂，則 conformance 是假的 → FAIL（§4.8）。
2. **雙向只測 happy-path、未測「一語言 tamper→另一語言 broken」**：reviewer 確認四種 tamper（tamper/reorder/gap/bad-sig）的斷言方向是**跨語言**（TS tamper → Go broken、Go tamper → TS broken），而非同語言自驗或只在一個方向測。具體攻法：把某個 tamper 斷言偷偷改成「同語言 verifier 驗」，看測試是否仍綴——若仍綠，refute-by-default 失效 → FAIL。
3. **canary 被寫進 fixture 檔（credential leak）**：reviewer grep fixture 檔、產生器原始碼、golden 資料，確認 canary 完整 pattern 在靜止原始碼中**不成形**（runtime 組裝）、fixture 只含 `[REDACTED]`；並確認 fixture **絕無 private key**（只有 public key）。具體攻法：跑 `pnpm run secret-scan` + 自設 canary 後在 6 sink + fixture 檔 grep，任一命中 → FAIL（§4.3）。
4. **本 slice 偷改上游 hash/sign 定義以「湊綠」**：reviewer 確認本 slice diff **未觸碰** `src/audit/kernel/log.ts`/`verify.ts`/`canonical.ts` 或 Go 端 P1-S3 的 hash/frame/checkpoint 定義——conformance 必須是「驗證既有兩語言對齊」，不是「為了綴而調整任一語言的常量」。具體攻法：若雙向不對齊，正解是修上游並重產 golden（且該修正本身是上游 slice 的回歸），**不得**在本 slice 放寬斷言或調常量；任何在本 slice 內改動 hash/sign 定義 → FAIL（scope creep + 破壞 byte-for-byte 契約）。
5. **退出收口吞錯（fail-open 聚合）**：reviewer 確認 `scripts/verify-p1-exit.sh`（`set -euo pipefail`）對「任一子指令非零」會聚合非零、不靜默吞錯、不偽綠（fail-closed）。具體攻法：暫時把一條子指令改成 `false`，確認 `pnpm run verify:p1-exit` exit≠0；還原後 exit 0（此攻法已升為 §6 DoD 勾選項）。
6. **跨 plane 偷共享 internals**：reviewer 確認 TS 測試不 import 任何 Go 路徑、Go 測試不 import 任何 TS 路徑、TS 不 deep-import `kernel/internal/*`（Go internal 編譯器級阻擋）——唯一跨 plane 連結是純資料 fixture。具體攻法：嘗試在 TS 測試 import Go 產生器、或在 Go 偽 import TS plane，應結構上不可行 / 被 deps:check + depguard 攔下。
