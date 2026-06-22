# SLICE-OS-S1: OpenShell mTLS gRPC transport — channel + ExecSandbox (server-streaming)

- **Phase**: OpenShell live(真實 transport 第一刀;鏡像 SpendGuard decision-transport)
- **Branch**: slice/os-s1-mtls-grpc-exec-transport
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1–2 day；net LOC <~280（proto 子集擴充 + regen codec + mTLS channel + exec streaming transport + 測試;**生成碼不計**）、新增依賴 = 0（@grpc/grpc-js 已在）
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-OS-S1 — 在 `src/runtime/openshell/` 建**真實的 mTLS gRPC transport** 的第一刀:一個讀本機 mTLS cert、連 `127.0.0.1:17670` 的 gRPC channel,並實作 `OpenShellExecTransport.execSandbox`(對應真實 `ExecSandbox(ExecSandboxRequest) → stream ExecSandboxEvent`,server-streaming),消費 stream 至 `exit` 事件 → 回 `ExecResult{exitCode, stdout, stderr}`。這條讓 `OpenShellSandboxAdapter.execSandbox` 能對**真實 gateway** 執行指令(NemoClaw hosting live 的地基)。

## (2) Goal（一句話）
把我們 adapter 的 `execSandbox` 從 fake 接到真實 OpenShell gateway:mTLS gRPC + server-streaming exec,fail-closed,vendor-confined。

## (3) In-scope / Out-of-scope
- In-scope:
  - **pin 真實 proto 子集**:從 `/tmp/openshell-src/proto/openshell.proto`(v0.0.66)把 `ExecSandbox` RPC + `ExecSandboxRequest`/`ExecSandboxEvent`/`ExecSandboxStdout`/`ExecSandboxStderr`/`ExecSandboxExit` 加進 `src/runtime/openshell/proto/openshell.subset.proto`(沿用既有 subset + `.sha256` + regen TS 的慣例;`openshell:proto:check` drift gate)。**只加我們消費的訊息**,保持 subset。
  - **mTLS gRPC channel**:`createOpenShellGrpcTransport({ endpoint, caCertPath, clientCertPath, clientKeyPath, deadlineMs?, maxOutputBytes? })` — 用 `@grpc/grpc-js` `credentials.createSsl(readFileSync(ca), readFileSync(key), readFileSync(cert))` 建 channel(比照 `src/runtime/ingest` 的 grpc-js 用法,confine 於 `src/runtime/openshell/`)。**cert 由路徑讀取,絕不寫進 repo/log;denied/error reason 絕不含 endpoint/cert 內容。**
  - **`execSandbox` server-streaming**:呼叫 `ExecSandbox`(request 由 `(sandboxId, command: readonly string[], opts)` 組:`sandbox_id`/`command`/`workdir`/`environment`/`timeout_seconds`/`stdin`)→ 消費 `stream ExecSandboxEvent`(累積 stdout/stderr bytes,遇 `exit` 取 exitCode)→ 回 `{status:"ok", result:{exitCode,stdout,stderr}, event}`。**沿用 adapter 既有 deadline/maxOutputBytes 紀律**:deadline 到而無 terminal exit → **deny(絕不偽造 success)**;累積超過 maxOutputBytes → abort + deny。transport 錯/stream 錯 → reject/deny。實作 `OpenShellExecTransport` 介面(client.ts)。
  - 測試:proto codec 單元(encode `ExecSandboxRequest`、decode `ExecSandboxEvent` oneof 對 byte fixture);exec transport 對 **fake gRPC stream**(stdout+exit → ExecResult;只 stdout 無 exit + deadline → deny;超量 → deny)。
- Out-of-scope（明確不做）:
  - `CreateSandbox`/`GetSandbox`/`WatchSandbox`/`DeleteSandbox` → **OS-S2**(本刀只 exec + channel;sandbox 由 harness/CLI 建)。
  - NemoClaw 綁定 / e2e → **NC-S11b**。
  - 其餘 30+ provider/service/policy RPC(永不在我們 transport 範圍)。
  - `ExecSandboxInteractive`/`ForwardTcp`/tty(非我們所需)。

## (4) Design delta + 依賴方向
- 新增真實 transport(取代 baseUrl health 殼於 exec 路徑);@grpc/grpc-js + proto codec **confine 於 `src/runtime/openshell/`**(depcruise:core 不得 deep-import;reviewer 以 core 注入實證邊界)。
- `OpenShellSandboxAdapter` 不改(它注入 transport;本刀提供真實 transport 實作)。
- **PUBLIC interface**:`createOpenShellGrpcTransport(opts)` 回傳至少含 `execSandbox` 的 transport(後續 OS-S2 補 lifecycle)。

## (5) Test-first plan（RED 先行）
- proto codec 單元(decode 不存在 → RED);exec transport 對 fake stream(transport 不存在 → RED)。
- **live 驗證(我跑,非 verify)**:對真 gateway + `agentos-nc-probe` sandbox `execSandbox(id, ["sh","-c","echo OS_S1_LIVE; whoami"], …)` → exitCode 0 + stdout 含 `OS_S1_LIVE`/`sandbox`。

## (6) Definition of Done（待實測填）
- [ ] RED:proto codec + exec transport 測試在實作前紅。
- [ ] `pnpm run verify` exit 0(`openshell:proto:check` drift 綠;codec + exec 單元測試綠;hermetic——live 不入 verify)。
- [ ] **live(我跑)**:真 gateway mTLS exec → exitCode + stdout 正確;deadline-無-exit → deny;超量 → deny(各驗)。
- [ ] depcruise exit 0(grpc-js/codec confine 於 runtime/openshell);secret-scan clean(cert 由路徑讀、不入 repo/log;reason 不含 endpoint/cert)。
- [ ] fail-closed:stream 錯/deadline/超量 → deny;**絕不偽造 success**。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:deadline-無-exit 改回 success → deny 測試紅;decode 漏 exit → codec/exec 測試紅;cert 內容洩進 reason → 憑證測試紅)。

## (7) Rollback
- `git revert <merge-sha>`(移除真實 transport + proto 子集擴充 + 還原)。adapter 不變、可逆。

## (8) Depends-on / blocks
- Depends-on:OpenShell adapter + transport 介面(DONE)、真實 proto(v0.0.66,在 `/tmp/openshell-src`)、@grpc/grpc-js(已在)、運行 gateway(已就緒)。
- Blocks:NC-S11b(NemoClaw live e2e)、OS-S2(lifecycle)。
- **誠實前提**:live 驗證需運行的 gateway(我跑);verify 維持 hermetic。
