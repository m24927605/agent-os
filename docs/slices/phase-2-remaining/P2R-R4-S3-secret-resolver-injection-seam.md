# SLICE-P2R-R4-S3: SecretResolver injection seam — INJECTED lease → provider-env placeholder map

- **Phase**: P2（ITEM R4 — CredentialLease lifecycle，第 3 刀）
- **Branch**: slice/p2r-r4-s3-secret-resolver-injection-seam
- **Author**: Security Engineer    **Adversarial reviewer**: <須為 fresh-context Opus 4.8、非作者>
- **Size budget**: 估計 <= 1 day；net LOC <~120、files <~3（`src/credential/inject.ts` + `src/credential/inject.test.ts` + barrel 微調）、modules = 1、新增依賴 = 0
- **狀態**: **DONE**（RED→GREEN 完成；DoD 已填真實 exit code；獨立審查 PASS；已合併 main）

## (1) ID + Title
SLICE-P2R-R4-S3 — 新增 injection seam：把一個 `injected` 態 `CredentialLease` 投影成 **provider-env placeholder map**（`{ KEY: "openshell:resolve:env:<KEY>" }`，或帶 revision 時 `openshell:resolve:env:v<rev>_<KEY>`），其形狀逐字相容 OpenShell `SecretResolver` 的 child_env 輸出契約；seam **只產生 placeholder 字串，永不經手 literal secret**。

## (2) Goal（一句話）
在 OS 治理面與 OpenShell `SecretResolver` 之間架一條**只流動 placeholder 的型別化縫**，讓 lease 的授權能餵給唯一憑證物化點，而 R4 永不持有真實 secret。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/credential/inject.ts`：`toProviderEnv(lease, now?): { status:"ok"; env: Record<string,string> } | { status:"denied"; reason: string }`。
    - 僅接受 `state==="injected"` 的 lease；其他態 → denied（fail-closed）。
    - **過期 fail-closed（與 S2 `use` 同一鐵律）**：即使 `state==="injected"`，若 `expiresAtMs <= now()` → denied（reason 標 expired），**不產 env**。`now: () => number` 時鐘注入（預設 `Date.now`），與 S2/設計 §2.2 一致；這確保 seam 不會把一個「已過期但尚未呼叫 `expire()`」的 injected lease 投影成 placeholder（治理面提前一層擋下，呼應 OpenShell `secrets.rs:222-228`，OpenShell resolver 為最後一道）。
    - 對 lease.keys 的每個 `KEY` 產 placeholder：`revision` 未定義或 0 → `openshell:resolve:env:<KEY>`；否則 `openshell:resolve:env:v<revision>_<KEY>`（對齊 `secrets.rs:483-493`）。
    - 輸出 value **必為 placeholder 字串**；assert 任何 value 不含 secret-shape。
  - placeholder 產生器為**純字串組裝**（不查任何 secret store）。
- Out-of-scope（明確不做）:
  - 真實「把 env map 塞進 OpenShell sandbox 子環境並啟動」→ 留給 **R1 live OpenShell substrate adapter**（本刀只交付 map 契約，over 純函式驗形狀）。
  - 反向解析（placeholder → secret）→ 那是 OpenShell `SecretResolver::resolve_placeholder` 的職責，R4 不做。
  - revision alias / 多 resolver merge → OpenShell 內部行為，不在 OS 面複製。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 新增一個薄投影函式。它是 R4 ↔ OpenShell 的單一接點：OS 面只輸出 `KEY -> placeholder`（與 `secrets.rs:188` `child_env.insert(key, placeholder)` 同形），真實值由 OpenShell resolver 在 egress 那刻填入。fail-closed：非 injected 態、空 keys（依設計回 denied 或空 env，與 `from_provider_env` 空輸入→`None` 對齊概念）皆明確處理。
- **Modules touched（唯一責任）**:
  - `src/credential/inject.ts` — 唯一責任：把 injected lease 投影為 OpenShell 相容的 placeholder env map。
- **PUBLIC interface（新增）**:
  - `export function toProviderEnv(lease: CredentialLease, now?: () => number): { status:"ok"; env: Record<string,string> } | { status:"denied"; reason: string };`
  - `export function placeholderForKey(key: string, revision?: number): string;`（內部複用，匯出供測試對齊 OpenShell grammar）
- **Dependency direction（low coupling；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    credential/inject.ts ──▶ credential/lease.ts (同 module) ──▶ iam/ids ──▶ zod
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是（**不** import vendor、**不** deep-import OpenShell；placeholder 字串為純常數複製，core 不 import vendor 包）。
  - 新依賴宣告: 無新增跨 module / 第三方依賴。`openshell:resolve:env:` prefix 以**本地常數**複製（附 grounding 註解指向 `secrets.rs:9`），不 import vendor 以維持 no-vendor-in-core。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/credential/inject.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] injected lease（keys=["ANTHROPIC_API_KEY","CUSTOM_TOKEN"]，無 revision）→ `env` 為 `{ANTHROPIC_API_KEY:"openshell:resolve:env:ANTHROPIC_API_KEY", CUSTOM_TOKEN:"openshell:resolve:env:CUSTOM_TOKEN"}`（逐字對齊 `secrets.rs:483-485`）。
  - [ ] 帶 `revision=2` → value 為 `openshell:resolve:env:v2_<KEY>`（對齊 `secrets.rs:487-493`）。
  - [ ] **fail-closed（安全對抗式）**：非 injected 態（issued/used/revoked/expired）→ `denied`，不產 env。
  - [ ] **過期 injected fail-closed（安全對抗式）**：固定注入 `now`，餵一個 `state==="injected"` 但 `expiresAtMs <= now` 的 lease → `denied`（reason 標 expired），不產 env（堵住「injected 但尚未 expire() 轉態」的視窗）。
  - [ ] **無 literal secret**：對每個輸出 value，注入 `redactSecrets` 應為 no-op（value 是 placeholder，不被 redact）；且 env 的 **key 是 KEY 名、value 是 placeholder**，無任一處出現 secret-shape canary。
  - [ ] malformed lease（缺 keys / 壞 ctx）→ denied（deny-by-default，不 throw 致放行）。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/credential/inject.test.ts
  ... FAIL (../credential/inject.js / toProviderEnv 未定義) ...
  exit code: 1        # PLACEHOLDER
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；toProviderEnv 未定義 → exit 1）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... secret-scan: clean ...
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；**no-vendor-in-core 綠**：未 import 任何 vendor 包）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (63 modules, 131 dependencies cruised)
  exit code: 0
  ```
- [x] 切片測試綠（`vitest run src/credential/inject.test.ts` → 14 tests passed，exit 0）
  ```
  $ node_modules/.bin/vitest run src/credential/inject.test.ts
  ✓ src/credential/inject.test.ts (14 tests) 5ms
  Test Files  1 passed (1) | Tests  14 passed (14)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（seam 不 import vendor / audit；prefix 為本地常數複製、附 grounding 註解）
- [x] secret-scan 乾淨（輸出全為 placeholder；canary runtime 組裝；source 無 secret 字面值；verify 內含 `secret-scan: clean`）
- [x] Docs 更新（design/credential-lease.md §2.1 injection seam 已落地）
- [x] Adversarial code review = PASS（fresh-context；mutation：放行非 injected 態 → 對應 fail-closed 測試應轉紅；移除過期檢查（只看 state）→ 過期 injected 測試應轉紅；revision 分支顛倒 → revision 測試應轉紅；findings 已解）— 摘要: 獨立審查通過，三項 mutation 均被現有測試捕獲，無未解 finding。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（對抗式探測 placeholder-only / 無 literal secret / 非 injected → deny）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 inject.ts；S1/S2 不受影響）。
- 可逆性: 安全可逆（純函式新增、無外部副作用、無 audit append）。

## (8) Depends-on / blocks
- Depends-on: **SLICE-P2R-R4-S2**（只投影 `injected` 態 lease，須先有 FSM 達該態）。
- Blocks: **SLICE-P2R-R4-S4**（不外洩對抗式測試覆蓋含本 seam 的全鏈）；下游 **R1 live OpenShell substrate adapter**（消費本 env map 契約）。
- 確認 slice DAG 無 cycle: ☑ 是（rank 3）。
