# NemoClaw live 整合 — 把 R11 AgentHosting adapter 接到真實 NemoClaw/OpenShell (INDEX)

> 2026-06-22。目標:讓 R11 `NemoClawAgentHosting` adapter 不再只對 in-process fake,而是經真實
> `OpenShellSandboxAdapter.execSandbox` 在**真實 OpenShell sandbox** 內 host/probe/reconcile agent。
> grounded 研究見 task wgjotfvei + 主迴圈 ground-truth。鏡像 SpendGuard live 範式。

## 0. 關鍵真相（grounded）
- **NemoClaw 不是獨立 daemon**:它是跑在 **OpenShell sandbox** 內的 OpenClaw plugin + 進入點 `nemoclaw-start.sh`。無自有 RPC。可達面只有 (a) OpenShell sandbox 生命週期(Create/Get/Exec/Delete)、(b) gateway dashboard WebSocket `127.0.0.1:18789`。
- **我們的 adapter 講「sandbox 內 shell 指令」**,不講 NemoClaw 協定:`launchCommand`(nohup [gosu] <cmd>)、`probeCommand`(curl /health)、`recoveryCommand`(pkill+relaunch)——`src/hosting/adapters/nemoclaw/adapter.ts:173/179/184`。注入縫 = `CommandSink.run(command): Promise<{exitCode,stdout}>`(adapter.ts:41)。
- **真實 transport = 包 `OpenShellSandboxAdapter.execSandbox`**(`src/runtime/openshell/adapter.ts:445`,已存在且合約測試過)。**所以 NemoClaw live == OpenShell live**。
- **真實啟動 shape 與我們 adapter 相符**(runtime.ts:143/147 `nohup gosu <user> <cmd>`)✓。
- ⚠️ **已抓到一個 fake 遮蔽 bug**:`probeCommand()` 寫死 `http://127.0.0.1/health`(**port 80**),但真實 health 在 `127.0.0.1:${DASHBOARD_PORT}/health`(**18789**,runtime.ts:51-57)。fake sink 不在乎埠 → 單元測試綠但對真實 NemoClaw 永遠探錯埠。**S10 必修。**

## 1. Runnability（誠實）
- docker(OrbStack,host main loop)✅ 29.4.0。
- **OpenShell CLI/daemon 此環境未安裝** ❌ → 真 live 跑 **gated**,須使用者提供(見 §4)。
- **LLM key**:我們的 AgentHosting 只管 host/probe/reconcile(**不做 inference**)→ live 用 **trivial agent**(在 dashboard port 服務 /health 的小程序)即可證明生命週期,**不需 LLM key**;key 僅完整 NemoClaw agent 做真 inference 才需(超出本 port 契約)。
- verify 全程維持 hermetic:live e2e 一律 gated(無 OpenShell env → `describe.skip` + harness preflight BLOCKED-diagnostic)。

## 2. 切片分解（小、RED-first）
| Slice | 範圍 | infra | 狀態 |
|---|---|---|---|
| **R11-NC-S10** | 真實 transport `createOpenShellExecCommandSink`(包 execSandbox,vendor-confined `src/runtime/nemoclaw/`)+ **修 probe-port drift**(dashboard port 可注入,default 18789)+ 單元測試 vs fake exec | 無(可現在建)| DRAFT |
| **R11-NC-S11** | gated live e2e + harness:trivial-agent 經真實 OpenShell host→probe→reconcile→destroy;preflight openshell→BLOCKED-diagnostic、skip 保 hermetic | OpenShell daemon(使用者提供)| DRAFT(live-run BLOCKED until §4)|

## 3. 誠實前提
- S10 是真實生產接線 + 修真 bug,但**沒有 live 信心**(SpendGuard 正是靠 live 抓到 3 個 fake 遮蔽 bug;S10 已靠 grounding 抓到 1 個 probe-port,但其餘 shape 仍需 live 驗)。
- S11 的 live 跑在 OpenShell 就緒前 **BLOCKED**——誠實標記,不偽造。

## 4. 使用者需提供（解 BLOCKED）
1. **OpenShell daemon/CLI**(用 Docker driver over OrbStack):依 NemoClaw 文件用 `nemoclaw onboard`(自動 pin 相容 OpenShell 版本)或手動安裝 OpenShell CLI;確認 `openshell sandbox create` 可對 OrbStack docker 起 sandbox。
2. (可選)LLM key(`NVIDIA_INFERENCE_API_KEY` 或本地 NIM/vLLM on :8000)——**僅完整 inference 需要**;trivial-agent 生命週期證明不需。
3. 就緒後告知,我跑 `pnpm run e2e:live-nemoclaw`(S11 harness)對真實 OpenShell 驗證,並誠實回報(含任何 live 才現形的 shape 落差)。
