# SLICE-P2R-R6-S1: per-model deny-by-default gate（+ vendor-neutral InferenceRequest schema）

- **Phase**: P2（ITEM R6 inference routing gate — 第一刀；見 [`../../design/inference-routing-gate.md`](../../design/inference-routing-gate.md) §7）
- **Branch**: slice/p2r-r6-s1-per-model-deny-by-default
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~180、files <~5（`src/inference/{types.ts,model-allowlist.ts,index.ts}` + `src/inference/model-allowlist.test.ts` + `src/index.ts` barrel）、modules = 1、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
SLICE-P2R-R6-S1 — 新增 vendor-neutral `InferenceRequest` Zod schema（**無**任何 credential/api_key 欄位）+ `isModelAllowed()` 純函式，做 **per-model deny-by-default**：請求的 `(model, providerType)` 必須在明確 allowlist 上，否則 deny。

## (2) Goal（一句話）
把「只有 allowlist 上的 `(model, providerType)` 才可被路由」變成**指令可驗的 deny-by-default + fail-closed** 判定。

## (3) In-scope / Out-of-scope
- In-scope:
  - `InferenceRequest` Zod schema：`{ model, providerType, egressHost, estimatedTokens?, ...AgentContext ids }`，**strict**（多餘欄位拒絕）、**無** api_key/secret 欄位。
  - `ModelAllowlist` 型別（`readonly { model: string; providerType: string }[]`）。
  - `isModelAllowed(req: unknown, allowlist): { allowed: true } | { allowed: false; reason: string }`：malformed→deny、未知 model→deny、model 在 allowlist 但 providerType 不符→deny、空 allowlist→全 deny。
- Out-of-scope（明確不做）:
  - egress host 判定 → 留給 SLICE-P2R-R6-S2。
  - PDP 整合 → 留給 SLICE-P2R-R6-S3。
  - CostGate reserve + 組合 → 留給 SLICE-P2R-R6-S4。
  - OpenShell `GetInferenceBundle` client → 留給 R1（live substrate）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 新增 `src/inference/` 模組的種子（types + 第一關 model allowlist）。純函式，無 I/O。
- **Modules touched（唯一責任）**:
  - `src/inference/types.ts` — 定義 vendor-neutral 推論請求/決策契約（credential-blind by construction）。
  - `src/inference/model-allowlist.ts` — per-model deny-by-default 判定（純函式）。
  - `src/inference/index.ts` — 模組 barrel。
  - `src/index.ts` — 新增一行 re-export。
- **PUBLIC interface（新增）**:
  - `InferenceRequest`（Zod schema，`.strict()`）+ `type InferenceRequest`。
  - `type ModelAllowlist = readonly { readonly model: string; readonly providerType: string }[]`。
  - `function isModelAllowed(req: unknown, allowlist: ModelAllowlist): { allowed: true; request: InferenceRequest } | { allowed: false; reason: string }`。
- **Dependency direction（inward、acyclic）**:
  ```
  index.ts(barrel) ──▶ inference/index.ts ──▶ {types.ts, model-allowlist.ts}
  types.ts ──▶ iam/ids.js（allowlisted 身分基元）
  model-allowlist.ts ──▶ types.ts（intra-module）
  ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是（只 import `../iam/ids.js` barrel + 同模組 `./types.js`）。
  - 新依賴宣告: `inference → iam/ids`：方向=inward（domain 基元）、cycle=無、理由=沿用既有 AgentContext 身分契約（與 `policy/types.ts:8`、`cost/port.ts:13` 同）。`inference` 須加入 no-vendor-in-core 的 core from-list（dependency-cruiser 設定單行）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/inference/model-allowlist.test.ts`（`src/inference/*` 不存在 → RED：import 失敗）。
- RED 測試清單:
  - [ ] allowlist 命中：`(model="m1", providerType="p1")` ∈ allowlist → `allowed: true`，回傳 parsed request。
  - [ ] **deny-by-default**：未知 model → `allowed: false`。
  - [ ] **deny-by-default**：model 在 allowlist 但 providerType 不符 → `allowed: false`。
  - [ ] **deny-by-default**：空 allowlist → 任何 model 皆 deny。
  - [ ] **fail-closed**：malformed `InferenceRequest`（缺 model / 非字串 / 多餘欄位）→ `allowed: false`，永不 throw、永不 allow。
  - [ ] **credential-blind 結構斷言**：`types.ts` source（strip 註解）不含 `apiKey`/`api_key`/`secret`/`token`(bearing) 欄位名。
  - [ ] reason 不洩值：deny reason 為靜態文字 / 關卡名（不回顯整個請求物件）。
- 首次紅燈證據（impl 前，import 失敗 → RED）:
  ```
  $ node_modules/.bin/vitest run src/inference/model-allowlist.test.ts
  FAIL  src/inference/model-allowlist.test.ts [ ... ]
  Error: Failed to load url ./model-allowlist.js (Cannot find module '.../src/inference/model-allowlist.ts')
  exit code: 1
  ```
  - GREEN（impl 後，本次整合驗證）:
  ```
  $ node_modules/.bin/vitest run src/inference/model-allowlist.test.ts
  ✓ src/inference/model-allowlist.test.ts (14 tests)
  Test Files  1 passed (1) | Tests  14 passed (14)
  exit code: 0
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5：impl 前 import 失敗 exit 1 → impl 後 14 passed exit 0）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... verify:go: ok / verify:py: skip / secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`inference` 已加入 core from-list、無 vendor、無 cycle、無 deep import）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (72 modules, 154 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（`inference` 只 import `iam/ids` + 同模組；無跨 module / cyclic 依賴 — depcruise 0 violations）
- [x] secret-scan 乾淨（source/test/fixture 無 secret-like 值；schema 無 credential 欄位）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] Docs 更新（本 slice 連結回 design §7；INDEX.md R6 標進度 = S1 DONE）
- [x] Adversarial code review = PASS（fresh-context、非作者、Opus 4.8；deny-by-default / fail-closed / credential-blind 三維對抗探測）— 摘要: independent review 通過，無 defect 留待修正。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（per-model deny-by-default、malformed fail-closed、credential-blind schema mutation 皆被抓）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `src/inference/` + barrel 一行 + dependency-cruiser from-list 一行）。
- 可逆性: 安全可逆（純新增、無外部副作用、無 audit append、無資料遷移）。

## (8) Depends-on / blocks
- Depends-on: P2-E（PDP / policy types 既有）；既有 `iam/ids`（AgentContext）。
- Blocks: SLICE-P2R-R6-S2、SLICE-P2R-R6-S3、SLICE-P2R-R6-S4。
- 確認 slice DAG 無 cycle: ☐ 是。
</content>
