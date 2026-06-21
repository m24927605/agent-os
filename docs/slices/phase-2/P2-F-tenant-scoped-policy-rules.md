# SLICE-P2-F: tenant-scoped PDP 規則 — Enterprise 多租脊椎第一塊磚

- **Phase**: P2（five-piece STEP 7 起點 — Enterprise 多租；NemoClaw/OpenShell 都不提供，100% 自建）
- **Branch**: slice/p2-f-tenant-scoped-policy-rules
- **Author**: <id>    **Adversarial reviewer**: <fresh-context、非作者>
- **Size budget**: <= 0.5 day；net LOC <~150、files <~3（`src/policy/types.ts` 加 optional tenantId + `src/policy/evaluate.ts` tenant scoping + `src/policy/tenant-scope.test.ts`）、新增依賴 = 0
- **狀態**: **DONE**（merge；fresh-context IV = PASS、零 defect）

## (1) ID + Title
SLICE-P2-F — 在 `AllowRule`/`DenyRule` 加 optional `tenantId`，並擴充 `evaluatePolicy` 的比對，使**租戶 A 的 allow 規則不 match 租戶 B 的請求**（落到 deny-by-default，且 reason 明示 cross-tenant），達成跨租 deny-by-default 的最小可驗版本——Enterprise 多租脊椎的第一塊磚。

## (2) Goal（一句話）
把「跨租戶隔離」變成 PDP 可驗的不變量：scoped 規則只在同租戶生效，**跨租的 allow 永遠不授權**（fail-closed、deny-by-default），向後相容既有無 tenantId 的規則。

## (3) In-scope / Out-of-scope
- In-scope：`AllowRule`/`DenyRule` 的 optional `readonly tenantId?: string`；`evaluatePolicy` 的 tenant-applies 比對（allow：`tenantId` 未設 = 全租戶適用；設了則僅同租戶；deny：未設 = 全租戶適用（fail-safe，可 deny 更多）、設了則僅同租戶）；malformed `tenantId`（present 但非非空字串）→ fail-closed；cross-tenant allow 被拒時 reason 明示 cross-tenant。
- Out-of-scope：gateway-per-tenant 進程/namespace 隔離、per-tenant Postgres、per-tenant kernel partition（後續 slice）；Tenant 物件/IAM 生命週期；reason 不得 echo 任何請求值（只用 rule id / 靜態文字 / 欄位名）。

## (4) Design + 模組 + 介面 + 依賴方向
- **Design delta**：PDP 的 deny-precedence / deny-by-default / fail-closed 不變；新增「同租戶才適用」維度。
  - `tenantApplies(rule, request)` = `rule.tenantId === undefined || rule.tenantId === request.tenantId`。
  - **deny 迴圈**：先 well-formed 檢查（含 optional tenantId：present 必為非空字串，否則 → `malformed deny rule (fail-closed)` 立即 deny）；唯有 `tenantApplies` **且** action+resource match 才 deny；scoped-to-other-tenant 的 deny 不適用（租戶 A 的 deny 不擋租戶 B）。
  - **allow 迴圈**：match 條件加上 `tenantApplies`；若有 allow 規則的 action+resource match 但 tenant **不**適用 → 記錄，最終 deny reason = `cross-tenant: allow rule '<id>' is scoped to another tenant (deny-by-default)`（只露 rule id，不露 tenantId 值）；否則維持 `no matching allow rule (deny-by-default)`。
  - 向後相容：既有無 tenantId 規則 = 全租戶適用，行為不變。
- **PUBLIC interface**：`AllowRule`/`DenyRule` 各加 `readonly tenantId?: string`；`evaluatePolicy` 簽名不變（同 PolicyRuleSet）。
- **依賴方向**：僅改 policy module 內部（types + evaluate，intra-module）；無新跨模組/vendor import。

## (5) Test-first plan（RED 先行）
順序（取得**斷言失敗的 RED**，非僅 build-fail）：先加 optional `tenantId?` 到型別（最小 stub 使測試可編譯），寫 `src/policy/tenant-scope.test.ts`，此時 evaluate 尚未實作 scoping → 行為 RED。測項：
- **headline**：allow 規則 `{tenantId:"tenant-a", action, resource}` 對 **tenant-b** 請求 → `deny`，reason 含 `cross-tenant`。（RED：未實作前會誤 `allow`。）
- 同租戶：同規則對 tenant-a 請求 → `allow`。
- 向後相容：無 tenantId 的 allow 規則對任何租戶 → 照常 match。
- deny scoping：`{tenantId:"tenant-a"}` 的 deny 規則不擋 tenant-b（同 action/resource 下 tenant-b 若有自己的 allow 則 allow）；無 tenantId 的 deny 擋所有租戶。
- fail-closed：deny 規則 `tenantId` present 但為 `""`/非字串 → `malformed deny rule (fail-closed)` → deny。
> 預期首次 RED：headline 斷言失敗（evaluate 尚未做 tenant scoping，誤 allow）。

## (6) Definition of Done（實測）
- [x] **first RED**（型別有欄位、evaluate 未做 scoping）：`vitest run tenant-scope.test.ts` → **3 failed | 3 passed**（headline cross-tenant、deny-scoping、malformed 斷言失敗）。
- [x] `pnpm run verify` **exit 0**（103 tests、deps 23 modules 0 violations、secret-scan clean）。
- [x] `deps:check` 綠（只動 policy module 內部、無 vendor、no-vendor-in-core 6/6 綠）。
- [x] secret-scan clean；IV 確認 reason **不 echo tenantId 值**（只 rule id / 靜態文字；planted secret-looking tenant string 不出現於任何 reason）。
- [x] **Adversarial review = PASS**（fresh-context IV，零 defect；tenant-A allow 在 wildcard/多規則/排序各情形下**皆無法**授權 tenant-B；scoped deny 不洩漏；global deny 擋所有租戶；malformed tenantId 兩側 fail-closed；mutation 3 種（忽略 tenant / scoped-deny 當 global / 跳過 malformed 檢查）皆被抓；既有 evaluate.test.ts **16 項仍綠**＝向後相容）。

## (7) Rollback
revert commit（移除 tenantId 欄位 + scoping 分支；既有規則行為不變）。

## (8) Depends-on / blocks
- Depends-on：既有 PDP（`src/policy/{types,evaluate}.ts`）。
- Blocks：gateway-per-tenant、per-tenant kernel partition、跨租 conformance（release-blocking）等 Enterprise 多租脊椎後續 slice。
