# SLICE-P2R-R10-S5: verifier 認 RestoreEvent（無授權標記的 state 跳轉 → tamper fail）

- **Phase**: P2（time-travel ITEM R10；verifier 擴充，design §45；Build-list #9）
- **Branch**: slice/p2r-r10-s5-verifier-restoreevent
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~140、files <~4（`kernel/internal/verify/restore.go` + `kernel/internal/verify/restore_test.go`；TS 鏡像 `src/audit/kernel/verify-restore.ts` + test 若需跨語一致）、modules <~2、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R10-S5 — verifier 擴充：在既有 hash-chain 驗證（verify.go:27 `VerifyChain` sequence→linkage→entryHash→checkpoint）之上，**辨識合法 `system.restore` 事件**並偵測「鏈中出現 state-layer 跳轉（restore 語意）但無對應的、由授權 actor 簽署的 `RestoreEvent`」→ 判定 **tamper fail**（攻擊者刪中段 entries 重連 prevHash 無法冒充合法 restore）。

## (2) Goal（一句話）
讓離線 verifier 能區分「合法 restore（有授權 RestoreEvent 標記）」與「惡意截斷 / 重連」，使 forward-append restore 成為 tamper-evident（design §45）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `RestoreEvent` schema 在 verifier 端的辨識（`kind === "system.restore"`、必要欄位 `actor`/`sourceId`/`targetSnapshotId`/`targetSequence` 齊備且 `sourceId ≠ brain`）。
  - 一個 `VerifyRestoreSemantics(chain)` 校驗：掃描鏈，若偵測到 restore 語意標記（由 R10-S3 定義的事件）→ 必須是 well-formed RestoreEvent；缺欄 / brain 為 actor / 標記不齊 → `tamper fail`（fail-closed）。
  - 與既有 `VerifyChain` 組合：linkage / entryHash 仍先驗（攻擊者刪中段會先被 prevHash linkage 抓到，verify.go:34）；本 slice 補的是「合法 restore 的語意門檻」，不削弱既有檢查。
  - 若有 TS 鏡像（`src/audit/kernel/verify.ts` 既存，verify.go 第 6 行註明 byte-for-byte 對映）→ 同步擴充並有 cross-language 一致測試。
- Out-of-scope（明確不做）：
  - tamper-**proof**（kernel 私鑰被盜可偽造 RestoreEvent）→ P4 customer-held KMS 外部簽署根（design §46）；本 slice 僅 tamper-**evident**，DoD 明確標註此能力閘。
  - RestoreEvent 的產生 / append → 屬 R10-S3。
  - checkpoint 簽章 / Tessera 錨定變更 → 不動既有 checkpoint 驗證。
- **跨 plane**：Go 為權威 verifier；TS 鏡像僅為與既有 `verify.ts` 對映，經型別化契約（事件 JSON 形狀），不 deep-import。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：verifier 新增 restore 語意層；既有 chain 驗證不變（不削弱）。「無授權標記的 state 跳轉 → fail」。
- **Modules touched（唯一責任）**：
  - `kernel/internal/verify/restore.go` — 辨識並驗證 RestoreEvent 語意；無標記跳轉 → tamper fail（high cohesion：只加 restore 語意門檻，不碰 hash/linkage 計算）。
  - （若需）`src/audit/kernel/verify-restore.ts` — TS 鏡像，與 Go 語意一致。
- **PUBLIC interface（新增）**：
  - Go `func VerifyRestoreSemantics(c chain.SignedChain) VerifyResult`（沿用既有 `VerifyResult{Ok,BrokenAt,Reason}` 契約，verify.go:18）。
  - 由 caller（startup self-check / standalone verifier）在 `VerifyChain` 通過後續呼。
- **Dependency direction（inward、acyclic）**：
  ```
  verify/restore.go ──▶ internal/chain（既有，pinned hash/frame）──▶ (no new imports)
  ```
  - 維持 verify 不 import `internal/log`（verify.go:5 註明 depguard 強制「verifier 獨立於 producer」）——本 slice **不**引入對 server/store 的依賴。
  - 新依賴宣告：無新增第三方依賴；無新增跨 package 邊（沿用 internal/chain）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`kernel/internal/verify/restore_test.go`（`VerifyRestoreSemantics` 未實作 → 首次 RED：編譯失敗）。
- RED 測試清單：
  - [ ] 含 well-formed `RestoreEvent`（admin actor、非 brain source、欄位齊）的鏈 → `Ok == true`。
  - [ ] **無標記跳轉（對抗式）**：鏈中出現 restore 語意但**缺** RestoreEvent / 缺必要欄位 → `Ok == false`、`Reason` 指明 missing-restore-marker（tamper fail）。
  - [ ] **brain 不可 restore（對抗式）**：RestoreEvent `sourceId === brain` → tamper fail（attester≠actor，design §44）。
  - [ ] **不削弱既有檢查**：刪中段 entries 重連 prevHash 的鏈 → 仍由 `VerifyChain` 的 linkage 檢查先 fail（回歸測試，確認本 slice 沒給惡意截斷開後門）。
  - [ ] （若 TS 鏡像）cross-language：同一鏈 JSON 在 Go 與 TS verifier 得到相同 Ok/BrokenAt。
- 首次紅燈證據（實測，移除 restore.go 後）：
  ```
  $ env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go test ./internal/verify/ -run Restore
  internal/verify/restore_test.go:35:12: undefined: VerifyRestoreSemantics
  internal/verify/restore_test.go:51:9: undefined: VerifyRestoreSemantics
  internal/verify/restore_test.go:67:9: undefined: VerifyRestoreSemantics
  internal/verify/restore_test.go:78:12: undefined: VerifyRestoreSemantics
  FAIL	github.com/agent-os/kernel/internal/verify [build failed]
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5：`undefined: VerifyRestoreSemantics`、exit 1）
- [x] `pnpm run verify` exit 0（含 `verify:go` / `verify:py` / `verify:cross-tenant` / `secret-scan`；本 slice 未動 TS 鏡像，無新增依賴）
  ```
  $ env -u GOROOT CGO_ENABLED=0 GOTOOLCHAIN=local go test ./internal/verify/ -run Restore
  ok  	github.com/agent-os/kernel/internal/verify	0.227s
  exit code: 0   # 5/5: WellFormed, MissingMarker, BrainForbidden, NoRestore, DoesNotWeakenLinkage

  $ pnpm run verify
  ... secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary 綠：`grep -nE "internal/log|/server|/store" restore.go` 無命中（exit 1=clean）；`pnpm run deps:check` exit 0（隨 verify gate）——verify 仍**不** import `internal/log` / server / store（獨立於 producer）
- [x] low coupling / high cohesion 遵守（restore.go 只加 restore 語意門檻 `VerifyRestoreSemantics` + `restoreMarkerReason`，唯一 import = `internal/chain`，不碰 hash/linkage）
- [x] secret-scan 乾淨（`secret-scan: clean`；RestoreEvent 欄位為 id / sequence，無 secret）
- [x] Docs 更新（restore.go 頭註標 design §45/§47 語意層 + §46/§48 能力閘：本 slice = tamper-evident，tamper-proof 延 P4 customer-held KMS）
- [x] Adversarial code review = PASS（fresh-context、非作者、獨立 Opus 4.8；mutation 已驗：把 missing-restore-marker 的 fail 改成 pass → MissingMarker / BrainForbidden 轉紅；惡意截斷由 `TestVerifyRestoreDoesNotWeakenLinkage` 確認仍被既有 `VerifyChain` linkage 抓到）
- [x] **安全不變量（tamper detection）**：Independent Verifier Pass 已執行——對抗式探測無授權 state 跳轉 → fail（MissingMarker broken@1）、brain restore → fail（BrainForbidden broken@1）、fail-closed（缺欄 / 非數字 targetSequence / 非物件 event 全拒）；能力上限明確記錄為 tamper-evident-not-proof（stolen kernel key 可偽造，留 P4 KMS）

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `restore.go` + 鏡像 + caller 接線一處）。
- 可逆性：安全可逆——純新增唯讀驗證；不改既有鏈格式、不改 append 行為、無資料遷移。

## (8) Depends-on / blocks
- Depends-on：SLICE-P2R-R10-S3（驗證的 `RestoreEvent` schema / 語意由 S3 定義）。
- Blocks：（無後續 R10 slice；本批最末）。完整 tamper-proof 留 P4 KMS（design §46）。
- 確認 slice DAG 無 cycle：是（S5 → S3，rank 嚴格遞減）。
