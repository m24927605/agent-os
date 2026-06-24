# SLICE-DHB3: 閉合 agentic loop — desktop Hermes propose → 治理執行 → 結果回饋 → 續推（多輪）

- **Phase**: R11-family（live brain runtime;真 dialect = DHB3b/live）
- **Branches**: slice/dhb3a-closed-loop（in-repo)、slice/dhb3b-live-closed-loop（live）
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: DHB3a <= 1–1.5 day（TS only）；DHB3b = live 驗證(user-initiated)
- **狀態**: **DHB3a DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS;6 不變量 + duplex fail-closed 經 mutation 證實;pipeline/guard EMPTY-diff;真 Hermes 回饋-邊 dialect=DHB3b/live）。**DHB3b OPEN**(live,user-initiated)。

## (0) 動機 + 現況 + ⚠️ 誠實分界（grounded,設計探索 task wdv6ncux1)
DHB1/2 已 live 證:desktop Hermes 經 ACP 驅動 Agent OS,但**單向、propose-only 一次性**——`AcpStdioTransport.submit(intent)` 做一次 `initialize→session/new→session/prompt`,prompt 一 resolve(stopReason)就 `channel.end()` + `finally` SIGKILL child(acp-stdio.ts:309-353);`HermesTurnSource.turns(intent)` intent 進、turn 出(shim.ts:63-65、desktop.ts:120-129)。Agent OS **擷取+治理**提案,但**不執行、不把結果回饋**。DHB3 = **閉環**:propose → 治理 → **執行 governed effect(Agent OS 自己的 substrate)** → 結果經 ACP 回 Hermes → 續推,到任務終止。
- **結果物件已存在**:`runGovernedToolCall` 回 `GovernedOutcome = {status:"executed",reservationId,receipt,detail?} | {status:"denied",stage,reason}`(pipeline.ts:48-50,101-106);effect 回 `EffectResult{ok,detail?,tokensUsed?}`(pipeline.ts:31);effect 跑 Agent OS 自己的 substrate(developer/bootstrap.ts:253-257)。
- **誠實分界**:DHB3a(in-repo,Fake-proven,verify 內)證**整個多輪閉環 + 治理整合 + redaction + turn cap + 6 不變量**——對 in-tree fake `hermes acp` + FakeSandboxAdapter。**不**證真 Hermes dialect。DHB3b(live,user-initiated)綁真 `hermes acp 0.17.0` 的**回饋邊 dialect**(見 §3)。
- **另一個真 blocker(誠實標記)**:substrate port(src/runtime/substrate/port.ts:46-51)目前**只有 lifecycle 方法、無 exec/run/invoke primitive**——governed effect 能建 sandbox 但**還沒有「跑命令拿輸出」的真結果**。故 DHB3a 用 Fake effect 的 canned 結果;真命令輸出回饋需 substrate exec primitive(= 後續 slice / open decision)。

## (1) ID + Title — Design B（推薦,最小首刀)
SLICE-DHB3 = **對話式結果回饋,雙工 ACP session**(留 result-serialization seam 給未來升級 Design A/MCP-server):Hermes 提 `tool_call`(session/update)→ transport **仍 deny** `session/request_permission`=`{outcome:{outcome:"cancelled"}}`(acp-stdio.ts:206,**不變**,propose-only 保留,Hermes 永不自跑)→ **multi-turn DRIVER(管線之上)** 把提案映成 GovernedCall、跑 `runGovernedToolCall`(commit-before-effect 不動)於 Agent OS 自己 substrate → `GovernedOutcome` 經 `redactSecrets` → 序列化成文字 → transport 送**後續** `session/prompt(sessionId,[{type:"text",text:<redacted outcome>}])`(同 intent 的 content 形狀,acp-stdio.ts:322-323;sessionId 已於 314-320 捕獲)→ Hermes 續推 → 迴圈到終止 stopReason **或** 硬 `maxTurns` cap。
- **為何勝過替代**:(c) ACP permission-grant **被否決**——回 `selected/allow` 會讓 **Hermes 自己執行**(其 backend local/Docker/SSH),違反「Agent OS 是執行者 + PDP 唯一授權 + commit-before-effect + credential-blind」;(a) Agent-OS-as-MCP-server 是更乾淨終態(結果是 `tools/call` response,無 untrusted-prose 往返)但**改動最大**(Agent OS 要跑 MCP server + capability-posture 反轉,CLIENT_CAPABILITIES 現 frozen-empty acp-stdio.ts:62)→ 留後續 slice,本刀把 result seam 留乾淨以便升級。

## (2) 三處 seam 改動（pipeline + commit-before-effect 不動,DRIVER 在其上）
1. **TRANSPORT**(acp-stdio.ts):`submit` 停止一次性——(i)保持 child + sessionId 跨 N 回合存活,只在終止 stopReason/error/maxTurns 才拆;(ii)新增 outbound 入口送後續 `session/prompt(sessionId,…)` 再續串 session/update(stdin writable + pending-id 機制已在 173-183)。permission→cancelled(206)、fs/terminal→`-32601`(211-216)**逐字不變**。
2. **TURNSOURCE/PORT**(desktop.ts):`DesktopHermesTransport` 由單向 `submit(intent)→AsyncIterable<AcpUpdateFrame>` 擴成**可回饋**——加一個把 governed 結果送回(同 session)的方法 / callback;`DesktopHermesTurnSource` 串接 DRIVER。介面擴充**向後相容**(DHB1/2a 的單向用法仍可)。
3. **新 multi-turn DRIVER**(新檔,在 `runGovernedToolCall` 之上):提案→GovernedCall→跑管線→`redactSecrets`+序列化 outcome→回饋→`maxTurns` cap。**不改** pipeline.ts / guard.ts。

## (3) DHB3a（in-repo)/ DHB3b（live)
- **DHB3a(in-repo,verify 內,無 credits,不讀 ~/.hermes)**:擴 in-tree fake `hermes acp`(`__fixtures__/fake-hermes-acp.mjs`)加 `loop` scenario(首個 tool_call〔fake:130-135〕+ denied permission〔137-170〕後 **等第二個 session/prompt**〔promptResolve 已在 226-229〕,讀 result text,再發第二個 tool_call〔續〕或 resolve `stopReason:"end_turn"`〔done〕)。Generalize `AcpStdioTransport.submit` 保持 session 開 + 收 governed-result + 送後續 prompt + 強制 `maxTurns`。對 Fake transport + FakeSandboxAdapter 證:**整個多輪閉環、治理整合、redaction、turn cap、6 不變量**。effect 用 deterministic Fake(substrate 尚無真 exec,見 §0)。
- **DHB3b(live,user-initiated,gate 同 `desktop.live.test.ts` 的 `AGENTOS_LIVE_DESKTOP_HERMES=1`,花你 credits,觸及你帳號,不讀 ~/.hermes、不送 Agent OS secret)**:綁真 Hermes 0.17.0 ACP 的**回饋邊 dialect**(Fake 證不了的):(1)真 `hermes acp` 是否在 client 用**同 sessionId 重 prompt 一個 tool-result** 時**續推**(Design B),還是要走 request_permission response / MCP server;(2)第二個 session/prompt 是否**沿用同對話脈絡**而非重啟;(3)保持 propose-only 的確切 outcome enum。沿用 DHB2b M3/M4 console.info 診斷(desktop.live.test.ts:198-216,236-245)擴記「收到結果後的 continuation」。**dialect 分歧 → fail-closed + 清楚診斷,絕不退化成讓 Hermes 自跑。**

## (4) 保留不變量（6,各有測)
1. **propose-only / Agent-OS-是執行者**:`session/request_permission`→cancelled(206)即使閉環後也不變;effect 只經 `runGovernedToolCall` 在 Agent OS substrate 跑。
2. **deny-by-default / PDP 唯一授權 + 告知 Hermes denied**:`denied` outcome(pipeline.ts:59-67 在 effect 前短路)**停**該 effect,並以「DENIED: <reason>」文字回饋,迴圈安全續行。
3. **credential-blind 回饋通道**:outbound 結果 prompt content **過 `redactSecrets` 才出**(對稱於 inbound `governBrainStream` screen,credential-guard.ts:48-57);只送 outcome 的 status/detail/receipt-id,絕不送 raw secret。
4. **brain-untrusted**:結果以純文字進入不可信模型是安全的——每個**下一個提案都重入完整 PDP 管線**;絕不把 attacker-controlled raw args 原樣回顯。
5. **commit-before-effect**:`commitBeforeEffect`(guard.ts:57-73 先 append+await receipt 才 effect)**不改**,DRIVER 在其上。
6. **fail-closed + 終止 cap**:spawn/nonzero/malformed/EOF/JSON-RPC-error 仍 throw 出 submit(acp-stdio.ts:271,283-299)→ deny-by-default;execution error → 安全「execution failed」回饋;**`maxTurns` 硬上限**避免無限迴圈。

## (5) Test-first plan（RED 先行,DHB3a;對 Fake)
- **RED1 閉環 happy**:fake `loop` 提 tool_call#1 → DRIVER → `runGovernedToolCall` 跑 Fake effect → outcome redact+序列化 → 後續 prompt → fake 提 #2 → … → end_turn;斷言多輪 + 每輪治理過。
- **RED2 denied 不執行且被回報**:PDP deny 的提案 → Fake effect 對它跑 0 次、後續 prompt 文字含 "DENIED"。
- **RED3 credential-blind outbound**:Fake effect 的 `EffectResult.detail` 夾 runtime-built secret canary(`sk-…`,非 source literal)→ 回饋 prompt **經 redactSecrets**、canary 不出現在送 Hermes 的 stdin。
- **RED4 propose-only 跨迴圈保留**:每輪 `session/request_permission` 仍答 cancelled(fake 的 permissionApproved 恆 false、toolExecuted 恆 false)。
- **RED5 終止 cap**:fake 每次都回 tool_call(永不 end_turn)→ 迴圈在 `maxTurns` 安全停、不無限轉。
- **RED6 commit-before-effect + abort 不回假結果**:appender reject → effect 從未跑 **且** 不送後續結果 prompt(commit 失敗 = deny,非假結果)。
- **RED7 既有 fail-closed 不回歸**:對「多輪化後的 submit」重跑既有 acp-stdio.test.ts 的 fail-closed/credential-blind/host-access/propose-only suites,全綠。

## (6) Definition of Done（實測）
- [x] DHB3a:RED → `pnpm run verify` **exit 0**(961 passed + 19 skipped;Fake 多輪閉環測 + duplex fail-closed 綠;6 不變量各 mutation 證非空〔propose-only-turn>1 / skip-redact / fabricate-denied-success×2 / Infinity-cap-hang〕;depcruise 139 modules clean〔reviewer deep-import 親證 bite〕;secret-scan clean;live/DHB3b 不在 verify)。
- [x] **pipeline.ts / guard.ts EMPTY-diff**(reviewer git-diff 證);DRIVER `runClosedLoop` 在管線之上、重用 `runGovernedToolCall`、絕不自跑 effect;DHB1/DHB2a seam(shim/credential-guard/parseFrame/one-shot submit)未動、向後相容。
- [x] **6 不變量 HELD**:propose-only **每輪**(duplex `session/request_permission`→cancelled 逐字同 one-shot,reviewer 證第 2 輪仍 deny)/ deny-不執行且回報 "DENIED" / **credential-blind 回饋(redactSecrets 才出,無 raw-args echo)** / brain-untrusted / commit-before-effect 不改(abort→deny 非假結果)/ fail-closed + **maxTurns=12 cap(Infinity→hang 證 load-bearing)**。
- [x] **duplex fail-closed committed tests(採納 reviewer MINOR)**:malformed/nonzero/EOF→`nextTurn` reject、spawn-fail→`openSession` reject、early-stop teardown 無 hang/orphan + feed-after-close reject(各帶 non-vacuity mutation);+ 硬化:child exit 在 handshake pending 時即 reject(test d 10s→77ms)。無 orphan(ps 全表精確證)。
- [x] DHB3a:**獨立 Opus 4.8 review = PASS**(8 攻擊面 HELD/N/A;每不變量 mutation 翻紅;1 MINOR〔duplex fail-closed 無 committed test〕已採納補)。
- [ ] DHB3b(你親跑後填):`AGENTOS_LIVE_DESKTOP_HERMES=1 pnpm run e2e:live-desktop-hermes` 多輪 live 綠 / 或揭露 dialect 分歧(fail-closed 診斷)→ 必要時修 DRIVER/transport mapping 回 verify 重證。

## (7) Rollback
- `git revert <merge-sha>`(DRIVER + transport 多輪化 + desktop.ts 介面擴充 + Fake loop scenario)。pipeline/guard/DHB1-2 不受影響;transport 單向用法向後相容。

## (8) Depends-on / blocks + ⚠️ 待你決定（open decisions)
- Depends-on:DHB2a(`AcpStdioTransport`)、DHB1(frame/parseFrame/TurnSource)、`runGovernedToolCall`/commit-before-effect、substrate/cost。Blocks:Design A(Agent-OS-as-MCP-server)= 後續。DAG 無 cycle ☑。
- **待你決定(寫進 spec,影響 DHB3a/後續)**:
  1. **`maxTurns` 預設 + per-task 累計預算**:單次 effect 已被 `cost.reserve` hard-cap(pipeline.ts:70-76);多輪需**每任務上限**(turn 數 + token 總和)。預設值?(建議 maxTurns 起步保守如 8–16;token 總和走既有 cost gate。)
  2. **`EffectResult` 是否現在加 optional `output?: unknown`**(攜更豐富結果回)還是 DHB3a 先用 status+detail 文字、把 widening + substrate `exec` primitive 留後續 slice?(建議:DHB3a 先文字,substrate exec 另開。)
  3. **是否把 Design A(Agent-OS-as-MCP-server)定為終態**(capability-posture 反轉,需獨立安全 review)?
- **誠實前提**:DHB3a 證閉環 + 治理 + redaction + cap + 不變量(Fake);真 Hermes 回饋-邊 dialect + 真命令輸出(需 substrate exec)= DHB3b/後續。
