# SLICE-HERMES-S1: adopt a user-provisioned Hermes sandbox + host the REAL Hermes gateway (live)

- **Phase**: Hermes vendor-live（full-fidelity:我們的 AgentHosting adapter host **真實 Hermes gateway**)
- **Branch**: slice/hermes-s1-adopt-and-host
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day（不含 onboard/gateway）；net LOC <~180（adopt 路徑 + 測試 + gated live e2e + harness）、新增依賴 = 0
- **狀態**: **DRAFT**

## (1) ID + Title
SLICE-HERMES-S1 — 讓 `OpenShellSandboxAdapter` 能 **adopt 一個外部建立的 sandbox**(`GetSandbox(name)`→refById),使我們的 `NemoClawAgentHosting` 能對**使用者經 `nemohermes onboard` 建立的真實 Hermes sandbox** 做 getAgentStatus / reconcile(以及視情況 launch)真實 **Hermes gateway**(`hermes ... dashboard/gateway run`,/health:18789)。**credential 邊界**:LLM key 全程留在使用者端(onboard 寫入 sandbox 的 `/sandbox/.hermes`);我們的 `HostSpec`/adapter/event/reason **不帶任何 secret**。

## (2) Goal（一句話）
證明我們的 hosting adapter 治理的是**真實 vendor agent(Hermes)**,不只是 trivial stub:對真實運行的 Hermes gateway 觀測 running + reconcile(必要時 launch),並誠實 surface 真實 gateway 命令的任何 shape 落差。

## (3) In-scope / Out-of-scope
- In-scope:
  - **adopt 路徑**(`src/runtime/openshell/adapter.ts`):`async adoptSandbox(ctx, name): Promise<AdapterResult>` — 呼叫 `transport.getSandbox({name})` → 取 `{name, id}` → `refById.set` → ok;getSandbox 失敗/無 id/無 sandbox → deny(fail-closed)。理由:Hermes sandbox 由 onboard **外部建立**,我們的 refById 由 createSandbox 填(OS-S2a),adopt 補上「採納既有 sandbox」的真實 GetSandbox 路徑(production-real,非 test seed)。
  - 單元測試(fake transport):adopt(getSandbox 回 {name,id})→ refById 填入 → 之後 status/exec 用同一 adapter 無需 seed;getSandbox 回空/錯 → deny。
  - **gated live e2e**(gated on `AGENTOS_LIVE_HERMES_SANDBOX`=使用者的 sandbox 名):`adapter.adoptSandbox(ctx, name)` → `host.getAgentStatus(ctx, sandboxId)` → `phase==='running'`(真實 Hermes gateway /health:18789=200)→ `reconcileAgentProcess('health-probe')` ok。**launch 測試(視 live 解析)**:若要證 launch,先停既有 gateway 再 `hostAgent`(gatewayCommand = 真實 Hermes 啟動,**live 解析**:`nemoclaw-start` 或 `"$AGENT_BIN" dashboard --port 18789 …`,AGENT_BIN=/usr/local/bin/hermes,runtime.ts:170/186/254)。
  - harness `scripts/e2e-live-hermes.sh`:preflight `docker info`(設 `DOCKER_HOST=unix:///var/run/docker.sock`)+ `command -v openshell` + `AGENTOS_LIVE_HERMES_SANDBOX` 是否設 → 任一缺 → BLOCKED-diagnostic + exit 0;齊備 → 跑 gated vitest(**不 create/delete sandbox**——由使用者 onboard 管理,我們只 adopt + 觀測,不刪使用者的 sandbox)。
- Out-of-scope:
  - `nemohermes onboard`(使用者跑)、Hermes 映像 build、LLM key 處理 — 全在使用者端;我們不碰 key。
  - 真實 inference(chat turn)——那是 NemoClaw/Hermes 本身的測試,非我們 AgentHosting port 的契約。
  - 刪除使用者的 Hermes sandbox(我們只 adopt + 觀測;不 destroy 使用者資產)。

## (4) Design delta + 依賴方向
- adapter 加 `adoptSandbox`(真實 GetSandbox 採納外部 sandbox);hosting 路徑/transport 不改。grpc-js 仍限 runtime/openshell。depcruise 綠。
- **PUBLIC**:`OpenShellSandboxAdapter.adoptSandbox(ctx, name)`。

## (5) Test-first plan（RED 先行）
- adopt 單元(fake transport):adoptSandbox 不存在 → RED;getSandbox→refById→ok;空/錯→deny。
- live e2e:對未 adopt 的 sandbox → status unknown-sandbox;adopt 後對真實 Hermes gateway → running。對未起 gateway/錯 sandbox → fail。
- 我對使用者的 Hermes sandbox 跑 `pnpm run e2e:live-hermes`。

## (6) Definition of Done（待實測填 — live 段待使用者提供 Hermes sandbox）
- [ ] RED:adopt/live 測試在實作前紅。
- [ ] `pnpm run verify` exit 0(gated live SKIP;adopt 單元測試綠;depcruise/secret-scan clean)。
- [ ] **live(我跑,使用者 onboard 後)`pnpm run e2e:live-hermes` exit 0**:adopt → getAgentStatus **running**(真實 Hermes gateway)→ reconcile ok(視解析:+ launch 真實 gateway)。
- [ ] credential-blind:HostSpec/event/reason 無 secret;我們不讀/不存 key;secret-scan clean。
- [ ] **不破壞使用者資產**:harness/測試**不 delete** 使用者的 Hermes sandbox。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:adopt 不填 refById → status unknown-sandbox 紅;getSandbox 空→adopt deny 紅)。
- [ ] **誠實回報**:真實 Hermes gateway 命令的任何 shape 落差(AGENT_BIN/HERMES_HOME/dashboard flags)逐一記錄 + 修 + hardening。

## (7) Rollback
- `git revert <merge-sha>`(移除 adoptSandbox + live e2e + harness)。既有 create/exec/lifecycle 不受影響。

## (8) Depends-on / blocks
- Depends-on:OS-S1/OS-S2a/OS-S2b(完整 transport)、NC-S11b(hosting/binding)、**使用者經 `nemohermes onboard` 提供的 Hermes sandbox**(DOCKER_HOST=OrbStack;NVIDIA API-key mode)。
- Blocks:無。
- **誠實前提**:live 需使用者的 Hermes sandbox(我跑);verify hermetic;key 全程在使用者端。
