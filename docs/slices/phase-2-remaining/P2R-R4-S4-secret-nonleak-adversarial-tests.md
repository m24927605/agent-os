# SLICE-P2R-R4-S4: secret 不外洩 adversarial 測試 + secret-scan/redact 整合（test-only）

- **Phase**: P2（ITEM R4 — CredentialLease lifecycle，第 4 刀）
- **Branch**: slice/p2r-r4-s4-secret-nonleak-adversarial-tests
- **Author**: Security Engineer    **Adversarial reviewer**: <須為 fresh-context Opus 4.8、非作者>
- **Size budget**: 估計 <= 1 day；net LOC <~90、files <~2（`src/credential/nonleak.test.ts` + 可能微調 barrel re-export，**無新增 src 行為碼**）、modules = 1（test-only）、新增依賴 = 0
- **狀態**: **DRAFT**（RED plan + DoD 為 placeholder，待實作填真實 exit code）

## (1) ID + Title
SLICE-P2R-R4-S4 — 新增**對抗式不外洩測試**，把「raw secret 從不進入 lease、FSM event、injection env 任一表面」與「secret-scan + redactSecrets 對 credential 全鏈乾淨」釘成 `pnpm run verify` 可驗的不變量。

## (2) Goal（一句話）
以 fresh-context 角度對抗式地證明 R4 全鏈（schema → FSM → seam）在任何輸入下都**永不外洩 literal secret**，並讓此保證由指令（test + secret-scan）背書。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/credential/nonleak.test.ts`：跨 S1/S2/S3 的 end-to-end 不外洩斷言：
    - 餵入 runtime 組裝的 secret canary（多種 shape：`sk-…`、`ghp_…`、JWT-shape、`AKIA…`，對齊 `audit/redact.ts:19-20` 的 `SECRET_VALUE`），確認**每一處** lease / `LeaseEvent` / provider-env value 都被 `.strict()` parse-fail 拒絕、或經 `redactSecrets` 後與原值相等（證明本無 secret 可被 redact）。
    - 對任一 lease 物件呼叫 `JSON.stringify` 與（若有）自訂字串化，斷言輸出**只含 bundleRef + placeholder + state**，無 secret（呼應 OpenShell `SecretResolver` 手寫 `Debug` 不印值，`secrets.rs:104-110`）。
  - 確認所有 canary 為 **runtime 組裝**（如 `"sk-" + "x".repeat(20)`），使 `scripts/scan_secrets.sh` 不誤報。
- Out-of-scope（明確不做）:
  - 新增 src 行為碼（本刀僅測試；若測試逼出缺陷，缺陷修正回對應 S1/S2/S3 slice，不在此刀塞功能）。
  - entropy/窮舉式 secret 偵測（覆蓋 = `redactSecrets` 高訊號 pattern，已於 design §4.3 記）。
  - WORM kernel append 的不外洩（屬 R2 ingest client 的 redact pass）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 無 public interface 變更；新增一支跨層對抗式測試，將 design §4.3 的 Credential Non-Leak 不變量轉為可驗。若需要，barrel 可 re-export 既有型別供測試 import（不新增行為）。
- **Modules touched（唯一責任）**:
  - `src/credential/nonleak.test.ts` — 唯一責任：對抗式驗證 R4 全鏈無 literal secret 外洩。
- **PUBLIC interface（新增/變更）**: 無（test-only）。
- **Dependency direction（low coupling；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    credential/nonleak.test.ts ──▶ credential (barrel) ──▶ iam/ids ──▶ zod
                               └──▶ audit/redact (redactSecrets, 測試注入)
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是（只 import `../credential/index.js` barrel + `../audit/redact.js`）。
  - 新依賴宣告: 無（測試對既有 module 的 barrel 消費）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/credential/nonleak.test.ts`
- RED 測試清單（每條對應一個不變量）:
  - [ ] **schema 表面**：對每種 secret-shape canary，嘗試塞入 lease 的各欄位 → `parseCredentialLease` throw（`.strict()` + 約束）。
  - [ ] **FSM event 表面**：跑 `mint→inject→use` 與各 deny 路徑，對每個 `LeaseEvent` 斷言 `redactSecrets(event)` deep-equal 原 event（event 本無 secret）。
  - [ ] **seam 表面**：`toProviderEnv` 輸出的每個 value 是 placeholder（match `^openshell:resolve:env:`），且 `redactSecrets(env)` deep-equal 原 env。
  - [ ] **字串化表面**：`JSON.stringify(lease)` 不含任一 canary 子字串。
  - [ ] **fail-closed 全鏈**：對 revoked/expired lease 走 seam → denied，且過程無 secret 浮現；另測「injected 但 `expiresAtMs <= now`（尚未 expire()）」走 seam（注入固定 `now`）→ denied（堵過期視窗），全程無 secret 浮現。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/credential/nonleak.test.ts
  ... FAIL (依賴 S1/S2/S3 尚未全綠 或 測試先於斷言成立而紅) ...
  exit code: 1        # PLACEHOLDER：實作前親眼見紅後覆蓋
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: 0    # PLACEHOLDER
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0）
- [ ] low coupling / high cohesion 遵守（test-only；僅經 barrel + audit/redact 消費；無 deep import、無 vendor token）
- [ ] secret-scan 乾淨（`pnpm run secret-scan` exit 0；所有 canary runtime 組裝、無 source 字面值）
- [ ] Docs 更新（design/credential-lease.md §4.3 不變量已由本測試背書）
- [ ] Adversarial code review = PASS（fresh-context；reviewer 自行新增一條「故意讓 lease 攜帶 secret」的破壞性 mutation，確認測試會抓到並轉紅 → 證明非 test theater；findings 已解）— 摘要: <…>
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（Credential Non-Leak 全鏈對抗式探測）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除測試檔；S1/S2/S3 行為不受影響）。
- 可逆性: 安全可逆（test-only、無外部副作用、無 audit append）。

## (8) Depends-on / blocks
- Depends-on: **SLICE-P2R-R4-S3**（須有完整 schema+FSM+seam 三層可供 end-to-end 對抗式探測）。
- Blocks: 無（R4 收尾刀）；為下游 R1/R11 對 credential 的整合提供不外洩回歸基線。
- 確認 slice DAG 無 cycle: ☑ 是（rank 4）。
