# SLICE-DHB1: DesktopHermesTurnSource — 本機 desktop Hermes 經 Brain Port 提案（in-repo seam）

- **Phase**: R11-family（live brain runtime 整合;真 endpoint 綁定 = DHB2/live）
- **Branch**: slice/dhb1-desktop-hermes-turnsource
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；TS only;新增依賴 = 0（用內建 fetch/WebStreams,真 endpoint 綁定留 DHB2）
- **狀態**: **DRAFT**

## (0) 動機 + 現況 + ⚠️ 誠實分界（grounded）
接縫已在(`src/runtime/brain/adapters/hermes/shim.ts`):`HermesTurnSource.turns(intent)→AsyncIterable<HermesTurn>` 是注入式 transport seam,今日只有 `ScriptedTurnSource`。`HermesTurn` **無 api_key 欄位**(credential 通道結構性剝除);`HermesBrainShim` 把 turn→BrainEvent fail-closed;`screenBrainEvent` 在偷渡 secret 時 deny。**唯一缺口 = 連本機 desktop Hermes 的真 `HermesTurnSource`。**
- **整合接面已查實 = ACP**(本機 desktop Hermes v0.17.0 已裝;`hermes acp` = Agent Client Protocol,JSON-RPC over stdio,editor-integration 接面)。
- **DHB1(in-repo 可達成)**:`DesktopHermesTransport` port(抽象化 ACP `session/update` 幀流)+ `DesktopHermesTurnSource implements HermesTurnSource`(ACP update→`HermesTurn`)+ **Fake transport**(腳本化 ACP 幀)證接縫 + contract test。
- **DHB1 誠實不宣稱**:**未** launch 真 `hermes acp` 子進程(real subprocess + 確切 ACP 訊息 dialect 對映 + propose-only live = DHB2)。DHB1 宣稱的是 **① 接縫到位(Fake ACP transport 下 turn→BrainEvent→治理全鏈綠)② credential-blind 結構性保持 ③ fail-closed**。

## (1) ID + Title
SLICE-DHB1 —（a)`DesktopHermesTransport` port:`submit(intent: string): AsyncIterable<AcpUpdateFrame>`(把 intent 交給本機 Hermes ACP、串回 `session/update` 幀;**只送 intent 文字 + AgentContext-derived 識別,絕不送 Agent OS secret**);(b)`parseFrame(raw): HermesTurn`(把 ACP update〔agent message chunk → planText、tool_call → toolCalls〕對映;只取 planText/toolCalls/memoryOps/skillOps;**忽略任何 api_key/credential 欄位**,malformed → 略過該幀 fail-closed);(c)`DesktopHermesTurnSource implements HermesTurnSource`(包 transport + parser,`turns(intent)` 串 `HermesTurn`);(d)`FakeDesktopHermesTransport`(in-tree,腳本化 ACP 幀,含「夾帶 api_key/字面 secret」的對抗幀)證接縫;(e)contract test + gated live e2e 骨架 `e2e:live-desktop-hermes`(gate on `hermes` binary + `AGENTOS_LIVE_DESKTOP_HERMES=1`;缺 → clean BLOCK,exit 0;**不在 verify 內**)。

## (2) Goal（一句話）
補上連「本機 desktop Hermes」的真 `HermesTurnSource`——讓桌面 Hermes 的 turn 經既有 `HermesBrainShim`→`BrainEvent`→`runGovernedToolCall` 受治理,credential-blind 與 fail-closed 結構性保持;真 endpoint 綁定留 DHB2。

## (3) In-scope / Out-of-scope
- In-scope:
  - `DesktopHermesTransport` port + `AcpUpdateFrame`(寬鬆 raw ACP `session/update` 形狀;parser 只取已知欄位)。
  - `DesktopHermesTurnSource implements HermesTurnSource`(`src/runtime/brain/adapters/hermes/desktop.ts` 或 `adapters/hermes/desktop/`;經 hermes adapter barrel 匯出)。
  - `parseFrame`:ACP update→`HermesTurn`(agent message chunk→planText、tool_call→toolCalls),**只讀 planText/toolCalls/memoryOps/skillOps**;任何 credential/api_key 欄位**永不讀入**;malformed 幀略過(fail-closed,不中毒整串)。
  - `FakeDesktopHermesTransport`(in-tree,腳本化 ACP 幀 + 對抗幀:夾帶 api_key、字面 secret、malformed)。
  - contract test:Fake transport → `DesktopHermesTurnSource` → `HermesBrainShim` → BrainEvent 串,經 `governBrainStream`/`screenBrainEvent`:正常 turn → 治理通過;夾帶字面 secret 的 tool-call → **denied@screen 並停串**;transport throw/ malformed → fail-closed(停串、不 yield ok);api_key 幀 → **絕不出現在任何 BrainEvent**(結構 + 內容雙證)。
  - gated live e2e 骨架:`scripts/e2e-live-desktop-hermes.sh` + `e2e:live-desktop-hermes`(gate on `hermes` binary 在 PATH + `AGENTOS_LIVE_DESKTOP_HERMES=1`;缺 → `BLOCKED` exit 0;**不在 `pnpm run verify` 內**;DHB1 只是骨架,真 ACP launch 留 DHB2)。
  - `pnpm run verify` 綠;depcruise(no-vendor-in-core:此檔在 `brain/adapters/hermes/` 內,合規;經 barrel)、secret-scan clean。
- Out-of-scope（誠實標記,= DHB2/live）:
  - **launch 真 `hermes acp` 子進程**(JSON-RPC over stdio handshake:initialize→session/new→session/prompt→session/update;以 `hermes acp --check`/實跑對映確切 ACP dialect)= DHB2,需本機跑 app(已裝 ✓)。
  - **propose-only / permission 模式由 client 主導的 live 證明** = DHB2。
  - 改 `HermesBrainShim`/`HermesTurn`/Brain Port/screen(直接重用,不動)。
  - OpenShell 路徑(本垂直接的是 desktop 本機 gateway,**非** OpenShell sandbox 內 gateway;那是既有 `e2e:live-hermes`)。

## (4) Design delta + 依賴方向
- 新 port + 1 真 impl + 1 Fake + parser;**`HermesTurnSource` 介面不變**(`DesktopHermesTurnSource` 實作它)。`HermesBrainShim`/screen/pipeline 不動。無新依賴(transport 真實作的 ACP stdio 子進程 launch 留 DHB2;DHB1 用 Fake ACP transport)。
- **依賴方向**:`desktop.ts` 在 `src/runtime/brain/adapters/hermes/` 內(vendor adapter 區,depcruise no-vendor-in-core 合規);經 hermes adapter barrel 對外。
- **PUBLIC**:`DesktopHermesTransport`、`DesktopHermesTurnSource`、`e2e:live-desktop-hermes`(骨架)。

## (5) Test-first plan（RED 先行）
- contract test 在 `DesktopHermesTurnSource`/`parseFrame`/`DesktopHermesTransport` 前紅(`undefined`)。
- 正常幀:Fake transport 腳本化 plan+tool(bundleRef args)→ BrainEvent 串經治理通過。
- 對抗幀①:tool-call args 夾**字面 secret** → `governBrainStream` **denied@screen 停串**。
- 對抗幀②:幀帶 `api_key`/credential 欄位 → 該欄位**不出現在任何 BrainEvent**(parser 不讀)。
- 對抗幀③:transport `submit` throw / 回 malformed 幀 → **fail-closed**(停串、不 yield ok event)。
- gated live 骨架:無 `AGENTOS_DESKTOP_HERMES_ENDPOINT` → 腳本印 `BLOCKED` exit 0(不跑、不假綠)。

## (6) Definition of Done（待實測填）
- [ ] RED:port/TurnSource/parser 前紅。
- [ ] `pnpm run verify` exit 0(contract test 綠;depcruise no-vendor-in-core 合規;secret-scan clean;`e2e:live-desktop-hermes` **不在** verify 內)。
- [ ] **接縫**:Fake transport → `DesktopHermesTurnSource` → `HermesBrainShim` → BrainEvent 串受治理通過;mutation(TurnSource 不經 parser 直吐 raw)→ 測試紅。
- [ ] **credential-blind 結構性保持**:api_key/credential 幀欄位**永不**入 BrainEvent(parser 只讀 4 個已知欄位);字面 secret 的 tool-call → denied@screen 停串;mutation(parser 讀 api_key / 透傳)→ 對抗測試紅。
- [ ] **fail-closed**:transport throw/ malformed 幀 → 停串、不 yield ok;mutation(malformed 仍 yield)→ 紅。
- [ ] **gated live 骨架**:缺 endpoint → clean BLOCK exit 0(不假綠);**誠實標記** DHB1 未綁真 endpoint。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:parser 透傳 api_key、malformed 不 fail-closed、secret 不被 screen 擋)。

## (7) Rollback
- `git revert <merge-sha>`(新 port + impl + Fake + parser + 骨架腳本)。`HermesBrainShim`/screen/pipeline 不受影響。

## (8) Depends-on / blocks
- Depends-on:R11-S2(`HermesBrainShim`/`HermesTurnSource`/`HermesTurn`)、Brain Port(port.ts)、credential-guard(`screenBrainEvent`/`governBrainStream`)、R9-S1(bundleRef-only credential-blind 慣例)。
- Blocks:**DHB2**(綁真 desktop Hermes local gateway + propose-only live 證明)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:DHB1 證接縫 + credential-blind + fail-closed(Fake transport 下);綁真 desktop Hermes endpoint/protocol + propose-only live = DHB2,需你本機跑 app + 確認其 local API。
