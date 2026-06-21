# SLICE-P2R-R11-S1: NemoClaw hosting adapter（over P2-H AgentHosting port）

- **Phase**: P2（R11 真實 vendor adapter — hosting 槽位）
- **Branch**: slice/p2r-r11-s1-nemoclaw-hosting-adapter
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~220、files <~4（`src/hosting/adapters/nemoclaw/{adapter.ts,index.ts}` + `src/hosting/adapters/nemoclaw/adapter.test.ts` + 餵進既有 `src/test-contracts/agent-hosting-adapter.test.ts` 的一行 registration）、modules <~2（hosting/adapters/nemoclaw + 既有 contract）、新增第三方依賴 = 0
- **狀態**: **DRAFT**（RED 計畫 + DoD 佔位，待實作時以真實 exit code 覆蓋）

## (1) ID + Title
SLICE-P2R-R11-S1 — 新增 `NemoClawAgentHosting`：實作 P2-H `AgentHosting` port，把 NemoClaw 的 `nohup+gosu` 長駐啟動 / health-probe / recovery 三動作對映成 `hostAgent`/`getAgentStatus`/`reconcileAgentProcess`，並補上 NemoClaw 沒有的 tenant scoping。經**注入式 CommandSink** seam（live ExecSandbox 留 R1）。

## (2) Goal（一句話）
讓 NemoClaw 成為 `AgentHosting` port 的真實 vendor adapter，**credential-blind + tenant-scoped + fail-closed**，並通過既有 hosting contract harness（作為第 3 個 impl）。

## (3) In-scope / Out-of-scope
- In-scope：
  - `src/hosting/adapters/nemoclaw/adapter.ts`：`NemoClawAgentHosting implements AgentHosting`（import 僅 `../../port.js` + `../../../iam/ids` allowlisted）。
  - `hostAgent` → 組裝 NemoClaw launch command（`nohup [gosu <user>] <gatewayCommand> &` 形狀，對映 `runtime.ts:143/147`）下發給注入的 `CommandSink`，回 `agentProcessId`（對映 `GATEWAY_PID`）。
  - `getAgentStatus` → 組裝 health-probe command（`curl -w '%{http_code}'`，`200|401`→`running`），對映 `runtime.ts:203`/`:272`（recovery script 內兩次出現的同款 probe）。
  - `reconcileAgentProcess("health-probe"|"restart")` → 探活 / recovery script（對映 `runtime.ts:220-284`）。
  - **tenant scoping**（NemoClaw 沒有）：registry sandboxId → {tenantId,...}；跨租操作 → `cross-tenant` denied（沿用 P2-H InMemory 不變量）。
  - adapter 餵進既有 `agent-hosting-adapter.test.ts` factory（第 3 個 impl，過全部既有斷言）。
- Out-of-scope（明確不做）:
  - 真實 OpenShell `ExecSandbox` 下發 command（live transport）→ 留 R1 後整合 slice。
  - NemoClaw onboard 狀態機 / ConnectSupervisor 完整生命週期（`onboard/machine/runtime.ts`）→ 不複製。
  - gateway-per-tenant 進程/namespace 隔離 → 留 R8 Enterprise 脊椎。
  - command 字串的 shell-injection 完整 hardening（NemoClaw 自有 `shellQuote`）→ 本 slice 只斷言 credential-blind + 形狀，深度 escaping 留整合 slice。

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**：新增一個 vendor adapter module；core 與 port 不改；contract harness 加一個 impl registration。
- **Modules touched（唯一責任）**:
  - `src/hosting/adapters/nemoclaw/adapter.ts` — 把 NemoClaw 的 launch/probe/recovery command 形狀對映成 `AgentHosting`，並施加 tenant scoping + credential-blind + fail-closed。
  - `src/hosting/adapters/nemoclaw/index.ts` — 只 re-export `NemoClawAgentHosting`（vendor barrel，不上 package barrel）。
- **PUBLIC interface（新增）**:
  - `class NemoClawAgentHosting implements AgentHosting`（建構子注入 `commandSink: CommandSink`）；
  - `interface CommandSink { run(command: string): Promise<{ exitCode: number; stdout: string }> }`（注入式 transport seam；live impl 由 R1 後 wire）。
- **Dependency direction（HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    hosting/adapters/nemoclaw ──▶ hosting/port.ts ──▶ iam/ids
    ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是（只 import `../../port.js` + `iam/ids`）
  - 新依賴宣告：`CommandSink` 為**本 adapter 自有的注入 seam**，非跨 module 依賴、非第三方；方向 inward、無 cycle；理由＝避免 core import vendor SDK，並讓 contract test 純 in-process。

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `src/hosting/adapters/nemoclaw/adapter.test.ts`（adapter module 不存在 → RED：import 失敗）；外加把 adapter 註冊進 `src/test-contracts/agent-hosting-adapter.test.ts` factory list。
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] `hostAgent` 同租戶 → ok + `agentProcessId`；下發的 command 字串符合 `nohup ... &` 形狀（含可選 `gosu`）。
  - [ ] **tenant 隔離**：tenant-A host 後，tenant-B 對同 sandboxId 的 status/reconcile/重複 host → `cross-tenant` denied（fail-closed）。
  - [ ] unknown sandbox 的 status/reconcile → denied。
  - [ ] `reconcileAgentProcess("restart")` → 下發 recovery-script 形狀的 command；`("health-probe")` → 探活 command。
  - [ ] 安全對抗式 — **credential-blind**：下發的 command 字串不含 secret-shape（只含 `HERMES_HOME` 類非密 env）；HostSpec 結構無 credential 欄位（沿用 contract 斷言）。
  - [ ] 安全對抗式 — **fail-closed**：壞 ctx（`{}`/`null`/缺 tenantId）兩側 → denied + contextError、永不 throw；`CommandSink` throw → denied（deny-by-default），不洩漏。
  - [ ] **no-vendor-in-core 回歸護欄**：對某 core 檔案植入 `import ... nemoclaw` fixture → `pnpm run deps:check` exit≠0；移除後 exit 0（沿用 P2-B 模式）。
- 首次紅燈證據（貼 exit≠0；DRAFT 佔位）:
  ```
  $ pnpm test src/hosting/adapters/nemoclaw/adapter.test.ts
  ... FAIL: Cannot find module '.../adapters/nemoclaw/index.js' ...
  exit code: <填實測，預期 1>
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5；git history 證 doc→red→impl 順序）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: <填實測，目標 0>
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；`no-vendor-in-core` 持綠：vendor import 只在 `adapters/nemoclaw/`）
- [ ] low coupling / high cohesion 遵守（adapter 僅 import `../../port.js` + `iam/ids`；無 deep import、無 cyclic、未跨 vendor）
- [ ] secret-scan 乾淨（adapter / test / 下發 command fixture 無 secret-like 值；canary 為 runtime 組裝）
- [ ] Docs 更新（`docs/design/vendor-adapters.md` §2.1 已述；如行為偏移則同步）
- [ ] Adversarial code review = PASS（fresh-context；親自重跑 verify + mutation 驗 tenant 隔離/credential-blind 測試非 theater）— 連結/摘要: <填>
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean（adversarially probed：tenant-B 碰不到 A 的 agent、壞 ctx 不污染 victim、CommandSink-throw fail-closed、credential 不入 command）

## (7) Rollback
- 回退方式: `git revert <merge-sha>`（移除 `adapters/nemoclaw/` 目錄 + contract factory 一行 registration）。
- 可逆性: 安全可逆——純新增 adapter module，無外部副作用、無資料遷移、無 audit append（command 只下發到 in-process fake CommandSink）。

## (8) Depends-on / blocks
- Depends-on: **P2-H**（AgentHosting port + contract harness，DONE）；既有 `iam/ids`。
- Blocks: NemoClaw hosting 的 **live wire 整合 slice**（depends-on R1 live OpenShell substrate adapter，提供真實 `ExecSandbox` 作 `CommandSink`）。
- 確認 slice DAG 無 cycle: ☐ 是（R11-S1 → P2-H rank-0；單向）。
