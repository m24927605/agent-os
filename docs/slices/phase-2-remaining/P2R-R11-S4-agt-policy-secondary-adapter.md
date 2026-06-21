# SLICE-P2R-R11-S4: AGT policy secondary adapter（advisory，over P2-E SecondaryPolicyAdapter）

- **Phase**: P2（R11 真實 vendor adapter — policy secondary 槽位）
- **Branch**: slice/p2r-r11-s4-agt-policy-secondary-adapter
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~160、files <~3（`src/policy/adapters/agt/{adapter.ts,index.ts}` + `src/policy/adapters/agt/adapter.test.ts`；並擴用既有 `src/policy/dedup.test.ts` 的 PDP-deny-prevails 斷言）、modules <~2、新增第三方依賴 = 0
- **狀態**: **DONE**（RED→GREEN 完成；`pnpm run verify` exit 0；已合併入 main）

## (1) ID + Title
SLICE-P2R-R11-S4 — 新增 `AgtSecondaryPolicy`：實作 P2-E `SecondaryPolicyAdapter`（advisory），把 AGT `GovernedCallable` 的 `PolicyDecision`（allowed/action/matched_rule/reason）對映成我們的 advisory `PolicyDecision`，**只有 AGT 的 `allow` 才映 allow，其餘（deny/warn/log/require_approval/malformed）一律 fail-closed deny**；AGT 永遠是 advisory，**絕不**翻轉 PDP-deny。經**注入式 AgtEvaluateFn** seam（live Python engine 留後續）。

## (2) Goal（一句話）
讓 AGT 成為 `SecondaryPolicyAdapter` 的真實 vendor advisory adapter，**PDP 仍是唯一 deny 權威（AGT-allow 輸給 PDP-deny）+ AGT 非-allow 一律 deny（fail-closed）+ AGT throw → 合成 deny**，並通過既有 dedup harness。

## (3) In-scope / Out-of-scope
- In-scope：
  - `src/policy/adapters/agt/adapter.ts`：`AgtSecondaryPolicy implements SecondaryPolicyAdapter`（import 僅 `../../dedup.js` 的 interface + `../../types.js`）。
  - `evaluate(req: PolicyRequest): PolicyDecision`：把 `PolicyRequest`（action/resource/actor/tenant）對映成 AGT evaluation context，呼叫注入的 `AgtEvaluateFn`，把回傳對映回我們的 `PolicyDecision`：
    - AGT `allowed===true && action==="allow"` → `effect:"allow"`；
    - **其餘一律 `effect:"deny"`**（`deny`/`warn`/`log`/`require_approval`/malformed effect → fail-closed）；
    - 帶 AGT `matched_rule`/`reason` 進我們的 `reason`（供 audit）；`auditRequired:true`。
  - 餵進既有 `dedup.test.ts`：AGT-allow + PDP-deny → 最終 deny（PDP 唯一 deny 權威）；AGT throw → `evaluateSecondaries` 合成 deny。
- Out-of-scope（明確不做）:
  - 真實 AGT Python `governance` engine 連線（live transport）→ 留 R9 SDK seam + 整合 slice。
  - AGT 自身的 advisory/shadow 層（govern.py:283-296、`_shadow_impl.py`）→ 不對映（避免雙重 advisory 語義，設計 §2.4）。
  - `require_approval` 的真實 approval 通道 → 不接（approval 屬 PDP/maker-checker，P4）；本 slice 保守映 deny。
  - 把 AGT 升為 deny 權威 / 平行 deny gate → **明令禁止**（違反 dedup #1）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 vendor advisory adapter module；core `dedup.ts`/`types.ts` 不改；dedup contract 加一個真實 advisory impl。
- **Modules touched（唯一責任）**:
  - `src/policy/adapters/agt/adapter.ts` — 把 AGT `PolicyDecision` 對映成 advisory `PolicyDecision`，非-allow 一律 fail-closed deny。
  - `src/policy/adapters/agt/index.ts` — 只 re-export `AgtSecondaryPolicy`（vendor barrel）。
- **PUBLIC interface（新增）**:
  - `class AgtSecondaryPolicy implements SecondaryPolicyAdapter`（建構子注入 `evaluate: AgtEvaluateFn`）；
  - `interface AgtDecision { allowed: boolean; action: string; matchedRule?: string; reason?: string }`（對映 AGT `policy.py:435-455`）；`type AgtEvaluateFn = (ctx) => AgtDecision`（注入式 seam）。
- **Dependency direction（HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    policy/adapters/agt ──▶ policy/dedup.ts (SecondaryPolicyAdapter) + policy/types.ts
    ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是（只 import 同 module 的 `../../dedup.js` interface + `../../types.js`）
  - 新依賴宣告：`AgtEvaluateFn` 為 adapter 自有注入 seam（非跨 module、非第三方）；方向 inward、無 cycle；理由＝core 不 import AGT Python engine、dedup test 純 in-process（可腳本化回 allow/deny/warn/require_approval/throw）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/policy/adapters/agt/adapter.test.ts`（module 不存在 → RED：import 失敗）；外加在 `dedup.test.ts` 加 AGT-real-adapter 案例。
- RED 測試清單:
  - [ ] AGT 回 `{allowed:true, action:"allow"}` → adapter `effect:"allow"`。
  - [ ] 安全對抗式 — **PDP 唯一 deny**：AGT-allow + PDP-deny 經 `combineDecisions` → 最終 deny（AGT 只進 reason，effect 不執行）。
  - [ ] 安全對抗式 — **非-allow 一律 fail-closed deny**：AGT 回 `deny`/`warn`/`log`/`require_approval`/malformed effect（如 `{action:"banana"}`）→ adapter `effect:"deny"`。
  - [ ] 安全對抗式 — **adapter throw → 合成 deny**：注入的 `AgtEvaluateFn` throw → 經 `evaluateSecondaries` 合成 deny（deny-by-default，crashing advisor 只能 deny 更多）。
  - [ ] 對映保真：AGT `matchedRule`/`reason` 進我們的 `reason`；`auditRequired===true`。
  - [ ] **no-vendor-in-core 回歸護欄**：core 植入 `import ... agt` fixture → `deps:check` exit≠0；移除後 exit 0。
- 首次紅燈證據（實測，adapter.ts/index.ts 暫移除後重跑）:
  ```
  $ node_modules/.bin/vitest run src/policy/adapters/agt/adapter.test.ts
  ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯
  Error: Failed to load url ./index.js (resolved id: ./index.js) in
    src/policy/adapters/agt/adapter.test.ts. Does the file exist?
   Test Files  1 failed (1)
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5：vitest exit 1, `Failed to load url ./index.js`；git history 證順序）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ✓ src/policy/adapters/agt/adapter.test.ts (15 tests)
  ✓ src/policy/dedup.test.ts (12 tests)
   Test Files  69 passed | 1 skipped (70)
        Tests  691 passed | 1 skipped (692)
  ... secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`deps:check` exit 0：`✔ no dependency violations found (113 modules, 266 dependencies cruised)`；`no-vendor-in-core` 持綠：agt import 只在 `adapters/agt/`；一個 adapter module 只 import 一個 policy 引擎）
- [x] low coupling / high cohesion 遵守（adapter 僅 import `../../dedup.js` interface + `../../types.js`；無 deep import / cyclic / 跨 vendor；未 import `evaluate.ts`）
- [x] secret-scan 乾淨（`secret-scan: clean`；adapter / test 無 secret-like 值）
- [x] Docs 更新（`vendor-adapters.md` §2.4 已述）
- [x] Adversarial code review = PASS（fresh-context；mutation 驗 PDP-deny-prevails / 非-allow-deny 測試非 theater；確認 `require_approval`/malformed 不被誤映 allow）— 摘要: 獨立 review 已通過（slice R11-S4 passed independent review）
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（adversarially probed：AGT-allow 永不翻 PDP-deny、AGT 非-allow 皆 deny、AGT throw 合成 deny、AGT 無法被接成平行 deny gate）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `adapters/agt/` + dedup.test.ts 新增案例）。
- 可逆性: 安全可逆——純新增 advisory adapter module，無外部副作用 / 無 audit append（AGT evaluate 為 in-process fake fn）。

## (8) Depends-on / blocks
- Depends-on: **P2-E**（PDP-sole-deny dedup：`SecondaryPolicyAdapter` + `combineDecisions` + `evaluateSecondaries`，DONE）；既有 `policy/types.ts`。
- Blocks: AGT 的 **live wire 整合 slice**（depends-on R9 SDK seam，提供真實 AGT Python engine.evaluate）；R8 Enterprise policy 合規證明（real advisory adapter 進 audit）。
- 確認 slice DAG 無 cycle: ☐ 是（R11-S4 → P2-E rank-0；單向）。
