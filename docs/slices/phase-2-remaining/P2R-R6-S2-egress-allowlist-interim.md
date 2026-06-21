# SLICE-P2R-R6-S2: egress allowlist（interim）— host deny-by-default

- **Phase**: P2（ITEM R6 inference routing gate — 第二刀；見 [`../../design/inference-routing-gate.md`](../../design/inference-routing-gate.md) §2.1 / §4.1）
- **Branch**: slice/p2r-r6-s2-egress-allowlist
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、Opus 4.8>
- **Size budget**: <= 0.5 day；net LOC <~120、files <~3（`src/inference/egress-allowlist.ts` + `src/inference/egress-allowlist.test.ts` + `src/inference/index.ts` barrel 增一行）、modules = 1、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R6-S2 — 新增 `isEgressAllowed()` 純函式做 **egress host deny-by-default（interim）**：`InferenceRequest.egressHost` 必須在明確 host allowlist 上，否則 deny。對齊 OpenShell 的 deny-by-default egress（`/tmp/openshell/docs/security/best-practices.mdx:40-51`），在真實 adapter（R1/R11）落地前作為 core 側第一道 fail-closed 防線。

## (2) Goal（一句話）
把「只有 allowlist 上的 egress host 才可被路由」變成**指令可驗的 deny-by-default + fail-closed** 判定，且抗大小寫/子網域/前後綴繞過。

## (3) In-scope / Out-of-scope
- In-scope:
  - `EgressAllowlist` 型別（`readonly string[]`，host 精確比對，case-insensitive normalize）。
  - `isEgressAllowed(req: InferenceRequest, allowlist): { allowed: true } | { allowed: false; reason: string }`：未知 host→deny、空 host→deny、空 allowlist→全 deny、子網域非精確命中→deny（不做萬用 suffix match，避免 `evil-example.com` 繞過 `example.com`）。
- Out-of-scope（明確不做）:
  - 從 `ResolvedRoute.base_url` 解析 host 的規則 → inferred、留給 R1（live substrate）。
  - port / protocol / calling-binary 維度（OpenShell network_policies 的真實 enforcement）→ 留給 R11。
  - PDP / CostGate 組合 → 留給 S3 / S4。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 在 `src/inference/` 加第二關純函式；不改 S1 的 types/model-allowlist。
- **Modules touched（唯一責任）**:
  - `src/inference/egress-allowlist.ts` — egress host deny-by-default 判定（純函式）。
  - `src/inference/index.ts` — barrel 增 re-export 一行。
- **PUBLIC interface（新增）**:
  - `type EgressAllowlist = readonly string[]`。
  - `function isEgressAllowed(req: InferenceRequest, allowlist: EgressAllowlist): { allowed: true } | { allowed: false; reason: string }`。
- **Dependency direction（inward、acyclic）**:
  ```
  inference/index.ts ──▶ egress-allowlist.ts ──▶ types.ts（intra-module）
  ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是。
  - 新依賴宣告: 無（純 intra-module；無新跨 module / 第三方依賴）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/inference/egress-allowlist.test.ts`（`egress-allowlist.js` 不存在 → RED：import 失敗）。
- RED 測試清單:
  - [ ] allowlist 命中：`egressHost="api.allowed.example"` ∈ allowlist → `allowed: true`。
  - [ ] **deny-by-default**：未知 host → `allowed: false`。
  - [ ] **deny-by-default**：空 host（`""` 或僅空白）→ `allowed: false`。
  - [ ] **deny-by-default**：空 allowlist → 任何 host 皆 deny。
  - [ ] **繞過防護（fail-closed）**：`evil-api.allowed.example` / `api.allowed.example.evil.com` 不得因部分相符而命中精確 entry `api.allowed.example`。
  - [ ] **case-insensitive**：`API.Allowed.Example` 命中 `api.allowed.example`（normalize 後精確比對）。
  - [ ] reason 不洩值：deny reason 靜態 / 含 host（非 secret）但不回顯整個請求。
- 首次紅燈證據（待實作時貼 exit≠0）:
  ```
  $ pnpm test src/inference/egress-allowlist.test.ts
  ... FAIL（Cannot find module './egress-allowlist.js'）...
  exit code: <填入>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <填入>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；無 vendor、無 cycle、無 deep import）
- [ ] low coupling / high cohesion 遵守（只 intra-module `./types.js`；無新跨 module 依賴）
- [ ] secret-scan 乾淨（source/test/fixture 無 secret-like 值；host fixture 用 `*.example` 保留域）
- [ ] Docs 更新（連結回 design §2.1/§4.1）
- [ ] Adversarial code review = PASS（fresh-context；deny-by-default + 子網域/前後綴繞過 + case 繞過皆對抗探測）— 連結/摘要: <填入>
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（egress deny-by-default、繞過防護、空輸入 fail-closed 皆被抓）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `egress-allowlist.ts` + barrel 一行）。
- 可逆性: 安全可逆（純新增、無外部副作用）。

## (8) Depends-on / blocks
- Depends-on: SLICE-P2R-R6-S1（`InferenceRequest` 型別）。
- Blocks: SLICE-P2R-R6-S4（組合）。
- 確認 slice DAG 無 cycle: ☐ 是。
</content>
