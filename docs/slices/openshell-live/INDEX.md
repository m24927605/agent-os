# OpenShell live — 真實 mTLS gRPC transport（substrate + NemoClaw hosting live)(INDEX)

> 2026-06-22。目標:為 `OpenShellSandboxAdapter` 建一個**真實的 OpenShell mTLS gRPC transport**(目前
> 只有 `createOpenShellClient({baseUrl})` 的 health 殼;無 @grpc/grpc-js/mTLS),使我們能對**真實運行的
> OpenShell gateway**(`https://127.0.0.1:17670`, mTLS, v0.0.66)做 sandbox 生命週期 + exec,進而完成
> NemoClaw hosting 的 live e2e。鏡像 SpendGuard/kernel live 範式。

## 0. Grounded 事實（已 live 驗證 + 真實 proto）
- gateway:`https://127.0.0.1:17670`,**mTLS**,Connected,v0.0.66。mTLS 材料:`~/.config/openshell/gateways/openshell/mtls/{ca.crt,tls.crt,tls.key}` + `metadata.json`(endpoint)。
- **真實 proto 已取得**(github.com/NVIDIA/OpenShell @ **v0.0.66 tag** = 運行 gateway 版本):`/tmp/openshell-src/proto/{openshell.proto,sandbox.proto,datamodel.proto}`。service `OpenShell`(package `openshell.v1`)40+ RPC,**我們只消費 6 個**:
  - `Health(HealthRequest) → HealthResponse`(已 pin 在 `src/runtime/openshell/proto/openshell.subset.proto`)
  - `CreateSandbox(CreateSandboxRequest) → SandboxResponse`、`GetSandbox(GetSandboxRequest) → SandboxResponse`、`DeleteSandbox(DeleteSandboxRequest) → DeleteSandboxResponse`
  - `WatchSandbox(WatchSandboxRequest) → stream SandboxStreamEvent`(server-stream,readiness watch)
  - **`ExecSandbox(ExecSandboxRequest) → stream ExecSandboxEvent`**(server-stream;`ExecSandboxRequest{sandbox_id,command[],workdir,environment,timeout_seconds,stdin,…}`;`ExecSandboxEvent{oneof stdout|stderr|exit}`)——NemoClaw CommandSink 唯一用到的 RPC。
- gateway **不支援 gRPC reflection**(故 proto 由 v0.0.66 source pin,非 reflect)。
- 我們 adapter 的 transport 介面(`OpenShellLifecycleTransport`/`Readiness`/`Exec`,adapter.ts:35-38)本就照此 proto 設計;只差**真實實作**。@grpc/grpc-js 已在 repo 用於 `src/runtime/ingest`(可比照,confine 於 `src/runtime/openshell/`)。

## 1. 切片分解（small、RED-first、live-validated）
| Slice | 範圍 | infra | 狀態 |
|---|---|---|---|
| **OS-S1** | mTLS gRPC channel(讀 ca/tls cert 連 17670)+ pin 真實 proto 子集(擴 `openshell.subset.proto` 加 `ExecSandbox`+messages)+ regen codec + **`ExecSandbox` server-streaming** → 實作 `OpenShellExecTransport`;單元測試(proto codec + fake stream)+ **live 驗證**(對真 gateway exec)| 真 gateway(已就緒)| ✅ **DONE**(對真實 gateway live 驗證:exec→exitCode0+stdout;獨立 review PASS;**SNI 修正**〔grpc-js IP-SNI bug,live 抓到〕)|
| **OS-S2a** | `CreateSandbox`/`GetSandbox`/`DeleteSandbox`(unary)+ codec + **生產 composition root**(同一 adapter:create→READY 輪詢→host/exec→delete,**收掉 NC-S11b same-instance tracking,無 seed**)| 真 gateway | ✅ **DONE**(full lifecycle LIVE:create→ready→host→reconcile→delete 無 seed;3rd live-caught bug〔digest-ref pin〕修;獨立 review PASS)|
| **OS-S2b** | `WatchSandbox`(server-stream readiness)→ 完成 `OpenShellReadinessTransport`(取代 getSandbox 輪詢)| 真 gateway | DRAFT |
| **NC-S11b** | NemoClaw composition root 綁定 + gated live e2e(host trivial gateway〔python3 /health on 18789〕於真 sandbox → status running → reconcile)+ harness + **收斂 OS-S1 的 MAJOR-tracking:把 grpc-transport 包成 `OpenShellExecTransport`(yield stream)讓 adapter 單一累積,刪重複** | 真 gateway + sandbox | ✅ **DONE**(NemoClaw hosting 對真實 gateway LIVE:host→running→reconcile;收斂單一 accumulator;2 個 live-caught bug 修正〔dash launchCommand + refById〕;獨立 review PASS)|

## 2. 交付順序（早 live 里程碑 → 完整）
**OS-S1(exec+mTLS)→ NC-S11b(NemoClaw LIVE 里程碑,只需 exec)→ OS-S2(補完 lifecycle 給 substrate live)。** 每刀 doc-first + RED + 獨立 Opus 4.8 review + 我對真 gateway 跑 live + merge。

## 3. 風險（誠實）
- **proto drift**:我們 pin 的是 v0.0.66 source;gateway 也是 v0.0.66 → 應一致。live 驗證會 surface 任何不符。pin sha 防後續漂移。
- **mTLS / streaming**:server-streaming exec 的 deadline/maxOutputBytes 消費(adapter.ts:445 已有邏輯)+ mTLS channel 是重點;憑證(ca/tls.key)為**本機 gateway cert**,非 LLM key,但仍 **絕不寫進 repo/log/fixture**——transport 由路徑讀取,測試用臨時自簽或 fake stream。
- **vendor 限制**:@grpc/grpc-js + 真 proto codec 全 confine 於 `src/runtime/openshell/`;no-vendor-in-core 不破(depcruise gate)。
- NemoClaw 完整 inference(LLM key)非 hosting 證明所需;trivial-agent 路徑免 key。

## 4. 已就緒（本 session install+validate)
NemoClaw CLI v0.1.0(`/tmp/nemoclaw`);OpenShell CLI+gateway(17670 mTLS,v0.0.66);community `openclaw` sandbox 可 create+exec(免 key);工具 curl/nohup/pkill/python3 在(gosu fallback);mTLS cert + 真 proto 在手。
