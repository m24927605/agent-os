# SLICE-R11-NC-S10: 真實 OpenShell exec CommandSink transport（+ 修 probe-port drift）

- **Phase**: R11（NemoClaw live;真實 transport,鏡像 SpendGuard 第一刀)
- **Branch**: slice/r11-nc-s10-real-exec-command-sink
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~180（`src/runtime/nemoclaw/exec-command-sink.ts` + 測試 + adapter probe-port 修正 + 測試）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-R11-NC-S10 — 新增真實 transport `createOpenShellExecCommandSink`(`src/runtime/nemoclaw/exec-command-sink.ts`),把 R11 `NemoClawAgentHosting` 的 `CommandSink` 注入縫接到真實 `OpenShellSandboxAdapter.execSandbox`;並修正 `probeCommand()` 寫死 port 80 的 drift(改 dashboard port 可注入,default 18789)。**vendor 限制在 `src/runtime/nemoclaw/`**(no-vendor-in-core 不破)。無 infra(unit-test vs fake exec)。

## (2) Goal（一句話）
讓我們的 NemoClaw adapter 的生產接線存在且正確:`CommandSink.run(cmd)` 走真實 OpenShell exec(denied/error→fail-closed),且 health-probe 打對埠——把 in-process fake 從生產路徑移除,只剩 live 跑(S11)。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/runtime/nemoclaw/exec-command-sink.ts`:`createOpenShellExecCommandSink({ exec, sandboxId, opts? }): CommandSink`——`exec` = execSandbox-like fn(`(sandboxId, command, opts) => Promise<ExecOutcome>`,沿用 `src/runtime/openshell/adapter.ts:445` 簽章);`.run(command)` → 呼叫 exec → **`status:"ok"`** 回 `{exitCode: result.exitCode, stdout: textDecode(result.stdout)}`;**`status:"denied"` 或丟出 → reject(fail-closed)**,絕不偽造 success/0。barrel `src/runtime/nemoclaw/index.ts` 匯出。
  - **修 probe-port drift**:`adapter.ts:probeCommand()` 的 `http://127.0.0.1/health` → `http://127.0.0.1:${dashboardPort}/health`,`dashboardPort` 由 `NemoClawAgentHosting` 建構子/HostSpec 注入,default `18789`(runtime.ts:51-57 證實 health 在 DASHBOARD_PORT)。加測試:probe 指令含注入的埠;default=18789。
  - 單元測試(無 infra):注入 fake exec(回 ok{exitCode,stdout bytes})→ `.run` 回對映的 `{exitCode,stdout:string}`;fake exec 回 denied → `.run` reject;fake exec throw → reject;確認傳給 exec 的 command == adapter 組的指令字串。
- Out-of-scope（明確不做）:
  - live e2e + harness + 真 OpenShell → **R11-NC-S11**。
  - 改 P2-H port 契約、改 OpenShell adapter(只**消費** execSandbox)。
  - NemoClaw 完整 agent / inference 路徑(本 port 只管 hosting 生命週期)。

## (4) Design delta + 依賴方向
- **Design delta**:新增 vendor-confined transport(鏡像 `src/runtime/spendguard/decision-transport.ts` 之於 SpendGuard 的 LedgerTransport);adapter 的 probe 埠由寫死改注入。
- **依賴方向**:`runtime/nemoclaw/exec-command-sink` → `runtime/openshell`(execSandbox 型別/barrel)、`hosting`(CommandSink 型別,經 barrel);depcruise:vendor 限 `src/runtime/`,core 不得 deep-import,reviewer 以 core 注入實證邊界。
- **PUBLIC interface**:`createOpenShellExecCommandSink(opts): CommandSink`;`NemoClawAgentHosting({ sink, dashboardPort? })`。

## (5) Test-first plan（RED 先行）
- exec-command-sink.test.ts(transport 不存在 → import RED)。
- RED 清單:ok→映射 `{exitCode,stdout}`;denied→reject;throw→reject;傳入 command 透傳正確;probe 指令含注入埠(default 18789)的測試先紅(probe 仍寫死 80)。

## (6) Definition of Done（待實測填）
- [ ] RED:transport import 失敗 + probe-port 測試紅。
- [ ] `pnpm run verify` exit 0(transport + probe-port 修正全綠;既有 39 案 adapter 合約測試仍綠,probe-port 改注入後更新對應斷言)。
- [ ] depcruise exit 0(vendor 限 runtime;reviewer 以 core deep-import → 違規實證邊界);secret-scan clean(env 為 placeholder-only,無 raw credential)。
- [ ] fail-closed 驗證:denied/throw → reject;絕不回 `{exitCode:0}` 偽造 success。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:denied 改回 `{exitCode:0,stdout:""}`→fail-closed 測試紅;probe 改回寫死 80→probe-port 測試紅;transport 不透傳 command→透傳測試紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除 transport + 還原 probe 寫死)。adapter 邏輯不變、可逆。

## (8) Depends-on / blocks
- Depends-on:R11-S1(NemoClawAgentHosting + CommandSink,DONE)、OpenShell adapter execSandbox(DONE)。
- Blocks:R11-NC-S11(live e2e)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:S10 為真實接線 + 修真 bug,但 live 信心待 S11(需使用者提供 OpenShell)。
