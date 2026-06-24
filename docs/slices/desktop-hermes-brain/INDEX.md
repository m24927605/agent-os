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

## 1. ⚠️ 誠實未知（決定 in-repo vs live）
- **desktop Hermes 的 local API(endpoint/protocol/auth/request-response 形狀)未知**——marketing 頁未列;需從桌面版**官方 docs 或實跑的 app** 確認。故 DHB1 把 adapter 設計在 **`DesktopHermesTransport` port + parser** 後面(API-shape-agnostic),用 **Fake transport** 在 in-repo 證接縫;真 endpoint 綁定 = DHB2/live。
- **brain 必須是「propose-only」**:Agent OS 模型裡 brain 只**提案**,effect 走 Agent OS 的治理管線 + substrate(OpenShell/Fake)。需確認 desktop Hermes 能以「只回提案 turn、不自行執行」模式運作(或我們只取其提案、忽略其自帶執行)。= DHB2 確認項。
- **credential-blind 邊界**:adapter **絕不**把 Agent OS 的 secret 送進 Hermes,**絕不**把 Hermes 的 api_key 讀進 BrainEvent(`HermesTurn` 無此欄位)。Agent OS 的 secret 留 Agent OS 側;Hermes 的 model key 留 Hermes 側。

## 2. 切片分解
| Slice | 範圍 | 狀態 |
|---|---|---|
| **DHB1**(in-repo seam) | `DesktopHermesTransport` port(submit intent → stream raw turn frames)+ `DesktopHermesTurnSource implements HermesTurnSource`(raw→`HermesTurn`,credential-blind:不讀/不轉 api_key、不送 Agent OS secret)+ **Fake transport** 證接縫 + contract test(turn→BrainEvent 經 `HermesBrainShim`;transport throw/ malformed → fail-closed;偷渡 secret → denied@screen)+ gated live e2e 骨架(`e2e:live-desktop-hermes`,缺 app/endpoint → clean BLOCK)| DRAFT(先建)|
| **DHB2**(live,gated) | 綁真 desktop Hermes local gateway(確認 endpoint/protocol/propose-only 模式)+ live 證明(intent → 桌面 Hermes 提案 → 治理 → effect)。**需你本機跑 desktop Hermes + 確認其 local API** | OPEN(待 API 確認 + 環境)|

## 3. 待你提供（影響 DHB2,不影響 DHB1)
desktop Hermes 的 **local gateway endpoint + protocol**(HTTP/WS?路徑?如何提交 intent、如何串回 turn、是否有 propose-only 模式)。DHB1 的 transport port + parser + Fake **不需**此資訊即可建並 in-repo 證;DHB2 綁真 endpoint 才需。

## 4. 交付順序
DHB1(in-repo:transport port + 真 TurnSource + Fake + contract test + gated live 骨架)→(待你確認 desktop Hermes local API + 本機跑起來)DHB2(live 綁定)。每刀 doc-first + RED + `pnpm run verify` 綠 + 獨立 Opus 4.8 review + merge。
