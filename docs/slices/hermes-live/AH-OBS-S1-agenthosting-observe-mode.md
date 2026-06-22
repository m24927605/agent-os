# SLICE-AH-OBS-S1: AgentHosting observe+reconcile 模式（特權-gateway vendor）

- **Phase**: AgentHosting port 能力擴充(把 Hermes live 發現變成設計)
- **Branch**: slice/ah-obs-s1-observe-mode
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；net LOC <~180（port `mode` + adapter observe 分支 + 測試 + gated live e2e）、新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8 + live-test staging=main-loop/Opus4.8;獨立 Opus4.8 reviewer = PASS,零 finding;observe 模式對真實運行 gateway live 驗證〔4/4〕）

## (0) 動機（Hermes live 發現,a4311a7）
真實 NemoClaw/Hermes gateway 由 **root entrypoint(`nemoclaw-start`)降權到特權 `gateway` user** 啟動;我們 adapter 以非-root `sandbox` user exec → **無法 launch**(hermes 二進位 Permission denied)。我們現有 `hostAgent`「以 exec launch gateway」模型只適用**簡單/可由 sandbox user 跑的 gateway**(如 python-stub),不適用真實特權-gateway vendor。**設計回應**:加一個 observe 模式——gateway 由 substrate/entrypoint 啟動,我們**只 observe(probe /health)+ reconcile**,不 launch。

## (1) ID + Title
SLICE-AH-OBS-S1 — 在 `AgentHosting` port + `NemoClawAgentHosting` adapter 加 **`HostSpec.mode: 'launch' | 'observe'`**(預設 `'launch'`,完全向後相容)。`'observe'` 模式下 `hostAgent` **不執行 launchCommand**,而是 probe `/health` 確認 substrate/entrypoint 已啟動的 gateway 在跑;`reconcileAgentProcess('restart')` 在 observe 模式 **fail-closed denied**(lifecycle 由 substrate 擁有),`'health-probe'` 照常 probe。

## (2) Goal（一句話）
讓我們的治理 adapter 能正確治理**特權-gateway vendor**(真實 NemoClaw/Hermes):承認 gateway 由 substrate 啟動,我們 observe + health-reconcile,而非試圖以非-root exec launch(那會 Permission denied)。

## (3) In-scope / Out-of-scope
- In-scope:
  - **port**(`src/hosting/port.ts`):`HostSpec` 加 `readonly mode?: 'launch' | 'observe'`(預設 `'launch'`)。docs 註明 observe = substrate/entrypoint 啟動 gateway、我們不 launch。
  - **adapter**(`src/hosting/adapters/nemoclaw/adapter.ts`):
    - `hostAgent`:`mode==='observe'` → 跳過 `launchCommand`/`parseGatewayPid`;改 `dispatch(probeCommand(dashboardPort))` → `phaseFromProbe`;`running` → 註冊 agent(記 `mode:'observe'`)+ 回 `ok`(`agentProcessId` = 非-PID sentinel,如 `"observed"`,誠實:我們不擁有該 process);非 `running` → **denied**「agent not running (observe mode: substrate/entrypoint owns gateway launch, fail-closed)」。`launch` 模式行為**完全不變**。
    - `reconcileAgentProcess`:讀註冊的 `mode`;`mode==='observe'` 且 `action==='restart'` → **denied**「restart unsupported in observe mode (gateway lifecycle owned by the substrate entrypoint)」(fail-closed);`'health-probe'` 兩模式皆 probe;`launch` 模式 restart 行為不變。
    - `getAgentStatus`:不變(本就 probe)。registry entry 加 `mode`。
  - 單元測試(fake CommandSink):observe hostAgent(probe 200/401→ok+sentinel、註冊 mode;probe 非-running→denied,**且 sink 未收到 launch 指令**——證明沒 launch);observe reconcile restart→denied、health-probe→probe;launch 模式既有測試**全不變綠**。
  - **gated live e2e**(沿用既有 openshell gateway):create sandbox → **setup-exec 預啟一個 trivial /health gateway**(模擬 substrate/entrypoint 啟動)→ `hostAgent({mode:'observe'})` → ok(observe 到 running,**未自行 launch**)→ getAgentStatus running → reconcile('health-probe') ok → reconcile('restart') **denied**。
- Out-of-scope:
  - 真實特權 Hermes gateway 的 live(仍 BLOCKED on vendor 版本 skew + JWT;observe 模式用 trivial entrypoint-launched gateway 證明契約)。
  - observe 模式的 restart **實作**(signal supervisor 等)——本刀 restart 在 observe 模式為 deny(誠實:不支援,非偽裝);未來可加真實 substrate-restart。

## (4) Design delta + 依賴方向
- 純加 port 欄位 + adapter 分支;`launch` 模式 byte-compatible。無新依賴。depcruise 不受影響。
- **PUBLIC**:`HostSpec.mode?`;observe 模式語意。

## (5) Test-first plan（RED 先行）
- observe hostAgent 單元(mode 不存在/分支未實作 → RED):probe-running→ok+sentinel、sink 無 launch 指令;probe-not-running→denied。
- observe reconcile restart→denied(RED 先)。
- live e2e:setup-exec 預啟 gateway → hostAgent(observe)→running;對未預啟→denied。
- 我對真實 openshell sandbox 跑 `pnpm run e2e:live-nemoclaw`(或新增 observe live 檔)。

## (6) Definition of Done（實測）
- [x] RED:observe hostAgent/reconcile 測試在實作前紅(6 failed:observe 分支不存在 → 走 launch 路徑/無 sentinel)。
- [x] `pnpm run verify` **exit 0**(850 passed + 10 skipped;observe 單元 6/6 + launch 模式既有 18/18 **不變**綠;depcruise 126 modules clean;secret-scan clean)。
- [x] **observe 不 launch**:單元證明 observe hostAgent 的 CommandSink 只收到 probe、**從未收到 launchCommand**(reviewer mutation:observe fall-through 到 launch → 該斷言紅,記到 nohup/gosu 指令)。
- [x] observe restart fail-closed denied(reviewer mutation:observe restart 路由到 launch-restart recoveryCommand → 測試紅 + 記到 pkill+relaunch);`"observed"` sentinel(非 PID)。
- [x] **live(我對真實 gateway 跑)`pnpm run e2e:live-nemoclaw` 4/4**:gateway 由 out-of-band 啟動(此處 prior launch-mode test;production 為 substrate root entrypoint——正是 Hermes case)→ hostAgent(observe) 觀測 running → ok `"observed"`(**未自行 launch**)→ getAgentStatus running → reconcile health-probe ok / **restart denied**。(staging 修正:observe 觀測同 sandbox 已運行的 gateway,避開新啟動的 port 爭用。)
- [x] credential-blind(deny reason 靜態、無 endpoint/cert);launch 模式向後相容(additive +124/-0,adapter.test.ts 零改動)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8,零 finding;never-launch / not-running-denied / restart-denied 三 mutation 皆非 vacuous;honest restart-deny 非 fake-green;8 攻擊面 HELD/N/A)。
> **設計成果**:Hermes live 揭露的「特權-gateway 由 root entrypoint 啟動、我們非-root exec 無法 launch」缺口,已成為 port 的正式 observe 模式(substrate 啟動 → 我們 observe+health-reconcile)。真實 substrate-restart(observe 模式)為後續。

## (7) Rollback
- `git revert <merge-sha>`(移除 `mode` 欄位 + observe 分支)。launch 模式不受影響、可逆。

## (8) Depends-on / blocks
- Depends-on:R11-S1(NemoClawAgentHosting)、NC-S11b(CommandSink/probe)、Hermes live 發現(a4311a7)。
- Blocks:無(未來「observe-mode 真實 substrate-restart」+ 對真實 Hermes 的 observe live〔待 vendor 版本對齊〕)。
- **誠實前提**:observe 模式用 trivial entrypoint-launched gateway live 證明契約;真實特權 Hermes gateway 的 observe live 待 vendor skew 解。
