# Phase 1 Slices — INDEX

> **狀態（2026-06-19）：Phase 1 slices 已 authored（DRAFT）。** Phase 0 全部完成（S0.1–S0.8 merged）；本目錄為 P1
> 的 slice 級拆解，依 `docs/standards/slice-spec.md` 範本撰寫，**尚未實作**——每個 slice 仍須走
> branch → **RED test-first** → `pnpm run verify`（含級聯 `verify:go`）→ **fresh-context 對抗式 code review = PASS**
> → `--no-ff` merge。**本 INDEX 只是計畫；任何「綠/通過/done」都必須以執行時的指令 exit code 為憑（only command output is truth）。**

> **Phase 1 的唯一意圖：實作 Go evidence kernel —— 一個 durable、append-only、hash-chained、SIGNED WORM audit spine，
> 跑在獨立的進程 / 身分 / 語言（Go），TS Governance Plane 與 OpenShell supervisor 對它 ONLY APPEND（永不改寫）。**
> 對應 [roadmap.md](../../roadmap.md) §3.1 與 [architecture-approach.md](../../research/architecture-approach.md) §4「Phase 1」。
> 它是 killer apps **c1（Oversight-of-Record）、c2（Insurable Autonomy）、c3（Tenant-Sealed Fleet）、c4（Maker-Checker）**
> 的 gating 依賴。**AGENTS.md 在任何衝突上勝出。**
>
> 鐵律（Looping Engineering，逐 slice 強制）：
> - **只有指令輸出是真相（only command output is truth）** — 任何「綠/通過/done」都必須附**實際指令的 exit code**，不接受 agent 自述。
> - **Test-first TDD（Go：先寫失敗的 `go test` = RED）** — 每個 slice 先寫 RED 失敗測試，再實作到 GREEN，capped loop（≈6 次內收斂，否則重評邊界；無 unbounded loop）。
> - **Deny-by-default + fail-closed everywhere**；credentials 絕不進 workspace/logs/artifacts/snapshots/traces/fixtures —— **kernel 只存已 redact 的 canonical bytes**。
> - **HARD CONSTRAINT A（low coupling / high cohesion）** — Go 端由 `internal/`（編譯器級封裝）+ depguard（golangci-lint）雙重執法，接進 `pnpm run verify:go`；跨 plane（TS ↔ Go）只經型別化契約（gRPC ingest proto + 共享純資料 golden fixture），**零 shared internals**。
> - **HARD CONSTRAINT B（per-slice adversarial code review）** — 每個 slice merge 前必過剛好一次 fresh-context、refute-by-default 的對抗式審查 = PASS（[adversarial-code-review.md](../../standards/adversarial-code-review.md)）。

---

## 0. Phase 1 在做什麼 / 不做什麼

| 做（in-scope of Phase 1，「先簡」） | 不做（留給後續 phase，「後繁」） |
|---|---|
| `kernel/` Go module bootstrap：`go.mod` + `.golangci.yml`（depguard）+ `internal/`，把 S0.8 的 `verify:go` cascade **從 fail-closed skip 翻為 enforcing**（S1） | 真實 **Tessera tile-log**（Merkle tile / inclusion / consistency proof）→ **P4** |
| Go canonical-bytes + entryHash + checkpoint，**byte-for-byte conform** 到 S0.5 pinned TS 契約（golden vectors 鎖定）（S2） | **RFC-3161 / transparency-log 外部錨定**（external witness / inclusion proof）→ **P4** |
| in-memory `AppendOnlyLog` + **standalone verifier**（tamper/reorder/gap/bad-sig 黃金測試）（S3） | **WASM verifier**（讓不信任平台 / 瀏覽器 re-verify）→ **P4** |
| **durable** append-only storage（fsync 後才 committed）+ kernel-enforced **monotonic per-source sequence** + **gap detection**（S4） | **per-tenant 分區簽章 / gateway-per-tenant / 跨租 conformance** → **P3** |
| **transactional outbox**（producer 端）+ **synchronous-commit-before-effect** + producer 端 idempotent 去重（S5） | TS control plane 真正以 ingest client 串 kernel、Approval Inbox / Task Timeline 等 → **P2** |
| **gRPC ingest proto**（zero shared internals）+ kernel 作為**獨立進程** + **append-only client**（control plane 無法改寫已 append 紀錄）（S6，runtime/codegen 依賴在先行的 S6a） | mTLS / 進程身分 production 硬化 → **P3** |
| **cross-language conformance（TS↔Go 雙向）** + Phase-1 全部退出條件可重跑收口（S7） | 多來源跨節點全域排序 / 分散式共識 → 非本 phase |

> **先簡後繁（roadmap §3.1）**：P1 = simple signed append-only hash-chain + Ed25519 checkpoint + standalone verifier
> + ingest 完整性（monotonic per-source sequence + gap detection + transactional outbox）+ synchronous-commit-before-effect
> + gRPC ingest（kernel 為獨立進程）。**Tessera tile-log / RFC-3161 外部錨定 / WASM verifier 全屬 P4，本 phase 一律不做。**

> **前置（Phase 0 已 merge）**：本 phase 的 Go gate **插入 S0.8（`SLICE-P0-008`）建立的 `verify:go` cascade**——
> S0.8 已把 `verify:go` / `verify:py` 串進 `pnpm run verify` 並 fail-closed（plane 不存在→skip exit 0；存在卻未設定
> gate→exit≠0）。**P1-S1 即該 cascade 的 Go 承接點**：一旦 `kernel/` 出現且 `go.mod` + `.golangci.yml` 齊備，
> `verify:go` 從 skip 翻為 enforcing（`go vet ./... && go test ./... && golangci-lint run`）。**`verify:go` 的
> skip→enforcing 翻轉由 P1-S1 唯一擁有**；S2–S7 進場時 `verify:go` 已 enforcing，各 slice 只對 P1-S1 既有
> `.golangci.yml`**增補** depguard rule、不重建 `go.mod`/`.golangci.yml`。

---

## 1. Slice 清單與 DAG

| Slice | 檔案 | Title | Layer（11 層） | Net LOC（估） | Depends-on（直接邊） |
|---|---|---|---|---|---|
| **P1-S1** | [P1-S1-…](./P1-S1-go-kernel-bootstrap-verify-gate.md) | `kernel/` Go module bootstrap + 真實 `verify:go` gate（depguard + `internal/`） | audit / evidence-kernel（build/boundary gate） | ~80 | （無 P1 內部前置；承接 S0.8 / S0.5） |
| **P1-S2** | [P1-S2-…](./P1-S2-go-canonical-entryhash-checkpoint-conformance.md) | Go canonical-bytes + entryHash + checkpoint，byte-for-byte conform 到 S0.5（golden vectors） | audit / evidence-kernel | ~240 | P1-S1 |
| **P1-S3** | [P1-S3-…](./P1-S3-go-append-only-log-standalone-verifier.md) | in-memory `AppendOnlyLog` + standalone verifier（tamper/reorder/gap/bad-sig 黃金測試） | audit / evidence-kernel | ~240 | P1-S2 |
| **P1-S4** | [P1-S4-…](./P1-S4-durable-storage-monotonic-sequence-gap-detection.md) | durable storage + monotonic per-source sequence + gap detection | audit / evidence-kernel + persistence | ~280 | P1-S3 |
| **P1-S5** | [P1-S5-…](./P1-S5-transactional-outbox-sync-commit-before-effect.md) | transactional outbox + synchronous-commit-before-effect（producer 端去重） | audit / evidence-kernel + orchestration 邊界 | ~280 | P1-S4 |
| **P1-S6a** | （依賴-only，由 lead-editor 登記；slice-doc 於實作前由 P1-S6 author 補寫） | gRPC/protobuf runtime + buf/protoc 工具鏈 + `proto/` 骨架 + `proto:check` 接進 verify（**零行為**） | build/CI（跨 plane proto 契約根） | ~60（+依賴新增單列） | P1-S2 |
| **P1-S6** | [P1-S6-…](./P1-S6-grpc-ingest-proto-kernel-separate-process-append-only-client.md) | gRPC ingest proto（Append service）+ kernel 獨立進程 + append-only client（行為-only） | audit / evidence-kernel + sandbox/control-plane 邊界 | ~240 | P1-S6a, P1-S2, P1-S5 |
| **P1-S7** | [P1-S7-…](./P1-S7-cross-language-conformance-exit-criteria-closeout.md) | cross-language conformance（TS↔Go 雙向）+ Phase-1 exit-criteria 收口 | audit / evidence-kernel（驗證層 + 收口） | ~220 | P1-S3, P1-S6 |

> **P1-S6a 的拆分理由（slice-spec §4「依賴變更不與行為變更同 slice」）**：gRPC/protobuf runtime 與 codegen 工具鏈是
> **新增第三方依賴**，必須單獨成一個依賴-only slice。它**零行為**（不寫 server/client 邏輯），RED = 失敗的存在性/契約
> 斷言（`proto:check` 未串接前紅、generated stub 與 `.proto` 不一致時 exit≠0）。P1-S6 的行為（Append enforcement +
> append-only client + 對抗測試）depends-on P1-S6a 已就位的 runtime/codegen。其 slice-doc 在 P1-S6 實作前由 P1-S6 author
> 依 slice-spec 範本補寫進本目錄。

### Slice DAG（鄰接表，無 cycle — slice-spec §9）

依賴以**鄰接表（adjacency list）**表示，一行一條邊「`X -> Y` 讀作 X depends-on Y」（機械可檢，無歧義）。
僅列 **P1 內部直接邊**（Phase-0 前置 S0.5 / S0.8 為更低 rank 的已 merge 契約，逐 slice 在其 §8 明寫，不入下圖以保簡潔）：

```
P1-S1  -> ()                       # kernel/ bootstrap + verify:go skip→enforcing；無 P1 內部前置
P1-S2  -> { P1-S1 }                # canonical/entryHash/checkpoint conformance（需可編譯 Go module + enforcing gate）
P1-S3  -> { P1-S2 }                # AppendOnlyLog + standalone verifier（需 conforming hash/checkpoint primitives）
P1-S4  -> { P1-S3 }                # durable storage + per-source sequence + gap detection
P1-S5  -> { P1-S4 }                # transactional outbox + commit-before-effect（需 durable commit 點）
P1-S6a -> { P1-S2 }                # 依賴-only：gRPC/protobuf runtime + codegen 工具鏈 + proto:check（零行為）
P1-S6  -> { P1-S6a, P1-S2, P1-S5 } # gRPC ingest Append + 獨立進程 + append-only client（行為-only）
P1-S7  -> { P1-S3, P1-S6 }         # TS↔Go 雙向 conformance + Phase-1 exit-criteria 收口
```

> **無 cycle 證明（拓撲序存在）：** 指派 rank：
> rank(P1-S1)=0；rank(P1-S2)=1；rank(P1-S3)=2；rank(P1-S4)=3；rank(P1-S5)=4；rank(P1-S6a)=2；rank(P1-S6)=5；rank(P1-S7)=6。
> 逐邊檢查（每條邊都從高 rank 指向**嚴格較低** rank，無回邊）：
> - P1-S2→P1-S1 (1>0)；P1-S3→P1-S2 (2>1)；P1-S4→P1-S3 (3>2)；P1-S5→P1-S4 (4>3)；
> - P1-S6a→P1-S2 (2>1)；P1-S6→{P1-S6a(5>2), P1-S2(5>1), P1-S5(5>4)}；P1-S7→{P1-S3(6>2), P1-S6(6>5)}。
> 所有邊嚴格遞減 ⇒ 無回邊 ⇒ **DAG（acyclic）**。確認 slice DAG 無 cycle：**是**。
>
> **排序紀律（slice-spec §9「契約先於消費者、不超前 phase 依賴」）：** 先讓 `verify:go` 由 skip 翻為 enforcing（S1），
> 再釘死 byte-for-byte 對齊的 crypto primitives（S2，被所有後續消費），接著 in-memory chain + standalone verifier（S3）、
> durable + per-source sequence（S4）、outbox + commit-before-effect（S5）、依賴-only 工具鏈（S6a）→ 跨進程 gRPC
> append-only（S6），最後跨語言雙向 conformance + 對抗式毀證/改寫/gap 收口（S7）。

### 跨 plane / 跨 module 邊界（HARD CONSTRAINT A）

- **跨 plane 互動只經型別化契約：** S2/S7 的 TS↔Go 對齊**只經共享 golden / cross-lang fixture（純資料、非 code）**
  與已 pin 的 TS 契約（`src/audit/kernel/*.ts`、`src/audit/canonical.ts`、`src/audit/redact.ts`）——Go 端不 import
  TS internals、TS 端不 import Go internals。S6 的 control-plane↔kernel **只經 gRPC ingest proto**（zero shared
  internals）。
- **Go plane 內部邊界由 depguard + `internal/` 強制（P1-S1 落地、後續每 slice 承接並增補規則）：**
  S2 加 `internal/canonical` 不得 import `internal/chain`；S4 加 `internal/store` 不得 import `internal/sequence`；
  S3/S6 加 `internal/verify` 不得 import `internal/log` / `internal/server`（standalone verifier 只依
  public chain+checkpoint+publicKey，不依賴 log/storage/server internals）。
- **依賴方向 inward-pointing、acyclic（domain ← application ← adapters）：**
  domain（hash/chain/canonical）← application（log / sequence / outbox / commitgate）← adapters（store / gRPC server/client）。

---

## 2. 每個 slice 共同遵守的 Definition of Done（逐條指令可證）

每個 slice doc 的 §6 各自展開，但**全部**至少滿足（slice-spec §6 DoD + adversarial-code-review §5 MERGE GATE）：

- [ ] **Test-first 成立**：實作前先有對應 RED 測試（Go：先寫失敗的 `go test`），已貼首次紅燈 exit code（≠0）。
- [ ] `pnpm run verify` **exit 0**（typecheck && lint && build && test && deps:check && **verify:go**（含 enforcing Go gate）&& verify:py && secret-scan；輸出尾段 + exit code 已貼）。
- [ ] **dependency-boundary check 綠**：TS 腿 `pnpm run deps:check` exit 0；**Go 腿** `golangci-lint run`（depguard）exit 0——reviewer 須在 clean checkout 親植違規 fixture 證 depguard 非 no-op（exit≠0），移除後 exit 0。
- [ ] **low coupling / high cohesion 遵守**：無新增跨 module / cyclic 依賴；觸及 module 僅經 public surface 被消費（Go：`internal/` 套件對 kernel 外不可見；跨 plane 只經 proto / 純資料 fixture），無 deep import。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` 輸出 `secret-scan: clean`；reviewer 自設 canary（runtime 組裝、不入任何 fixture 檔）後在 6 sink（workspace/logs/artifacts/snapshots/traces/fixtures）+ chain/receipt/checkpoint/audit payload/`AppendError.detail` grep **0 命中**（**kernel 只存已 redact 的 canonical bytes**）。
- [ ] **Docs 更新**（若 behavior/commands/API/policy/config 改變）；明寫本 slice **未**達成的後續能力（避免過度宣稱 tamper-evidence / 進程級不可改寫 / cross-language 互驗）。
- [ ] **Adversarial code review = PASS**（fresh-context、!= author、refute-by-default；reviewer 親自重跑 `pnpm run verify` + `cd kernel && go test ./...`；coupling/cohesion 為阻斷維度；缺項 / 超 §3 尺寸 / slice DAG 成 cycle 任一 → FAIL，不得 merge）。
- [ ] **（安全不變量類 slice，S2–S7 皆是）Independent Verifier Pass** 已對抗式探測 deny-by-default / fail-closed / credential non-leak / audit 完整性（依 slice 取用），全 HELD。

### 2.1 共同規則（適用每份 slice-doc 的 §5/§6，避免逐檔重複；**verbatim 重述 `docs/slices/phase-0/INDEX.md §2.1`，使 P1 自含、解除前向循環**）

> 下列規則**一次定義於此、每份 slice-doc 引用**（only-command-output-is-truth 的具體落地）。其規範來源是
> `docs/slices/phase-0/INDEX.md §2.1`；此處 verbatim 重述以使 Phase-1 文件自含（P1 slice-doc 不必反向依賴 P0 INDEX、亦不互相前向引用）：

1. **EXECUTION-TIME EVIDENCE（執行時填入，非完成宣稱）：** 每份 slice-doc §5/§6 中的指令 transcript
   與 exit code（例如 `$ pnpm run verify … exit code: 0`、`first RED exit code: 1`）**都是樣板佔位，不是
   已達成的結果**。它們**必須**在執行時被**真實輸出覆蓋**；在被真實輸出覆蓋前，**不得**據此宣稱該 slice
   已綠/已 done。讀者請把這些行讀作「此處貼真實輸出」的指示。Author / Adversarial-reviewer 欄位亦須以真實 id 覆蓋。
2. **First-RED 必須是真實捕獲、且早於實作：** 每份 slice 的「首次紅燈」**必須是作者在寫任何實作前真實跑出
   的 exit≠0 輸出，並 commit**（test-first）。**禁止**在實作存在後補一段看起來像紅燈的文字。對 Go slice，
   「build-failed 紅」只證明檔案不存在；凡測試在斷言不變量者（commit-before-effect、conformance、gap 偵測…），
   RED 須**升級為「斷言失敗的紅」**（先讓 package 可編譯的 stub 再跑測試取得斷言失敗）。adversarial
   reviewer 須經 git history / 親自還原實作重跑（adversarial-code-review.md §3.3 第 4 步）**再確認 RED 為真**。
3. **Per-slice 實作 loop cap（Looping Engineering，無 unbounded loop）：** 每份 slice 的 RED→GREEN→verify
   內圈**有 cap**：若在 **≈6 次**迭代內仍無法 GREEN，**停止、重新評估 slice 邊界（很可能切太大）、必要時
   退回 DRAFT 重切**（呼應 slice-spec §3 與 adversarial-code-review §5 連 3 次失敗重評）。
4. **canary 是「明顯非機密」的 sentinel：** credential-non-leak 用的 canary（如 `["CANARY","SECRET",uuid].join("-")`）
   是**刻意構造、明顯非真實憑證**的 sentinel；它**只在記憶體構造、不寫入任何 fixture 檔**。secret-scan 對它
   的共存處置以 `docs/standards/test-and-acceptance.md` §3.2 的綁定機制為準（runtime 組裝 / scanner allowlist
   其一，並記於 `docs/guardrails.md`），確保第 6 sink 的 secret-scan 不因 canary 而誤報、也不漏報真 secret。

---

## 3. Phase-1 退出條件（roadmap §3.1 — command-verifiable；各 slice 貢獻其中數條）

> P1-S7 把下列六條 + per-slice adversarial review 收成一條可重跑清單 `scripts/verify-p1-exit.sh`
> （`set -euo pipefail`，fail-closed：任一子指令非零 → 聚合非零，不吞錯），並在 roadmap §3.1 標注證明來源。
> **指令 exit code 即真相；下列勾選框在被真實輸出覆蓋前不得打勾。**

- [ ] `pnpm run verify`（含級聯 `verify:go`）**exit 0**。 → S0.8 + **P1-S1**（+ 全部 P1 slice 維持綠）
- [ ] standalone verifier 對「被竄改的鏈」回**非零** exit、對「完好鏈」回 **0**（黃金測試）。 → **P1-S3**（`cd kernel && go test ./internal/verify/... ./cmd/verifier/...`）
- [ ] 對抗式：control plane **無法**改寫已 append 的紀錄（嘗試即失敗 + 被 audit）。 → **P1-S6**（`cd kernel && go test ./internal/server/...`；runtime/codegen 由 **P1-S6a**）
- [ ] sequence-gap 注入測試：丟一筆中間紀錄 → gap detection 報錯。 → **P1-S4**（`cd kernel && go test ./internal/sequence/... -run TestGap`）
- [ ] synchronous-commit-before-effect：先 commit 證據再放行副作用（時序測試）。 → **P1-S5**（`cd kernel && go test ./internal/commitgate/... -run TestCommitBeforeEffect`）
- [ ] cross-language conformance：TS 產的鏈在 Go verifier 通過、反之亦然（含「一語言 tamper → 另一語言 broken」）。 → **P1-S7**（`pnpm vitest run conformance/cross-lang/ts-verifies-go.conformance.test.ts && (cd kernel && go test ./internal/conformance/...)`）
- [ ] 每個 slice **Adversarial Review = PASS**。 → 全部 P1 slice（process gate；INDEX 逐 slice 勾稽）

> **byte-for-byte conformance 錨點（S0.5 / `src/audit/kernel/log.ts` 釘死，Go 與 TS verifier 須互認）：**
> - genesis prevHash = `"sha256:" + 64 個 "0"`（real value，非空、非省略）。
> - `entryHash = sha256( frame( canonicalBytes(event), prevHash, String(sequence) ) )`，`"sha256:"`-prefixed；`frame()` 每段以 **8-byte big-endian** 長度前綴（無分隔歧義）。
> - `canonicalBytes(event)` = S0.2 確定性序列化（遞迴 key 排序、UTF-8、拒 non-finite/undefined）**AFTER redaction（S0.7 by-key + by-value）**。
> - `checkpoint` = Ed25519 簽 `frame( headEntryHash, String(length) )` —— checkpoint **over chain HEAD**（非 per-entry）。
> - 演算法前綴**版本化**（`sha256:` now；不對未來 `blake3:` 硬編）。

---

## 4. 與既有契約 / scaffold 的對齊（不重寫，只新建 Go plane + 消費 pinned 契約）

| 既有 / 上游 | Phase 1 如何對齊 | 觸碰它的 slice |
|---|---|---|
| `src/audit/kernel/log.ts`（pinned `GENESIS_PREV_HASH`/`frame`/`computeEntryHash`/`checkpointBytes`） | Go 端 byte-for-byte 重現；**一個常量都不改 TS**（Go 對齊 TS） | S2（重現）、S3/S6（消費）、S7（雙向互驗） |
| `src/audit/canonical.ts` / `src/audit/redact.ts`（S0.2 canonical + S0.7 redact-before-canonicalize） | Go 端重現確定性序列化 + by-key/by-value redaction；kernel 只 hash **已 redact** 的 bytes | S2（重現）、S7（canary 邊界事件互驗） |
| `src/audit/kernel/verify.ts`（standalone `verifyChain` + check 順序） | Go verifier 重算同一鏈、check 順序對齊（sequence→linkage→entryHash→checkpoint）；`Ok`/`BrokenAt` 為硬契約、`reason` 非 byte-for-byte 契約面 | S3（Go verifier）、S7（雙向 tamper/gap broken） |
| `scripts/verify-go.sh`（S0.8 fail-closed cascade，預設 plane dir `kernel/`） | **P1-S1 不改其邏輯**，只提供 `kernel/go.mod` + `.golangci.yml` 使其分支由 skip 翻為 enforcing | S1（翻轉、唯一擁有）；S2–S7（維持綠、增補 depguard rule） |
| `package.json` `verify` / `verify:go` | `verify:go` 由 P1-S1 變 enforcing；P1-S7 新增 `verify:p1-exit` 聚合腳本（fail-closed） | S1、S7 |

> 任何 slice 若需「重寫」既有 TS 契約而非「Go 對齊 TS」，即違反 P1 意圖與 byte-for-byte conformance，**退回重切**。
> 若雙向不對齊，正解是**修上游（S0.5 / P1-S2 / P1-S3）並重產 golden**，**不得**在下游 slice 放寬斷言或調常量。
