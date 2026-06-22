# SLICE-R11-NC-S11: NemoClaw live e2e + harness（gated、hermetic-preserving、trivial-agent）

- **Phase**: R11（NemoClaw live;真 OpenShell 生命週期證明)
- **Branch**: slice/r11-nc-s11-live-e2e-harness
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（不含 OpenShell 安裝）；net LOC <~200（`scripts/e2e-live-nemoclaw.sh` + live e2e + 接線）、新增依賴 = 0
- **狀態**: **SUPERSEDED** → 由 `docs/slices/openshell-live/NC-S11b-nemoclaw-live-wiring.md` 取代(本檔寫於「OpenShell mTLS gRPC transport 缺口」發現前;NC-S11b 為含收斂+binding 的精確版)。

## (1) ID + Title
SLICE-R11-NC-S11 — 一條 gated live e2e + harness,證明 `NemoClawAgentHosting`(注入 `createOpenShellExecCommandSink`)能對**真實 OpenShell sandbox** host 一個 **trivial agent**(在 dashboard port 服務 `/health` 的小程序)→ `getAgentStatus` 探得 running → `reconcileAgentProcess('health-probe'|'restart')`→ 清理。**不需 LLM key**(只證 hosting 生命週期,非 inference)。

## (2) Goal（一句話）
拿到 NemoClaw 的真 live 信心:我們的 hosting adapter 對真實 OpenShell exec 的指令 shape(launch/probe/recovery + GATEWAY_PID 解析 + 探測埠)在真環境成立——surface 任何 fake 遮蔽的落差(如 S10 已修的 probe-port,以及其餘 gateway_user/HERMES_HOME 假設)。

## (3) In-scope / Out-of-scope
- In-scope:
  - `scripts/e2e-live-nemoclaw.sh`(鏡像 `scripts/e2e-live-spendguard.sh`):**preflight** `docker info` + `command -v openshell` → 任一缺 → 印 **BLOCKED-with-diagnostic** 並 **exit 0**(不 hang、不假綠);齊備 → `openshell sandbox create`(Docker driver)起一個含 trivial-agent 的 sandbox(或對既有映像跑 trivial 指令)→ 設 `AGENTOS_LIVE_NEMOCLAW_SANDBOX` env → 跑 gated vitest → `trap` 清理(`openshell sandbox destroy`)。`pnpm run e2e:live-nemoclaw`。**不入 verify。**
  - live e2e(gated on `AGENTOS_LIVE_NEMOCLAW_SANDBOX`,未設→`describe.skip`):用真 `OpenShellSandboxAdapter` + `createOpenShellExecCommandSink({exec, sandboxId})` 注入 `NemoClawAgentHosting` → `hostAgent`(trivial gateway command,host 一個服務 /health 的小程序)→ 斷言 `HostResult.status==='ok'` + `agentProcessId`(GATEWAY_PID)解析成功 → `getAgentStatus` → `phase==='running'`(探對埠 18789)→ `reconcileAgentProcess('health-probe')` ok → 清理。
  - 憑證盲:HostSpec 不帶任何 secret;event/log 不含憑證;secret-scan clean。
- Out-of-scope（明確不做）:
  - 完整 NemoClaw agent / 真 inference(需 LLM key);WebSocket dashboard 互動。
  - 把 live e2e 放進 verify(維持 hermetic)。

## (4) Design delta + 依賴方向
- harness + gated e2e;消費 S10 transport + 真 OpenShell adapter。e2e 為 *.test.ts(depcruise 排除);harness 為 script。

## (5) Test-first plan（RED 先行）
- 先寫 live e2e;`AGENTOS_LIVE_NEMOCLAW_SANDBOX` 設但 sandbox 不存在 → exec reject → hostAgent denied → 測試 FAIL(RED:真打真 OpenShell)。
- 真 OpenShell sandbox 起後 → 綠。
- 無 env → skip(verify hermetic)。

## (6) Definition of Done（待實測填 — live 段待使用者提供 OpenShell）
- [ ] harness preflight:無 docker/openshell → BLOCKED-diagnostic + exit 0(不 hang)。
- [ ] `pnpm run verify` exit 0(gated live e2e SKIP;harness 不入 verify)。
- [ ] (live,使用者提供 OpenShell 後)`pnpm run e2e:live-nemoclaw` exit 0:真 OpenShell sandbox → hostAgent ok + GATEWAY_PID → status running(探對埠)→ reconcile ok → 清理。
- [ ] secret-scan clean;HostSpec/event 無憑證。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:probe 探錯埠 → status 非 running 紅;exec denied 偽造 ok → fail-closed 紅)。
- [ ] **誠實回報**:live 跑surface 的任何 shape 落差(gateway_user/HERMES_HOME/launch)逐一記錄 + 修(各加 hardening 測試)。

## (7) Rollback
- `git revert <merge-sha>`(移除 harness + live e2e)。

## (8) Depends-on / blocks
- Depends-on:**R11-NC-S10**(真實 transport + probe-port 修正)、真實 OpenShell daemon(**使用者提供**)。
- Blocks:無(收尾 NemoClaw live)。
- **誠實前提**:live 跑在 OpenShell 就緒前 BLOCKED;不偽造,gated skip 保 verify 綠。
