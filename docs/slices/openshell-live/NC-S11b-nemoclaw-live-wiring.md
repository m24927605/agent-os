# SLICE-NC-S11b: NemoClaw hosting LIVE — converge accumulator + bind + live e2e

- **Phase**: OpenShell/NemoClaw live(NemoClaw hosting 生命週期 live 證明;收尾)
- **Branch**: slice/nc-s11b-nemoclaw-live-wiring
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1–2 day（不含 sandbox/gateway 啟動）；net LOC <~280、新增依賴 = 0
- **狀態**: **DRAFT**
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

## (6) Definition of Done（待實測填）
- [ ] RED:seam/binding/live 測試在實作前紅。
- [ ] **收斂完成**:grpc-transport 實作 `OpenShellExecTransport`;`consumeExecStream`/`ExecResult` 等已刪;**全 repo 僅一份 exec stream 累積(adapter.streamExec)**;OS-S1 既有累積行為由 adapter 測試保住。
- [ ] `pnpm run verify` exit 0(gated live SKIP;單元測試綠;depcruise grpc-js confined;secret-scan clean)。
- [ ] **live(我跑)`pnpm run e2e:live-nemoclaw` exit 0**:真 sandbox → hostAgent ok + GATEWAY_PID → status running(探 :18789)→ reconcile ok → 清理;harness preflight 無 openshell → BLOCKED-diagnostic 非 hang。
- [ ] credential-blind:HostSpec/event/reason 無憑證;trivial gateway/probe 不含 secret;secret-scan clean。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:binding 不包 sh-c → exec 行為變/測試紅;收斂後仍留第二份累積 → 收斂測試紅;probe 探錯埠 → status 非 running 紅)。
- [ ] **誠實回報**:live surface 的任何 shape 落差(gateway_user/HERMES_HOME/launch)逐一修 + 加 hardening。

## (7) Rollback
- `git revert <merge-sha>`(還原收斂〔回 OS-S1 的 Promise<ExecResult> transport〕+ 移除 binding/e2e/harness)。

## (8) Depends-on / blocks
- Depends-on:**OS-S1**(mTLS channel + codec,DONE)、R11-S1(NemoClawAgentHosting)、R11-NC-S10(createOpenShellExecCommandSink + ExecLike)、OpenShell adapter(execSandbox/streamExec)。
- Blocks:無(NemoClaw hosting live 收尾);OS-S2 獨立補 lifecycle。
- **誠實前提**:live 需運行 gateway + sandbox(我跑);verify 維持 hermetic。
