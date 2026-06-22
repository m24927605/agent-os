# SLICE-R11-NC-S10: 真實 OpenShell exec CommandSink transport（+ 修 probe-port drift）

- **Phase**: R11（NemoClaw live;真實 transport,鏡像 SpendGuard 第一刀)
- **Branch**: slice/r11-nc-s10-real-exec-command-sink
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~180（`src/runtime/nemoclaw/exec-command-sink.ts` + 測試 + adapter probe-port 修正 + 測試）、新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS;fail-closed + probe-port 修正皆 mutation 證實非 vacuous）

## (1) ID + Title
SLICE-R11-NC-S10 — 新增真實 transport `createOpenShellExecCommandSink`(`src/runtime/nemoclaw/exec-command-sink.ts`),把 R11 `NemoClawAgentHosting` 的 `CommandSink` 注入縫接到真實 `OpenShellSandboxAdapter.execSandbox`;並修正 `probeCommand()` 寫死 port 80 的 drift(改 dashboard port 可注入,default 18789)。**vendor 限制在 `src/runtime/nemoclaw/`**(no-vendor-in-core 不破)。無 infra(unit-test vs fake exec)。

## (2) Goal（一句話）
讓我們的 NemoClaw adapter 的生產接線存在且正確:`CommandSink.run(cmd)` 走真實 OpenShell exec(denied/error→fail-closed),且 health-probe 打對埠——把 in-process fake 從生產路徑移除,只剩 live 跑(S11)。

## (3) In-scope / Out-of-scope
- In-scope:
  - `src/runtime/nemoclaw/exec-command-sink.ts`:`createOpenShellExecCommandSink({ exec, sandboxId, opts? }): CommandSink`——`exec` = `ExecLike` 薄縫 `(sandboxId, command: string, opts?) => Promise<ExecOutcome>`。**注意真實 `OpenShellSandboxAdapter.execSandbox` 是 4-arg `(ctx, sandboxId, command: readonly string[], opts?)`(adapter.ts:445)**;ExecLike 與其差兩軸:(a) `ctx` 省略、(b) `string` vs `string[]`。兩者由 **S11 composition root** 綁定:closure 綁 ctx + 把每條 shell 指令包成 `["/bin/sh","-c", command]`(seam 過的指令都是 shell script:`nohup…&`/`if…fi`/`pkill…;`/`curl…||echo 000`)。`.run(command)` → 呼叫 exec → **`status:"ok"`** 回 `{exitCode: result.exitCode, stdout: textDecode(result.stdout)}`(非零 exit 如實轉發,非 deny);**`status:"denied"` 或丟出 → reject(fail-closed)**,絕不偽造 success/0。barrel `src/runtime/nemoclaw/index.ts` 匯出。
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

## (6) Definition of Done（實測）
- [x] RED:transport import 失敗(`Failed to load url ./index.js`)+ probe-port 測試紅(probeCommand 仍 :80)。
- [x] `pnpm run verify` **exit 0**(759 passed + 5 skipped;8 transport + 17 adapter 測試綠;既有 adapter 合約測試仍綠,僅 probe 斷言改 :18789)。
- [x] depcruise exit 0(122 modules;vendor 限 `src/runtime/nemoclaw/`,`grep src/hosting openshell`=∅;reviewer 以 core 注入 openshell deep-import → exit 2 觸發 not-to-internal + no-vendor-in-core,實證邊界仍 live);secret-scan clean(env placeholder-only)。
- [x] **fail-closed 驗證**:denied → reject、throw → reject、**絕不回 `{exitCode:0}` 偽造 success**;非零 exit 於 `status:"ok"` 如實轉發(command 結果 ≠ transport deny)。mutation(denied→`{0,""}` / throw 吞掉→`{0}`)皆使測試紅。
- [x] **probe-port 18789 對照 ground truth**(`/tmp/nemoclaw/src/lib/core/ports.ts:44` `SANDBOX_DASHBOARD_PORT=18789`)正確;threaded 到 `getAgentStatus` + `reconcileAgentProcess` 兩 call site;custom port 透傳。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;fail-closed / probe-port / command-pass-through 三 gate 皆 mutation 證實非 vacuous;8 攻擊面 HELD/N/A)。採納 2 個 MINOR:修正本 spec exec 簽章文字、改正一個 test 標題(health-probe 非 restart)。
> **S11 必辦(reviewer 釐清)**:composition root 把 `ExecLike` 綁到真 `execSandbox`——closure 綁 ctx + 每條指令包 `["/bin/sh","-c", command]`(seam 過的都是 shell script)。**誠實前提**:S10 為真實接線 + 修真 bug,但 live 信心待 S11(需使用者提供 OpenShell)。

## (7) Rollback
- `git revert <merge-sha>`(移除 transport + 還原 probe 寫死)。adapter 邏輯不變、可逆。

## (8) Depends-on / blocks
- Depends-on:R11-S1(NemoClawAgentHosting + CommandSink,DONE)、OpenShell adapter execSandbox(DONE)。
- Blocks:R11-NC-S11(live e2e)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:S10 為真實接線 + 修真 bug,但 live 信心待 S11(需使用者提供 OpenShell)。
