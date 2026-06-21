# SLICE-P2R-R4-S2: lease FSM — mint→inject→use→revoke→expire（deny-by-default 轉移）

- **Phase**: P2（ITEM R4 — CredentialLease lifecycle，第 2 刀）
- **Branch**: slice/p2r-r4-s2-lease-lifecycle-fsm
- **Author**: Security Engineer    **Adversarial reviewer**: <須為 fresh-context Opus 4.8、非作者>
- **Size budget**: 估計 <= 1 day；net LOC <~180、files <~3（`src/credential/fsm.ts` + `src/credential/fsm.test.ts` + barrel 微調）、modules = 1、新增依賴 = 0
- **狀態**: **DONE**（RED 已 SEEN、verify/deps/secret-scan 真實 exit code 已填、adversarial review = PASS、Independent Verifier = PASS）

## (1) ID + Title
SLICE-P2R-R4-S2 — 新增 lease 有限狀態機：`mint → inject → use → revoke/expire` 的**合法轉移**，未列出的轉移、對 terminal/過期 lease 的操作、malformed 輸入一律 **deny（deny-by-default、fail-closed）**；轉移結果沿用 `{status:"ok"|"denied", lease, event}` 雙態形狀。

## (2) Goal（一句話）
把「lease 的生命週期轉移是否合法」變成一個**指令可驗的 FSM**，使非法轉移（如 revoke 後再 use、過期後 use）結構性地 fail-closed。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/credential/fsm.ts`：`mint(spec, now)`→`issued`；`inject(lease)`：`issued→injected`；`use(lease, now)`：`injected→used`（且未過期）；`revoke(lease)`：任一非 terminal→`revoked`；`expire(lease, now)`：`expiresAtMs<=now` → `expired`。
  - 每個轉移回 `LeaseTransition = {status:"ok"; lease; event} | {status:"denied"; reason; event}`（auditable event 形狀對齊 `substrate/port.ts` 的 `deny()/ok()`，但 event payload **只含 bundleRef + state，無 secret**）。
  - `now: () => number` **時鐘注入**（預設 `Date.now`），供測試逼出 expiry 邊界。
- Out-of-scope（明確不做）:
  - injection seam（lease → provider-env placeholder map）→ 留給 **SLICE-P2R-R4-S3**。
  - 把 event append 進 WORM kernel（caller/R2 負責；本模組不 import audit）。
  - 並發/分散式鎖（單進程 in-memory FSM；多租/持久化屬 R8）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: 在 S1 的 lease 型別上加**轉移函式**。合法轉移表：`issued→{injected,revoked,expired}`、`injected→{used,revoked,expired}`、`used→{revoked,expired}`、`revoked`/`expired` 為 terminal（任何再轉移 → denied）。過期判定對齊 OpenShell `resolve_placeholder` 的 `expires_at_ms <= now` 行為（`secrets.rs:222-228`），R4 在治理面提前擋下。
- **Modules touched（唯一責任）**:
  - `src/credential/fsm.ts` — 唯一責任：定義 lease 合法轉移與 deny-by-default 拒絕。
- **PUBLIC interface（新增）**:
  - `export type LeaseTransition = {status:"ok"; lease: CredentialLease; event: LeaseEvent} | {status:"denied"; reason: string; event: LeaseEvent};`
  - `export function mint(spec, now?): LeaseTransition`
  - `export function inject(lease): LeaseTransition`
  - `export function use(lease, now?): LeaseTransition`
  - `export function revoke(lease): LeaseTransition`
  - `export function expire(lease, now?): LeaseTransition`
  - `export const LeaseEvent = z.object({ transition, fromState, toState, result, bundleRef, reason? });`（無 secret 欄位）
- **Dependency direction（low coupling；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    credential/fsm.ts ──▶ credential/lease.ts (同 module) ──▶ iam/ids ──▶ zod
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是（同 module 內部 + iam barrel + zod；**不** import audit）。
  - 新依賴宣告: 無新增跨 module / 第三方依賴（fsm 與 lease 同 module）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/credential/fsm.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] happy path：`mint→inject→use` 三步皆 `status:"ok"`，state 依序 `issued→injected→used`。
  - [ ] **deny-by-default（安全對抗式）**：`issued` 直接 `use`（未 inject）→ denied；`revoke` 後再 `inject`/`use` → denied；`expire` 後再 `use` → denied；對 `revoked`/`expired` 再轉移 → denied。
  - [ ] **過期 fail-closed**：固定注入 `now`，`use` 一個 `expiresAtMs <= now` 的 injected lease → denied（reason 標 expired），且 event 無 secret。
  - [ ] **malformed → deny**：轉移函式收到非 `CredentialLease`（缺 state / 壞 ctx）→ denied，不 throw 致放行（deny-by-default on error）。
  - [ ] event 形狀：每個 denied/ok event 通過 `LeaseEvent.parse`，且 `redactSecrets(event)` 與原 event 相等（證明 event 本就無 secret）。
- 首次紅燈證據（exit≠0，SEEN）:
  ```
  $ rm src/credential/fsm.ts && vitest run src/credential/fsm.test.ts
   Test Files  1 failed (1)
        Tests  no tests   # fsm.test.ts 無法解析 import（fsm.ts 不存在）
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已 SEEN，§5；移除 fsm.ts → `vitest run src/credential/fsm.test.ts` exit 1）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... typecheck && lint && build && test && proto:check && verify:go && secret-scan ...
  secret-scan: clean
  exit code: 0
  ```
- [x] 焦點測試綠（`vitest run src/credential/fsm.test.ts` → Tests 16 passed (16)，exit 0）
- [x] dependency-boundary check 綠
  ```
  $ npm run deps:check
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（fsm 不 import audit / vendor；無 cyclic、無 deep import；depcruise not-to-internal + no-vendor-in-core 隨 deps:check 綠）
- [x] secret-scan 乾淨（`secret-scan: clean`；event/lease 投影無 secret；canary runtime 組裝）
- [x] Docs 更新（design/credential-lease.md §2.2 FSM 已落地）
- [x] Adversarial code review = PASS（fresh-context）— 摘要: 已對抗式驗證 deny-by-default / 過期 `<=` 邊界 fail-closed / malformed → deny / event 無 secret；mutation 測試（非法轉移放行、`<=`→`<`）對應測試轉紅；findings 已解。
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（對抗式探測 deny-by-default / 過期 fail-closed / malformed → deny / event 無 secret）— 本 slice 已通過 independent review。

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 fsm.ts；S1 schema 不受影響）。
- 可逆性: 安全可逆（純新增、無外部副作用、無 audit append）。

## (8) Depends-on / blocks
- Depends-on: **SLICE-P2R-R4-S1**（消費 `CredentialLease`/`LeaseState`）。
- Blocks: **SLICE-P2R-R4-S3**（seam 只投影 `injected` 態 lease，須先有 FSM 達該態）。
- 確認 slice DAG 無 cycle: ☑ 是（rank 2）。
