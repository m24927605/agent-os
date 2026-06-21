# SLICE-P2R-R8-S5: capability-possession maker-checker（maker≠checker + action-identity rederive fail-closed）

- **Phase**: P2（R8 Enterprise 多租脊椎；對齊 three-surface P4 capability-possession maker-checker）
- **Branch**: slice/p2r-r8-s5-capability-possession-maker-checker
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；net LOC <~240、files <~3（`src/tenant/maker-checker.ts` + `maker-checker.test.ts` + barrel 追加）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R8-S5 — `enforceMakerChecker`：敏感動作需 checker **持有**一張綁定 (tenantId, actionIdentity, makerActorId) 的 `CheckerCapability`，且 `maker≠checker`、執行前 **rederive actionIdentity 不符即 fail-closed**——maker≠checker 由 **capability 持有性** enforce，非 `if maker==checker` 字串比對。

## (2) Goal（一句話）
把 maker-checker 變成不可繞過的不變量：沒有合法 `CheckerCapability`、或 checker 即 maker、或將執行動作的 identity 與 capability 綁定值不符 → **deny（fail-closed）**，且跨租 capability 不適用（沿用 PDP cross-tenant deny-by-default）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `CheckerCapability`（不可由 maker 自發：含 `tenantId` / `actionIdentity` / `makerActorId` / 不透明 `capabilityRef`）。
  - `deriveActionIdentity(action): string`（決定性導出將執行動作的 identity）。
  - `enforceMakerChecker(ctx, action, cap): MakerCheckerDecision`：
    1. `parseAgentContext(ctx)` fail-closed；
    2. checker **持有** cap（possession，傳入即視為持有；不接受 maker 自簽——cap 由獨立簽發路徑產生，本 slice 以 ≥2 impl/fake 簽發器表達）；
    3. `cap.makerActorId !== ctx.actorId`（同一人不能既 maker 又 checker）；
    4. `deriveActionIdentity(action) === cap.actionIdentity`（**rederive**，不符 → fail-closed `action_identity_mismatch`）；
    5. `cap.tenantId === ctx.tenantId`（跨租 cap 不適用 → cross-tenant deny）。
- Out-of-scope（明確不做）：
  - 完整 capability algebra（child⊆parent attenuation、sub-delegation firewall）→ **P5**（design §5）。
  - capability 的密碼學簽發/撤銷生命週期細節 → 後續（本 slice 只 enforce 持有+綁定+rederive 不變量）。
  - 把 maker-checker 事件 Append 到 kernel partition 的接線 → 後續 console-action slice（本 slice 回 decision，純函式 enforce）。
  - reason 不得 echo ctx/cap 任何敏感值（只用靜態 error code / 欄位名）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增 `src/tenant/maker-checker.ts`。enforce 為**純函式**，回 `{effect:"allow"|"deny", reason, auditRequired:true}`
  （形狀對齊 `PolicyDecision`，`src/policy/types.ts:24-30`）。借鑑 AGT「approval 綁 `enforced_identity` + 執行前 rederive +
  不符 fail-closed `runtime_error:approval_action_mismatch`」（verified-from-spec：
  `/tmp/agent-governance-toolkit/policy-engine/spec/SPECIFICATION.md:388,432`），但把 approval 升級為
  **capability possession**（cap 不可由 maker 自發），且維持 deny-by-default：任一條件不滿足即 deny（**不**短路成 allow）。
- **Modules touched（唯一責任）**：
  - `src/tenant/maker-checker.ts` — 唯一責任：以 capability 持有性 + maker≠checker + action-identity rederive enforce 雙人控制，fail-closed。
- **PUBLIC interface（新增）**：
  - `export interface CheckerCapability { readonly tenantId: string; readonly actionIdentity: string; readonly makerActorId: string; readonly capabilityRef: string; }`
  - `export interface MakerCheckerDecision { readonly effect: "allow" | "deny"; readonly reason: string; readonly auditRequired: true; }`
  - `export function deriveActionIdentity(action: { readonly kind: string; readonly resource: string }): string;`
  - `export function enforceMakerChecker(ctx: unknown, action: { kind: string; resource: string }, cap: unknown): MakerCheckerDecision;`
- **Dependency direction（inward、acyclic）**：
  ```
  src/tenant/maker-checker.ts ──▶ src/iam/ids (parseAgentContext)    # 經 PDP-sole-deny 語意（P2-E）對齊，不 deep import policy 內部
  ```
  - 僅經 public surface 消費（`src/iam/ids.js`；deny 語意對齊 P2-E PDP，但不 import policy 內部）: ☐ 是
  - 新依賴宣告：`iam/ids`（身分來源）；方向=inward、cycle=無、理由=ctx 是 checker 身分唯一來源。無 vendor import。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/tenant/maker-checker.test.ts`
- RED 測試清單：
  - [ ] headline allow：合法 cap（同租、actionIdentity 相符、makerActorId≠checker）+ 合法 ctx → `allow`。
  - [ ] maker==checker：`cap.makerActorId === ctx.actorId` → `deny`，reason 含 `maker_is_checker`。
  - [ ] **TOCTOU / rederive**：cap 綁的 actionIdentity 對應動作 X，但實際傳入動作 Y（`deriveActionIdentity(Y)!==cap.actionIdentity`）→ `deny`，reason 含 `action_identity_mismatch`。
  - [ ] cross-tenant：`cap.tenantId !== ctx.tenantId` → `deny`（cross-tenant，sit on PDP deny-by-default 語意）。
  - [ ] fail-closed：malformed ctx / malformed cap（缺欄位 / 空字串）→ `deny`（絕不 allow）。
  - [ ] reason 不洩漏：planted secret-looking capabilityRef/actorId 不出現於任何 reason。
- 首次紅燈證據（待實作填）:
  ```
  $ pnpm test src/tenant/maker-checker.test.ts
  ... FAIL ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據；待實作覆蓋）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
- [ ] `pnpm run deps:check` exit 0（`src/tenant` 內，僅依賴 `iam/ids`；no-vendor-in-core 綠）
- [ ] low coupling / high cohesion：純函式 enforce、無跨 module deep import、無 cyclic
- [ ] secret-scan 乾淨（maker-checker/test 無 secret-like 值；reason 只用 error code/欄位名）
- [ ] Docs 更新（design §2.6；本 slice）
- [ ] Adversarial code review = PASS（fresh-context；嘗試自簽 cap / TOCTOU swap action / 同人雙角 / 跨租 cap 皆 deny）
- [ ] **Independent Verifier Pass**（maker≠checker + capability possession + rederive fail-closed + 跨租；mutation：跳過 rederive / 忽略 maker==checker 必被抓）

## (7) Rollback
- 回退方式：`git revert <merge-sha>`（移除 `src/tenant/maker-checker.ts`；純函式、無副作用）。
- 可逆性：安全可逆（無 audit append、無外部副作用；本 slice 只回 decision）。

## (8) Depends-on / blocks
- Depends-on：R8-S1（tenant binding / 跨租語意）、P2-E（PDP 唯一 deny 權威，deny-by-default 語意對齊，已 merge）。
- Blocks：R8-S6（conformance 重證 maker-checker fail-closed）、後續 console-action slice。
- 確認 slice DAG 無 cycle: ☐ 是（R8-S5 rank=2）
