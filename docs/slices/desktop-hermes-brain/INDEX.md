# Desktop Hermes → Brain Port（本機桌面 Hermes 驅動 Agent OS）— INDEX

> 2026-06-24。目標:讓**使用者本機跑的 desktop Hermes**(`hermes-agent.nousresearch.com` 桌面版,
> macOS/Windows/Linux,MIT v0.17.0)當 Agent OS 的 **brain**——它的 turn 經既有 `HermesTurnSource` 接縫
> → `HermesBrainShim` → `BrainEvent` → **同一條 `runGovernedToolCall`**(screen→authorize→cost→
> commit-before-effect→effect)。**與 `e2e:live-hermes` 不同**:那條 adopt 的是「OpenShell sandbox 內的
> Hermes gateway」;本垂直接的是「**本機 desktop Hermes 的 local gateway**」(桌面版沙箱後端是
> local/Docker/SSH/Singularity/Modal,**不含 OpenShell**)。

## 0. ⚠️ 接縫已在、缺真實作（grounded）
- Brain Port(`src/runtime/brain/port.ts`):`BrainEvent` = PlanStep|ToolCall|MemoryMutation|SkillMutation,brain **UNTRUSTED + credential-blind**(args 只放 `bundleRef`、never 字面 secret)、never denies、never 寫 WORM。
- 既有接縫(`src/runtime/brain/adapters/hermes/shim.ts`):
  - `interface HermesTurn { planText?, toolCalls?, memoryOps?, skillOps? }` —— **刻意無 `api_key` 欄位**(Hermes 自管的 client-held credential 通道,結構性剝除,永不流入 BrainEvent)。
  - `interface HermesTurnSource { turns(intent: string): AsyncIterable<HermesTurn> }` —— **注入式 transport 接縫**,今日只有 `ScriptedTurnSource`(測試 double)。
  - `class HermesBrainShim`:turn→BrainEvent,**fail-closed**(malformed ctx → 不 yield;throwing source → 停串、deny-by-default)。
- screen(`src/runtime/brain/credential-guard.ts`):`screenBrainEvent`/`governBrainStream` 在 brain 偷渡字面 secret 時 **deny 並停串**(detector 報錯也 deny)。

→ **唯一缺口**:一個連「本機 desktop Hermes local gateway」的**真 `HermesTurnSource`**(把 Hermes 的 turn 串轉成 `HermesTurn`),其餘治理鏈現成。

## 1. ✅ 整合接面 = ACP（已在本機查實,2026-06-24）
本機已裝 desktop Hermes v0.17.0(`~/.local/bin/hermes`,project `~/.hermes/hermes-agent`)。查 CLI 接面後,**程式化接面確定 = `hermes acp`(Agent Client Protocol)**:
- `hermes acp` = "Start Hermes Agent in **ACP mode for editor integration (VS Code, Zed, JetBrains)**" —— **JSON-RPC over stdio**:client(= Agent OS)launch 子進程 → `initialize` → `session/new` → `session/prompt(intent)` → 串回 `session/update`(agent message chunk + **tool_call** update)。這正是「client 驅動 agent、串流 tool-call」的標準接面,直接對映 `HermesTurn`(planText/toolCalls/…)。`hermes acp --check` 可驗依賴/adapter。
- 其他接面**較不適合**:`hermes -z PROMPT`(一次性、文字輸出,無結構化 tool-call 串);`hermes proxy start`(本機 OpenAI-compatible HTTP,只有 chat-completions,無 agent tool-call 串);messaging gateway(走 unix socket,接 Telegram/Discord/…,非程式化 brain 接面)。
- **propose-only**:ACP 把控制權交給 client——Agent OS 收到 `tool_call` update 後,由**自己的治理管線**(screen→authorize→cost→commit→effect + 自己的 substrate)決定是否執行,而非讓 Hermes 自跑。需在 DHB2 確認 Hermes ACP 的 permission/tool 模式可由 client 主導。
- **credential-blind 邊界**:adapter **只送 intent prompt**,**絕不**把 Agent OS 的 secret 送進 Hermes;Hermes 的 model key 留在 `~/.hermes`(`.env`/`auth.json`,**我們從不讀**);ACP 的 tool_call → `HermesTurn.toolCalls`(`HermesTurn` 無 api_key 欄位 → 結構性剝除),字面 secret 仍由 `screenBrainEvent` 擋。

## 2. 切片分解
| Slice | 範圍 | 狀態 |
|---|---|---|
| **DHB1**(in-repo seam) | `DesktopHermesTransport` port(submit intent → stream **ACP `session/update` 幀**)+ `DesktopHermesTurnSource implements HermesTurnSource`(ACP update→`HermesTurn`,credential-blind:不讀/不轉 api_key、不送 Agent OS secret)+ **Fake transport**(腳本化 ACP 幀 + 對抗幀)證接縫 + contract test(turn→BrainEvent 經 `HermesBrainShim`;transport throw/ malformed → fail-closed;偷渡 secret → denied@screen)+ gated live e2e 骨架(`e2e:live-desktop-hermes`,缺 `hermes`/gate → clean BLOCK)| ✅ **DONE**(seam + credential-blind〔結構+內容〕+ fail-closed,mutation 證實;接縫三檔未動;獨立 Opus4.8 review PASS)|
| **DHB2a**(in-repo) | `AcpStdioTransport implements DesktopHermesTransport`:spawn `hermes acp` + JSON-RPC over stdio(initialize→session/new→session/prompt→session/update)+ propose-only(`session/request_permission` 一律 deny、只擷取提案)+ fail-closed + credential-blind;**用 fake `hermes acp` 子進程單元測**(verify 內,不花 credits)。spec:`DHB2-real-acp-stdio-transport.md` | ✅ **DONE**(真子進程 ACP-stdio + propose-only + fail-closed + credential-blind〔wire+child-env〕+ fs/terminal `-32601` deny,mutation 證實;11 tests;DHB1/seam 未動;獨立 Opus4.8 review PASS + 採納 M1/M2)|
| **DHB2b**(live,gated,**user-initiated**) | 對**真 `hermes acp` + 你已認證的 Hermes** 跑 `e2e:live-desktop-hermes`:確認確切 ACP dialect(`--check`)+ propose-only + intent→提案→治理→effect 全鏈。**用你 Hermes 的 model credits/credentials → 由你親跑**(設 `AGENTOS_LIVE_DESKTOP_HERMES=1`) | ✅ **DONE + LIVE 通過(2026-06-24)**:harness〔gated live test + 升級腳本,skip-under-verify load-bearing + 非空 guard,獨立 Opus4.8 PASS〕+ **真 `hermes acp` live drive 綠**(≥1 frame、tool-call 提案 "write: hello.txt"、propose-only 無檔被建、credential-blind;**M3/M4 dialect 全中無需修**:id=number、protocolVersion 1、hermes-agent 0.17.0)|
| **DHB3a**(in-repo) | **閉合 agentic loop**(Design B,對話式結果回饋):multi-turn DRIVER(管線之上)把提案→`runGovernedToolCall`→`GovernedOutcome` 經 redactSecrets 序列化→經 ACP 後續 `session/prompt(sessionId,…)` 回 Hermes→續推到 stopReason/`maxTurns`;transport 多輪化(保持 child+session、保留 propose-only deny)。**Fake `hermes acp`+FakeSandbox 證**6 不變量 + turn cap(verify 內,無 credits)。spec:`DHB3-closed-agentic-loop.md` | ✅ **DONE**(duplex transport〔openSession,one-shot submit 未動〕+ `runClosedLoop` DRIVER〔maxTurns=12、redactSecrets、重用 runGovernedToolCall〕;6 不變量 + duplex fail-closed mutation 證實;pipeline/guard EMPTY-diff;961 tests;獨立 Opus4.8 review PASS + 採納 MINOR)|
| **DHB3b**(live,**user-initiated**) | 綁真 `hermes acp 0.17.0` 的**回饋邊 dialect**(同 sessionId 重 prompt tool-result 是否續推 / 沿用脈絡 / propose-only enum);dialect 分歧 → fail-closed 診斷,絕不退化讓 Hermes 自跑。**用你 credits → 由你親跑** | OPEN(待 DHB3a + 你親跑)|

## 3. ✅ 整合接面已查實(ACP);DHB2 待 live 綁定
接面不再是未知:`hermes acp`(JSON-RPC over stdio)。DHB1 的 transport port + parser + Fake 把 ACP 幀形狀抽象化、in-repo 證接縫(不啟動真 `hermes acp`);DHB2 才 launch 真子進程 + 以 `hermes acp --check`/實跑對映確切 ACP 訊息 dialect + 證 propose-only。本機 desktop Hermes 已安裝(v0.17.0)。

## 4. 交付順序
DHB1(in-repo:ACP transport port + 真 TurnSource + Fake + contract test + gated live 骨架)→ DHB2(live:綁真 `hermes acp` 子進程)。每刀 doc-first + RED + `pnpm run verify` 綠 + 獨立 Opus 4.8 review + merge。
