# SLICE-P2R-R1-S6: 過 P2-A SandboxAdapter contract（factory + start/stop shim + e2e opt-in skip）

- **Phase**: P2（ITEM R1 — live OpenShell substrate adapter，收尾：機械化證明可插拔）
- **Branch**: slice/p2r-r1-s6-pass-p2a-sandbox-adapter-contract
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~120、files <~4、modules = 2（`runtime/openshell` + `test-contracts`）；新增第三方依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-P2R-R1-S6 — 補齊 `OpenShellSandboxAdapter` 的 `startSandbox`/`stopSandbox` **明確 noop shim**（OpenShell 無 Start/Stop RPC，design §3.2 / five-piece-integration.md:77），新增 `index.ts` barrel，把 OpenShell adapter（以注入式 transport double 建構）**加進 P2-A 共享 contract harness 的 factory list**，並加一個**預設 skip 的 opt-in 真實 e2e** 測試。

## (2) Goal（一句話）
讓 OpenShell adapter 成為 ExecutionSubstrate port 的**第三個過同一 contract 的實作**，機械化證明它與 Null/Fake 可互換，且 start/stop 是誠實 shim 而非假裝。

## (3) In-scope / Out-of-scope
- In-scope:
  - `OpenShellSandboxAdapter.startSandbox/stopSandbox`：**noop shim**——已知 id（對映存在）→ `ok`（不打任何 RPC），未知 id → `deny`（fail-closed），event reason 註明「noop shim (OpenShell has no Start/Stop RPC)」。
  - `src/runtime/openshell/index.ts`：barrel，對外只出 `OpenShellSandboxAdapter`（+ 必要型別）。
  - 擴 `src/test-contracts/sandbox-adapter.test.ts`：把 OpenShell adapter（建構子注入一個 **in-test transport double**，模擬 create→READY→exec→delete 的 happy path 與 fail paths）加進 `describe.each` factory list，過 P2-A 既有 contract（schema-valid result、`status===event.result`、ok⇒sandboxId、壞 ctx→denied、永不 throw）。
  - `src/runtime/openshell/e2e.test.ts`：**opt-in、預設 skip**（env flag 未設則 `describe.skip`）的真實 gateway smoke（Health + create→READY→exec→delete），mirror `scripts/proto-check.sh` 的 skip 哲學——**不進預設 verify 紅綠判定**。
  - 把 OpenShell adapter import 納入 contract 測試的 no-egress allowlist 檢視（adapter 經 connect-node 確有 egress，故 OpenShell adapter **不**納入 substrate 的「零 egress」正向 allowlist；該 allowlist 仍只約束 port/null/fake，見 P2-A §5 —— 本 slice 不得放寬該 allowlist）。
- Out-of-scope（明確不做）:
  - 把 readiness/exec/provider-env 變成 port 公共方法（port 形狀凍結於 P2-A）。
  - composition root 注入真實 adapter 到 orchestration（留 R7/R8 surface slice）。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: ExecutionSubstrate port 從 2 impl → **3 impl 過同一 contract**；start/stop 從未實作 → 明確 shim；新增 barrel。
- **Modules touched（唯一責任）**:
  - `src/runtime/openshell/adapter.ts` — **唯一責任（補完）**：start/stop shim（誠實標記、fail-closed on 未知 id）。
  - `src/runtime/openshell/index.ts` — **唯一責任**：vendor adapter 的 public barrel。
  - `src/test-contracts/sandbox-adapter.test.ts` — **唯一責任（擴）**：把 OpenShell adapter 納入共享 contract factory。
- **PUBLIC interface（新增/變更）**:
  - `OpenShellSandboxAdapter` 完整 implements `SandboxAdapter`（create/start/stop/destroy 四方法齊備）。
  - barrel `export { OpenShellSandboxAdapter }`（+ transport 介面型別供 composition root 注入）。
- **Dependency direction（low coupling 自證）**:
  - 箭頭圖:
    ```
    test-contracts/sandbox-adapter.test.ts ──▶ runtime/openshell (barrel) + runtime/substrate (barrel)
    runtime/openshell/index.ts              ──▶ runtime/openshell/adapter.ts (同模組)
    ```
  - 僅經 public surface 消費（無 deep import）: ☑ 是（測試經兩個 barrel；test 檔被 deps:check `exclude` 但仍人工確認）
  - 新依賴宣告: 無第三方新依賴。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/test-contracts/sandbox-adapter.test.ts`（擴）+ `src/runtime/openshell/e2e.test.ts`（新，預設 skip）
- RED 測試清單:
  - [ ] 把 OpenShell adapter（注入 happy-path transport double）加進 `describe.each` → 共享 contract 一開始 **FAIL**（start/stop 未實作 / barrel 不存在）。
  - [ ] start 已知 id → `ok` 且 event reason 標記 noop shim；start 未知 id → `denied`（fail-closed）。
  - [ ] stop 同理（noop shim、未知 id deny）。
  - [ ] 安全對抗式（沿用 P2-A mutation 精神）：壞 ctx → denied、永不 throw、`status===event.result`、ok⇒sandboxId。
  - [ ] `e2e.test.ts` 在 flag 未設時為 `skip`（CI 預設不打網路），設 flag 時才連真實 gateway。
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test src/test-contracts/sandbox-adapter.test.ts
  ... FAIL（OpenShell adapter start/stop 未實作 / barrel 缺，contract 未過）...
  exit code: <填實測>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0（OpenShell adapter 過 P2-A 共享 contract；e2e 預設 skip 不影響紅綠）
  ```
  $ pnpm run verify
  ... exit code: <填實測>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`no-vendor-in-core` 仍綠：`openshell` token 只在 `src/runtime/openshell/` 與 test 內）
- [ ] **HARD CONSTRAINT（可插拔）**：ExecutionSubstrate port 現有 ≥3 impl（Null/Fake/OpenShell）過**同一** contract test；start/stop shim 誠實標記、未知 id fail-closed
- [ ] low coupling / high cohesion 遵守（adapter 經 substrate barrel implements port；無 deep import；無 cyclic）
- [ ] secret-scan 乾淨（contract double / e2e flag 無 secret-like 值）
- [ ] Docs 更新（design §3.2 start/stop shim、§8 slice 表標 S6 DONE）
- [ ] Adversarial code review = PASS（fresh-context；mutation：壞 adapter throws / status≠event / ok 無 id / start 假裝打 RPC ⇒ contract 須抓）— 連結/摘要: <填>
- [ ] Independent Verifier Pass：probe「OpenShell adapter 與 Null/Fake 在 contract 下行為一致、start/stop 確實未打 RPC、壞 ctx 一律 deny 不 throw」

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（從 factory list 移除 OpenShell adapter、移除 barrel/shim/e2e）。
- 可逆性: 安全可逆——僅測試組合與 shim/barrel 變更；無外部副作用（contract 用 transport double）、無 audit append。

## (8) Depends-on / blocks
- Depends-on: **P2R-R1-S2、S3、S4、S5**（contract happy path 需 create/destroy + readiness + exec + provider-env 全到位）。
- Blocks: ITEM R11（NemoClaw hosting / 真實 vendor adapter，INDEX.md R11 depends-on R1）；surface slice（R7/R8）注入真實 substrate。
- 確認 slice DAG 無 cycle: ☑ 是（S6 rank 3，依賴 S2/S3/S4/S5 皆 rank≤2；每條邊嚴格遞減）
