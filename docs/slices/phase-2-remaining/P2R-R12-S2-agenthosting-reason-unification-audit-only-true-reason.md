# P2R-R12-S2: AgentHosting caller-facing reason 統一 + 真因只進 audit（消除存在性 oracle）

- **Phase**: P2（five-piece — AgentHosting 槽位收尾；ITEM R12 of [phase-2-remaining/INDEX.md](./INDEX.md)）
- **Branch**: slice/p2r-r12-s2-agenthosting-reason-unification
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~90、files <~3（`src/hosting/in-memory.ts` + `src/test-contracts/agent-hosting-adapter.test.ts` +（必要時）`src/hosting/port.ts` 常數）、modules ≤ 1（hosting）、新增依賴 = 0
- **狀態**: **DONE**

## (1) ID + Title
P2R-R12-S2 — 把 `InMemoryAgentHosting` 對 caller 回傳的 deny reason **統一為單一不可區分字串**（`"unknown sandbox"`），「unknown sandbox」與「cross-tenant」對 caller 不可區分；**真正的跨租真因只寫進 audit `event.reason`**（attester 可見、actor 不可見）。

## (2) Goal（一句話）
讓 caller **無法用 deny reason 區分「sandbox 不存在」與「sandbox 屬於別租」**，關閉跨租存在性 oracle，同時 audit 仍保留真因供 forensic。

## (3) In-scope / Out-of-scope
- In-scope：
  - `requireOwned`（`src/hosting/in-memory.ts:91-113`）的 unknown-sandbox（`:101`）與 cross-tenant（`:107`）兩分支，對 caller 回**相同** reason 常數 `UNKNOWN_SANDBOX = "unknown sandbox"`。
  - `hostAgent` 的 cross-tenant 分支（`src/hosting/in-memory.ts:39-47`）caller reason 同樣統一。
  - audit `event.reason` 維持**真因**（unknown vs cross-tenant 仍可區分），即 `denyEvent` 的 reason 與 caller 的 reason **解耦**。
  - contract harness 擴一條 **no-oracle 不變量**：跨租呼叫與 unknown 呼叫對 caller 回相同 reason，但 audit event 真因不同。
  - **遷移既有 tenant-isolation 測試斷言**：現有 `agent-hosting-adapter.test.ts:67-78`（「TENANT ISOLATION」）在 `:76` 斷言
    `r.reason.toLowerCase()).toContain("cross-tenant")`——此 slice 後 caller `reason` 不再含 "cross-tenant"（會變 `"unknown sandbox"`），
    故須把該斷言從 caller 面 `r.reason` **遷移到 audit 面** `r.event.reason`（仍 contain "cross-tenant"）。**這是行為契約的刻意改動，
    非弱化測試**——隔離不變量（tenant-B 被 deny）仍斷言，只是真因改在 audit 驗證。RED-first 時這條既有測試會先變紅（見 §5）。
- Out-of-scope（明確不做）：
  - 真實 NemoClaw adapter 的同類消除（套同一不變量）→ 留給 **R11**。
  - 把 hosting audit event 真正 append 進 WORM kernel → 留給 **R2**（ingest）。
  - port 簽章 / `HostResult`·`StatusResult` 形狀變更（不動）；Null adapter（本就單一 reason，不洩漏）。
  - timing side-channel（unknown vs cross-tenant 的耗時差）→ 本 slice 只處理 reason-string oracle；timing 留註記給 R8 conformance。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：caller-facing `reason` 與 audit `event.reason` **解耦**——前者對 unknown / cross-tenant 收斂為單一 `"unknown sandbox"`；後者保留 `"unknown sandbox (deny-by-default)"` / `"cross-tenant: sandbox is hosted by another tenant (deny-by-default)"`。`invalid ctx`（fail-closed）reason 不變（不洩漏存在性）。
- **Modules touched（唯一責任）**：
  - `src/hosting/in-memory.ts` — tenant-scoped host：deny 時 caller reason 不可區分、audit reason 留真因（改 `requireOwned :99-111` 與 `hostAgent :39-47`）。
  - `src/hosting/port.ts`（若需共用常數）— 契約常數 `UNKNOWN_SANDBOX` 的擺放（保持 `denyEvent` 仍吃真因參數）。
  - `src/test-contracts/agent-hosting-adapter.test.ts` — 擴 no-oracle 不變量 + 遷移既有 `:76` 跨租斷言到 `event.reason`（沿用既有 `ADAPTERS` factory `:22-25`）。
- **PUBLIC interface（新增/變更）**：
  - **無簽章變更**（`AgentHosting` / `HostResult` / `StatusResult` / `ReconcileResult` 形狀不動）。
  - 行為契約變更：`{status:"denied"}.reason` 在 unknown / cross-tenant 兩情況**字面相同**；`event.reason` 仍區分。（可選新增導出常數 `UNKNOWN_SANDBOX`。）
- **Dependency direction（inward、acyclic）**：
  - 箭頭圖：
    ```
    hosting/in-memory.ts ──▶ hosting/port.ts ──▶ iam/ids
    ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是
  - 新依賴宣告：**無**（純改既有 hosting 模組內常數/字串映射；不新增跨 module / 第三方依賴）。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔：`src/test-contracts/agent-hosting-adapter.test.ts`（擴）。
- RED 測試清單（每條對應一行為/不變量）：
  - [ ] 安全對抗式 — **跨租隔離（機密性）/ no-oracle**：
    - [ ] tenant-A host(sandboxX)；tenant-B 對 sandboxX `getAgentStatus` 的 caller `reason` === tenant-B 對一個**從未存在**的 sandboxY 的 caller `reason`（兩者皆 `"unknown sandbox"`，**不可區分**）。
    - [ ] 同上對 `reconcileAgentProcess`、`hostAgent`（cross-tenant 路徑）皆成立。
  - [ ] **audit 完整性**：上述跨租呼叫的 `event.reason` **仍是** cross-tenant 真因（`"cross-tenant: ...(deny-by-default)"`），與 unknown 的 `event.reason`（`"unknown sandbox (deny-by-default)"`）**可區分** ⇒ 真因進 audit 未被抹除。
  - [ ] **既有 tenant-isolation 測試遷移驗證**：`agent-hosting-adapter.test.ts:67-78` 的 `:76` 由斷言 caller `r.reason` contain "cross-tenant" 改為斷言 `r.event.reason` contain "cross-tenant"（隔離仍被 deny 的斷言保留）；遷移後該 case 綠。
  - [ ] deny-by-default 不變：合法 owner 仍可 status/reconcile 自己的 sandbox（不誤殺）。
  - [ ] fail-closed：壞 ctx 的 caller reason 仍是 `"invalid agent context (fail-closed)"`（不被統一掉、不洩漏存在性、行為不退化）。
- 首次紅燈證據（貼 exit≠0；實作前填）。新增的 no-oracle 不變量先見其紅（current code 仍對 caller 回 "cross-tenant"）:
  ```
  $ pnpm test src/test-contracts/agent-hosting-adapter.test.ts
  ... FAIL (no-oracle: expected caller reason "unknown sandbox" for cross-tenant, got
      "cross-tenant: sandbox is hosted by another tenant (deny-by-default)") ...
  exit code: 1
  ```
  > 實作後，既有 `:67-78` 的 `:76`（caller `r.reason` contain "cross-tenant"）會轉紅；GREEN 步驟同步把該斷言遷移到
  > `r.event.reason`（見 §3 In-scope「遷移既有 tenant-isolation 測試斷言」）——遷移是契約改動的一部分，非繞過測試。

## (6) Definition of Done（每條附指令證據）
- [x] Test-first 成立（首次 RED 已貼於 §5；git history 證 doc→red→impl）
- [x] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... secret-scan: clean
  exit code: 0
  ```
- [x] dependency-boundary check 綠（`pnpm run deps:check` exit 0；no-vendor-in-core enforcing；hosting 在 core from-list）
  ```
  $ pnpm run deps:check
  ✔ no dependency violations found (113 modules, 267 dependencies cruised)
  exit code: 0
  ```
- [x] low coupling / high cohesion 遵守（無新跨 module / cyclic 依賴；只動 hosting 模組 + 其 contract harness）
- [x] secret-scan 乾淨（無 secret-like 值；reason 字串無敏感資訊）
  ```
  $ pnpm run secret-scan
  secret-scan: clean
  exit code: 0
  ```
- [x] Docs 更新（`docs/design/follow-ups.md` §2.2 / §5 與此 slice 對齊；P2-H slice 註記 oracle 已消除）
- [x] Adversarial code review = PASS（fresh-context；mutation 驗證 no-oracle 測試非 theater——把 caller reason 還原成真因應令測試紅）— 連結/摘要: 獨立 review PASS（slice harness `agent-hosting-adapter.test.ts` 17 tests 全綠）
  ```
  $ pnpm test src/test-contracts/agent-hosting-adapter.test.ts
  Test Files  1 passed (1)
       Tests  17 passed (17)
  exit code: 0
  ```
- [x] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（adversarially probe：caller 面 unknown≡cross-tenant 不可區分、audit 真因仍在、fail-closed/owner 路徑未退化）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（caller reason 還原為原本兩種可區分字串）。
- 可逆性: 安全可逆——純記憶體 deny-path 字串映射，無外部副作用、無 audit append（本 slice 的 lifecycle event 尚未進 WORM kernel）。

## (8) Depends-on / blocks
- Depends-on: **P2-H**（AgentHosting port + InMemory/Null + tenant-scoped lifecycle + contract harness，已 DONE）。
- Blocks: **R11**（真實 NemoClaw adapter 套用同一 no-oracle 不變量）、**R8**（Enterprise 多租脊椎的 release-blocking 跨租 conformance）。
- 確認 slice DAG 無 cycle: ☐ 是（`P2R-R12-S2 -> {P2-H}`，P2-H 已 DONE；與 P2R-R12-S1 無邊）
