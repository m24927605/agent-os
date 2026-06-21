# SLICE-P2R-R3-S3: PDP `tool:invoke` 規則 — 未註冊→deny（deny-only 前置，相容 dedup #1）

- **Phase**: P2（R3 第三刀；P2 — tool registry → PDP）
- **Branch**: slice/p2r-r3-s3-pdp-tool-invoke
- **Author**: agency-agents writer    **Adversarial reviewer**: <fresh-context Opus 4.8、非作者>
- **Size budget**: <= 0.5 day；net LOC <~160、files <~3（`src/tools/authorize.ts` + `src/tools/authorize.test.ts` + `src/index.ts` barrel 一行）、modules = 1（`tools`；只「消費」既有 policy 公共面，不改 policy module）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R3-S3 — 新增 **`authorizeToolInvoke(req, registry, rules)`**：當 `req.action === "tool:invoke"` 且 `registry.has(req.resource)`（tool name）為 false → **直接 deny**（`reason: "tool:invoke for unregistered tool (deny-by-default)"`、`auditRequired: true`）；tool 已註冊 → 交既有 `evaluatePolicy` 評估（PDP 仍是唯一 deny 權威）。這是一個 **deny-only 前置篩**，永遠只能 deny 更多、不能 grant。

## (2) Goal（一句話）
讓「對未在 ToolRegistry 註冊的工具發起 `tool:invoke`」成為**結構性拒絕**（而非落到泛用 no-allow 兜底），且其判定相容於 dedup.ts 的 PDP-唯一-deny-權威律。

## (3) In-scope / Out-of-scope
- In-scope:
  - `authorizeToolInvoke(req: unknown, registry: ToolRegistry, rules)`：先 fail-closed parse `req`（malformed → deny，比照 evaluate.ts:116-120）；若 `action === "tool:invoke"` 且 tool 未註冊 → deny；否則 `return evaluatePolicy(req, rules)`。
  - tool name 來源約定：對 `action === "tool:invoke"` 的 request，`req.resource`（既有 `PolicyRequest.resource`，types.ts:16）**即 tool name**，用以對 registry 的 key（manifest `name`，S1 欄位 #1）做 `has()` 比對。**不**使用 manifest 的 `resourcePattern`（欄位 #5）——後者在 R3 僅儲存、未接 PDP（見 design §2.1 欄位消費範圍）。
  - 一個 contract 證明：unregistered→deny、registered+allow rule→allow、registered+matching deny rule→deny（deny precedence 仍由 evaluatePolicy 保證）。
- Out-of-scope（明確不做）:
  - 改 `src/policy/evaluate.ts` / `dedup.ts`（**不動**；只「消費」其 public surface）。
  - 把 `sideEffect`/`requiresApproval` 變成 PDP 條件（例如 destructive 自動要 approval gate）→ 留給後續（R7 approval / commitgate 串接）。
  - 接進 `runGovernedToolCall` 的 `authorize` 注入點 → 可於 R7/組合層做；本 slice 只交付 predicate + contract。
  - 多租 scope 已由 evaluatePolicy 既有 tenant-scope 處理，不重做。
- **設計不變量（必須在 review 守住）**: 本 predicate **deny-only**——unregistered 路徑只回 deny；registered 路徑**完全委派** evaluatePolicy，不自行 grant。這保證不製造「第二個 grant 權威」，與 dedup.ts:43-82 相容。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 在既有 PDP 之上加一層 tool-aware 前置。`evaluatePolicy` 對 unknown tool 本來就會 deny（no matching allow，evaluate.ts:173），但 reason 是泛用的；本 slice 讓 reason 明確指出 unregistered，並把「存在性」變成 registry-backed 的結構判定（為後續以 manifest 副作用語意做更細治理鋪路）。
- **Modules touched（唯一責任）**:
  - `src/tools/authorize.ts` — 唯一責任：把 ToolRegistry 的存在性判定接到 PDP 的 `tool:invoke` action 前，產生一個 deny-only 前置決策；其餘委派 `evaluatePolicy`。
- **PUBLIC interface（新增）**:
  - `export function authorizeToolInvoke(req: unknown, registry: ToolRegistry, rules: PolicyRuleSet | readonly AllowRule[]): PolicyDecision;`
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    src/tools/authorize.ts ──▶ src/policy/* (evaluatePolicy, PolicyDecision/PolicyRequest/PolicyRuleSet — barrel public surface)
                          └──▶ src/tools/registry.ts（同 module S2）
    src/index.ts (barrel)  ──▶ src/tools/authorize.ts
    ```
  - 僅經 public surface 消費（無 deep import）: 是（policy 經 `src/index.ts` barrel / `src/policy/*.js` public export，不 deep import policy 內部私有檔；registry 用 S2 public API）。
  - 新依賴宣告:
    - tools→policy（消費 evaluatePolicy/types）— 方向=向內（adapters/application → domain policy）、cycle=無（policy 不 import tools）、理由=tool authorize 必須委派 PDP 以維持 PDP 唯一 deny 權威。
    - tools 內部 authorize→registry(S2) — 方向=向內、cycle=無、理由=存在性判定。
  - no-vendor-in-core: 綠。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/tools/authorize.test.ts`
- RED 測試清單（含安全對抗式）:
  - [ ] **headline / deny-by-default**：`action:"tool:invoke"`、`resource:"unknown-tool"`（registry 無）→ `deny`，reason 含 "unregistered"，`auditRequired:true`。
  - [ ] registered tool + 對應 allow rule → `allow`（委派 evaluatePolicy）。
  - [ ] registered tool + 對應 **deny rule** → `deny`（deny precedence 仍生效；證明未繞過 PDP）。
  - [ ] **fail-closed**：malformed `req`（缺欄/型別錯/null）→ `deny`（不 crash、不誤 allow）。
  - [ ] **deny-only 不變量（對抗式）**：unregistered 路徑在任何 rules（含一條會 match 的 allow rule）下仍 `deny`——證明前置篩不能被 allow rule 翻成 allow。
  - [ ] 非 `tool:invoke` 的 action（如 `file:read`）→ 完全委派 evaluatePolicy（registry 不影響）。
  - [ ] **相容 dedup #1**：`combineDecisions(authorizeToolInvoke(...deny...), [secondaryAllow])` → `deny`（secondary-allow 不翻 PDP-deny；複用 dedup.ts）。
- 首次紅燈證據（貼 exit≠0；實作前填）:
  ```
  $ pnpm test src/tools/authorize.test.ts
  ... FAIL（import ../tools/authorize.js 失敗：模組不存在）...
  exit code: <填>
  ```

## (6) Definition of Done（每條附指令證據；實作時填）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <0>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；確認 authorize.ts 只經 policy public surface + S2，無 deep import、無 vendor，方向向內無 cycle）
- [ ] low coupling / high cohesion 遵守（**未改** evaluate.ts/dedup.ts；只消費其 public surface）
- [ ] secret-scan 乾淨
- [ ] Docs 更新（design §2.3「不破壞 dedup #1」與本 slice 一致）
- [ ] Adversarial code review = PASS（fresh-context；mutation：unregistered 改回 allow → headline+deny-only 轉紅；registered 路徑改成自行 allow 而非委派 → deny-rule 測試轉紅）— 摘要: <填>
- [ ]（安全不變量類）**Independent Verifier Pass** 已執行並 clean：adversarially probed deny-by-default（unregistered→deny）、fail-closed（malformed→deny）、PDP 唯一 deny 權威不被前置篩稀釋（deny-only）、與 dedup any-deny-wins 相容、audit `auditRequired:true` 永真。

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 authorize.ts + 測試 + barrel 一行）。
- 可逆性: 安全可逆——純新增 predicate，未改 PDP；無外部副作用、無資料遷移、無 audit append（本 slice 只產生決策，append 由下游 commitgate 做）。

## (8) Depends-on / blocks
- Depends-on: **P2R-R3-S2**（registry `has`/`lookup`）；**P2-E**（既有 PDP `evaluatePolicy` + dedup `combineDecisions`，已 merge）。
- Blocks: 後續把 manifest 副作用語意接進 commitgate/approval（R7 / 後續）；R9 developer-sdk 的 ToolManifest authoring 端到端示範。
- 確認 slice DAG 無 cycle: 是（S3 rank=3，依賴 S2 rank=2 + 已 merge 的 P2-E；policy 不反向 import tools）。
