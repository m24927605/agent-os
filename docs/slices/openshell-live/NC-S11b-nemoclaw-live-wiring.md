# SLICE-NC-S11b: NemoClaw hosting LIVE — converge accumulator + bind + live e2e

- **Phase**: OpenShell/NemoClaw live(NemoClaw hosting 生命週期 live 證明;收尾)
- **Branch**: slice/nc-s11b-nemoclaw-live-wiring
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1–2 day（不含 sandbox/gateway 啟動）；net LOC <~280、新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8 + 2 個 live-caught 修正=main-loop/Opus4.8;獨立 Opus4.8 reviewer = PASS;**NemoClaw hosting 對真實 OpenShell gateway LIVE 驗證**;一個 MAJOR-with-tracking〔composition root / OS-S2 same-instance〕見 §6）
- **取代**:`docs/slices/nemoclaw-live/R11-NC-S11-live-e2e-harness.md`(寫於 transport gap 發現前;本刀為精確版)。

## (1) ID + Title
SLICE-NC-S11b — 讓 `NemoClawAgentHosting` 經真實 OpenShell gateway host/probe/reconcile,完成 NemoClaw hosting 的 **live 證明**。含三件:(A)**收斂 OS-S1 的 MAJOR-tracking**——把 grpc-transport 改成 adapter 消費的 `OpenShellExecTransport`(AsyncIterable seam),刪重複累積;(B)**composition root 綁定**——`ExecLike → adapter.execSandbox`(ctx-closure + `["/bin/sh","-c",cmd]` 包裝);(C)**gated live e2e + harness**——在真 sandbox host 一個 trivial gateway → status running → reconcile。**不需 LLM key**。

## (2) Goal（一句話）
端到端 live:一個治理動作經 NemoClaw adapter → S10 CommandSink → 真實 OpenShell mTLS gRPC exec → 在真 sandbox 啟動/探測/恢復一個 gateway 程序,且只有一份 stream-累積邏輯(adapter)。

## (3) In-scope / Out-of-scope
- In-scope:
  - **(A) 收斂(必做,先做)**:`grpc-transport.ts` 改為實作 `OpenShellExecTransport.execSandbox(req: ExecSandboxRequest, signal?: AbortSignal): AsyncIterable<ExecSandboxEvent>`——建 mTLS client(沿用 OS-S1 channel + SNI 修正)、`makeServerStreamRequest(EXEC_SANDBOX_METHOD, encodeExecSandboxRequest, decodeExecSandboxEvent, req)`、`signal` abort → `call.cancel()`、回傳該 stream(已是 `AsyncIterable<ExecSandboxEvent>`)。**刪除** `consumeExecStream` + `ExecResult`/`ExecOpts`/`OpenShellGrpcExecTransport`(deadline/maxOutputBytes/exit→ExecResult 的累積**交由 `adapter.streamExec` 單一持有**,既有且測過)。對齊 codec 的 wire 型別與 adapter 的 `ExecSandboxRequest`(client.ts)。更新 OS-S1 的 grpc-transport 單元測試:從「consumeExecStream 累積」改為「seam yield stream + abort→cancel」(累積斷言已由 adapter 既有測試涵蓋)。
  - **(B) 綁定**:新增 composition root(如 `src/runtime/nemoclaw/openshell-exec.ts` 或 `src/hosting/adapters/nemoclaw/` 的接線):`createNemoClawOpenShellExec(adapter: OpenShellSandboxAdapter, ctx): ExecLike`,回 `(sandboxId, command, opts) => adapter.execSandbox(ctx, sandboxId, ["/bin/sh","-c", command], opts)`。餵 S10 的 `createOpenShellExecCommandSink({ exec, sandboxId })`。單元測試(fake adapter):確認 command 被包成 `["/bin/sh","-c",cmd]` + ctx 透傳 + ExecOutcome 直回。
  - **(C) gated live e2e**(gated on `AGENTOS_LIVE_OPENSHELL` + `AGENTOS_LIVE_OPENSHELL_SANDBOX`):`adapter = new OpenShellSandboxAdapter(createOpenShellGrpcTransport({…mtls…}))`;`sink = createOpenShellExecCommandSink({ exec: createNemoClawOpenShellExec(adapter, ctx), sandboxId })`;`host = new NemoClawAgentHosting(sink, { dashboardPort: 18789 })`。流程:`hostAgent(ctx, {sandboxId, agentName, gatewayCommand:<trivial /health:18789 server>})` → `HostResult.status==='ok'` + `agentProcessId`(GATEWAY_PID 解析)→ `getAgentStatus` → `phase==='running'`(curl :18789/health=200)→ `reconcileAgentProcess('health-probe')` ok → 清掉該程序。trivial gateway = python3 一行 HTTP server(任何路徑回 200),可背景化、存活。
  - **(D) harness** `scripts/e2e-live-nemoclaw.sh`:preflight `docker info` + `command -v openshell` → 缺 → **BLOCKED-with-diagnostic + exit 0**(不 hang);齊備 → 確保 sandbox(reuse `AGENTOS_LIVE_OPENSHELL_SANDBOX` 或 `openshell sandbox create --from openclaw` 起一個並於 trap 清掉)→ 設 env → 跑 gated vitest。`pnpm run e2e:live-nemoclaw`。**不入 verify。**
- Out-of-scope:
  - lifecycle Create/Get/Watch/Delete(我們 TS 端)→ **OS-S2**(本刀 sandbox 由 CLI/harness 建)。
  - NemoClaw 完整 inference/agent(LLM key)。
  - WebSocket dashboard 互動。

## (4) Design delta + 依賴方向
- 收斂使 **stream 累積只在 `adapter.streamExec`**(消除 OS-S1 的重複,結 MAJOR-tracking)。grpc-transport 變薄(channel + encode + yield)。binding confine 於 runtime(NemoClaw↔OpenShell 接線);grpc-js 仍限 `src/runtime/openshell`。depcruise 綠(reviewer 以 core 注入實證)。
- **PUBLIC**:`createOpenShellGrpcTransport(opts): OpenShellExecTransport`(收斂後);`createNemoClawOpenShellExec(adapter, ctx): ExecLike`。

## (5) Test-first plan（RED 先行）
- (A) grpc-transport seam 測試(fake makeServerStreamRequest):yield 全部 events + abort→cancel(改實作前紅)。
- (B) binding 單元(fake adapter):command→`["/bin/sh","-c",cmd]`、ctx 透傳、ExecOutcome 直回(binding 不存在→紅)。
- (C) live e2e:對未起 gateway/sandbox → host denied / exec reject → 測試 FAIL(RED:真打真);起真 sandbox 後綠。
- 我對真 gateway 跑 `pnpm run e2e:live-nemoclaw` 驗證。

## (6) Definition of Done（實測）
- [x] RED:seam/binding/live 測試在實作前紅(13 failed | 2 passed:`deleteSandbox is not a function`、舊 execSandbox 累積非 yield、binding import 缺)。
- [x] **收斂完成**:grpc-transport 實作 `OpenShellExecTransport`(yield,不累積);`consumeExecStream`/`ExecResult`/`ExecOpts`/`OpenShellGrpcExecTransport` 已刪;**全 repo 僅一份 exec stream 累積 = `adapter.streamExec`**(reviewer grep + mutation 證實);`adapter.exec.test.ts` 39 案不變綠;`createSandbox`/`deleteSandbox` 為 fail-closed stub(reject,OS-S2 換真)。
- [x] `pnpm run verify` **exit 0**(785 passed + 8 skipped;gated live SKIP hermetic;depcruise 125 modules grpc-js confined,reviewer 以 core 注入 → not-to-internal+no-vendor-in-core 實證;openshell:proto:check ok;secret-scan clean canary-tested)。
- [x] **live(我對真實 gateway 跑)**:`nemoclaw.live.test.ts` PASS(5.1s)——hostAgent(經真實 mTLS gRPC exec 啟動 trivial python3 /health:18789 gateway)→ ok + agentProcessId → getAgentStatus running(curl :18789=200)→ reconcile('health-probe') ok。`grpc-transport.live.test.ts` PASS(adapter.execSandbox 經收斂 seam:exitCode0+OS_S1_LIVE;deadline→denied)。
- [x] **harness 一鍵端到端 live 驗證**:`pnpm run e2e:live-nemoclaw`(無 env)→ 自建 `agentos-nc-live`(從 `get` human 輸出解析 gateway id)→ 兩個 live test 3 passed → 自動 `delete` → 乾淨。3 個 harness CLI 修正(我做、live 驗證):`destroy`→`delete`(且 by name)、`get` 無 json flag 改剝-ANSI 解析 `Id:`、create 加 `-- sh -c 'true'`(否則 CLI 互動 attach 在非 tty 下失敗)。
- [x] credential-blind + 無回歸(reviewer canary 測試;8 攻擊面 HELD/N/A)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;seam/binding/launchCommand/proto-drift/depcruise-邊界 皆 mutation 證實非 vacuous;launchCommand 對真 `/bin/dash` 驗證)。
- [x] **誠實回報 — 2 個 live-surfaced bug 修正(fake 單元測試遮蔽,live 抓到)**:(1) **launchCommand dash 語法錯**——`HERMES_HOME=val if`(賦值前綴接複合指令)在 dash 為 `Syntax error: "then" unexpected` → 非零 exit → hostAgent denied;修:env prefix 移到每個 `nohup`(simple command,合法+子程序繼承,比照 runtime.ts:170)+ hardening 測試。(2) sandbox 由 CLI 外部建 → adapter `refById` 無它 → exec denied "unknown sandbox";live e2e seed refById(test seam)。

### ⚠️ MAJOR-with-tracking(交 OS-S2 + composition root)
production **尚無** composition root 把 create+exec 接在同一個 `OpenShellSandboxAdapter` 實例(`createNemoClawOpenShellExec` 目前只有測試呼叫)。live e2e seed `refById` 代替尚未建的 OS-S2 CreateSandbox。**same-instance invariant**(exec 經創 sandbox 的同一 adapter → refById 共享)目前僅測試成立。**OS-S2 接真 CreateSandbox 並建/斷言單一 composition root(同實例 create+exec,production 不需 seed)。** 本刀 scope(收斂+binding+gated live 證明)健全,故 PASS;CreateSandbox 設計上屬 OS-S2,非本刀阻斷。

## (7) Rollback
- `git revert <merge-sha>`(還原收斂〔回 OS-S1 的 Promise<ExecResult> transport〕+ 移除 binding/e2e/harness)。

## (8) Depends-on / blocks
- Depends-on:**OS-S1**(mTLS channel + codec,DONE)、R11-S1(NemoClawAgentHosting)、R11-NC-S10(createOpenShellExecCommandSink + ExecLike)、OpenShell adapter(execSandbox/streamExec)。
- Blocks:無(NemoClaw hosting live 收尾);OS-S2 獨立補 lifecycle。
- **誠實前提**:live 需運行 gateway + sandbox(我跑);verify 維持 hermetic。
