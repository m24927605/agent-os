# SLICE-P2-E: PDP 唯一 deny 權威 — secondary policy 去重（PDP-deny 勝 secondary-allow）

- **Phase**: P2（five-piece STEP 6 — dedup #1；BLOCKING #2「兩個 deny 權威」）
- **Branch**: slice/p2-e-pdp-sole-deny-authority
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 0.5 day；net LOC <~200、files <~4（`src/policy/dedup.ts` + `src/policy/dedup.test.ts` + `src/test-contracts/secondary-policy-adapter.test.ts` + `src/index.ts` barrel）、新增依賴 = 0
- **狀態**: DRAFT（實作後以真實 exit code 覆蓋 §5/§6 並標 DONE）

## (1) ID + Title
SLICE-P2-E — 新增 `SecondaryPolicyAdapter`（vendor-neutral、advisory policy 輸入的可插拔槽位；預設來源 AGT-derived，P2 後續）+ `combineDecisions()` 去重函式，使我們的 PDP（`src/policy/evaluate.ts`）成為**唯一 deny 權威**：secondary 的 allow **永遠不能**翻轉 PDP 的 deny；任何 deny（PDP 或 secondary）即 deny（**any-deny-wins，fail-closed**）；secondary 拋例外 → 視為 deny（deny-by-default）。

## (2) Goal（一句話）
鎖死整合架構的「dedup #1」：AGT/OpenShell policy 只是 **advisory input**，**不是**第二個平行 deny gate——合併後的單一 decision 由 PDP 主導、any-deny-wins，secondary 的意見只進 audit reason，effect 在 deny 時絕不執行。

## (3) In-scope / Out-of-scope
- In-scope：`SecondaryPolicyAdapter` 介面（`evaluate(req: PolicyRequest): PolicyDecision`）；`evaluateSecondaries(adapters, req): PolicyDecision[]`（每個 adapter 包 try/catch，throw → 合成 deny decision，fail-closed）；`combineDecisions(primary: PolicyDecision, secondary: readonly PolicyDecision[]): PolicyDecision`（PDP 唯一權威、any-deny-wins、reason annotates secondary 輸入、`auditRequired` 永真）；≥2 個 fake secondary（`AllowAllSecondaryPolicy`、`DenyAllSecondaryPolicy`）滿足可插拔；contract test。
- Out-of-scope：真實 **AGT-derived** secondary adapter（落 `src/policy/adapters/agt/`，P2 後續，carved out by `/adapters/`）；把 combine 接進真正的 effect gate（commitgate 串接屬 orchestration/後續）；OpenShell OPA/Z3 作為 secondary（同屬後續 adapter）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：PDP 仍是 `evaluatePolicy`（不動）。新增**合併層**：把 PDP decision 與 0..N 個 secondary advisory decision 收斂成**單一** PolicyDecision，規則：
  - 任一方 `deny` → 結果 `deny`（deny-precedence / any-deny-wins）。
  - 結果 `allow` **僅當** PDP `allow` **且**所有 secondary `allow`。
  - secondary 的 `allow` 不能覆蓋 PDP 的 `deny`（PDP 唯一權威）。
  - `reason` 記錄決定來源 + 各 secondary 的意見（audit 可見「AGT 說 allow，但 PDP deny」）。`matchedRule` 取自 deny 來源。`auditRequired = true`。
  - secondary adapter 執行拋例外 → `evaluateSecondaries` 產生一筆合成 `deny`（reason 標 detector/adapter 錯誤）→ 仍 any-deny-wins（fail-closed）。
- **PUBLIC interface（src/policy/dedup.ts）**：`interface SecondaryPolicyAdapter { evaluate(req: PolicyRequest): PolicyDecision }`；`combineDecisions(primary, secondary[]): PolicyDecision`；`evaluateSecondaries(adapters, req): PolicyDecision[]`；fakes `AllowAllSecondaryPolicy`/`DenyAllSecondaryPolicy`。
- **依賴方向**：`dedup.ts` 只 import `./types.js`（同模組 policy；intra-module）。不 import evaluate.ts、不 import 任何 vendor（no-vendor-in-core 綠）。AGT 真實 adapter 將落 `src/policy/adapters/agt/`（pathNot 排除）。

## (5) Test-first plan（RED 先行）
`src/policy/dedup.test.ts`（dedup.js 不存在 → RED：import 失敗）：
- **headline**：`combineDecisions(PDP=deny, [secondary=allow])` → `deny`；reason 含 PDP 與 secondary 意見；secondary allow 未翻轉。
- truth table：`(allow,[deny])→deny`、`(allow,[allow])→allow`、`(deny,[deny])→deny`、`(allow,[allow,deny])→deny`。
- fail-closed：`evaluateSecondaries([throwingAdapter], req)` → 一筆 deny；經 combine → deny。
- `auditRequired` 永真。
`src/test-contracts/secondary-policy-adapter.test.ts`：factory over [AllowAll, DenyAll]，斷言每個 impl 回 schema-valid PolicyDecision（effect ∈ {allow,deny}、reason 非空、auditRequired），證可插拔（≥2 impl）。
> 預期首次 RED：import `../policy/dedup.js` / `./dedup.js` 失敗。

## (6) Definition of Done（待填）
- [ ] first RED exit code 已貼。
- [ ] `pnpm run verify` exit 0。
- [ ] `deps:check` 綠（dedup.ts 只 import policy types、無 vendor token、no-vendor-in-core 綠）。
- [ ] secret-scan clean。
- [ ] Adversarial review = PASS（含 mutation：讓 secondary-allow 能翻 PDP-deny / 移除 any-deny-wins / secondary-throw 不 fail-closed → 測試紅）。

## (7) Rollback
revert commit（移除 dedup 模組 + barrel 一行）。

## (8) Depends-on / blocks
- Depends-on：既有 PDP（`src/policy/{types,evaluate}.ts`）。
- Blocks：真實 AGT-derived secondary adapter；orchestration 把 combined decision 接進 commitgate 的 effect gate。
