# SLICE-EXEC4: MCP 廣告 — 讓真 Hermes 自主發現+呼叫我們的 registered 工具（Agent-OS-as-MCP-server)

- **Phase**: capstone 後續（autonomous success path;capability-posture 反轉,需自身安全 review)
- **Branches**: slice/exec4a-mcp-governed-server（in-repo)、slice/exec4b-live-autonomous（live)
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: EXEC4a <= 1–1.5 day（TS only）；EXEC4b = live(user-initiated)
- **狀態**: **EXEC4a DONE（merged）**;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS(tools/list 只暴露 bounded + schema-no-drift / single-execution-path / deny-by-default / commit-before-effect / 協定 fail-closed,mutation 證實;acp-stdio〔mcpServers 仍 []〕/pipeline/EXEC3a byte-unchanged)。**EXEC4b harness DONE（merged;user 批准廣告姿態）**:acp-stdio backward-compat `mcpServers` 注入(default [],兩 site,clientCapabilities 仍 {})+ in-process **127.0.0.1 loopback HTTP MCP server**(host EXEC4a handler,POST /mcp→runGovernedToolCall 單一 edge;fail-closed 405/413/-32700/404;ephemeral port、no 0.0.0.0、torn down)+ dual-gate live 測;獨立 Opus4.8 reviewer=PASS(backward-compat/loopback-不繞治理/network-contained/per-site-wired,mutation 證實;採納 413 body-cap 測;core byte-unchanged 除 acp-stdio 注入)。**EXEC4b live-run = 跑了,FAIL-CLOSED 並釘出真 dialect(2026-06-24,user-authorized)**:`AGENTOS_LIVE_*=1 pnpm run e2e:live-exec-mcp` → JSON-RPC `-32602 Invalid params`,**安全網守住(fail-closed、無 exec、無 hang)**。根因(從 Hermes 源碼確認):`acp_adapter/server.py:880-891` 的 `AgentCapabilities` **無 `mcp_capabilities`** → 預設 `McpCapabilities(http=False, sse=False)`;server.py:900 明寫 **"ACP is stdio-only, local-trust"**。→ **Hermes 只支援 STDIO mcpServers,不支援 http/sse**;我們的 http loopback descriptor 從根本不相容(已補的 `headers:[]` schema 修正正確但無濟於事)。EXEC4a server + EXEC4b http loopback 仍是**正確、reviewed、in-repo 證的 governed MCP 邊界**(可被 http-MCP client 用),只是不被此 Hermes 用。**→ AUTONOMOUS Hermes 自主呼叫需 EXEC4c(stdio bin transport)。**

## (9) EXEC4c（autonomous,stdio bin;doc-first 待決)
Hermes 既只收 stdio mcpServers,autonomous 路徑 = **Hermes SPAWN 一個 Agent OS governed MCP server bin**(`exec-mcp-server-bin.mjs`):它是 Agent OS 碼,經 stdio 講 MCP,dispatch 進 `createExecMcpServer(deps).handle`(自帶真 OpenShell adapter + bindings + WORM + screen/authorize/cost)。descriptor = `{name, command:"node", args:[bin], env}`。**trade-off(WORM-in-child topology)**:bin 在 Hermes 行程樹內(Hermes spawn + 控生命週期)、自帶 WORM,vs http loopback 的單行程治理。**WE-stay-executor 仍成立**(bin 是 Agent OS 編譯碼,brain 無法竄改其治理邏輯)。EXEC4c = 你的戰略決定(是否接受 Hermes-spawned governance 行程 + WORM-in-child)。

## (0) 動機 + ⚠️ capability-posture 反轉 + 誠實分界（grounded,設計探索 task w5khoz1zi)
capstone 已 live 雙證:(A) 真 Hermes 提它**自己的**工具 → 全 denied@policy(它不知道我們的 exec.echo/ls);(B) **受控**註冊提案 → 真 OpenShell 真命令 → 真輸出。唯一缺口:**真 Hermes 不知道我們的工具**——因 `session/new.mcpServers` 寫死 `[]`(acp-stdio.ts:345 one-shot / :480 duplex)。EXEC4 = **廣告我們的 registered 工具給 Hermes**,讓它**自主 discover(`tools/list`)+ call(`tools/call`)** → 治理 → 真 exec → 結果回。
- **WHO EXECUTES(關鍵,YES 我們)**:ACP+MCP 裡 Hermes 是 **MCP client**;它 `tools/call` 打到**我們跑的 MCP server**,我們的 handler 執行+回結果——**Hermes 永不自跑**。`tools/call {name,arguments}` → 映成 EXEC3a 的 `BoundExecCall {tool:name, context, args:arguments}`(exec-closed-loop.ts:80-84)→ **UNCHANGED `runGovernedToolCall`**(pipeline.ts:53:screen→authorize→cost→commit-before-effect→`bindingWrappedExecEffect`)→ `GovernedOutcome` → MCP result(executed→`{content,isError:false}`;denied→`{content:"DENIED…",isError:true}`)。**零新執行路徑。**
- **capability-posture 反轉(本刀的「大」)**:今天 clientCapabilities frozen-empty(無 fs/terminal)+ mcpServers `[]`(不廣告)。EXEC4 廣告一個**只暴露 exec.echo/ls** 的 MCP server。**clientCapabilities 不動**(仍無 fs/terminal——與 mcpServers 正交);反轉的是**架構**(我們現在也跑一個 agent 會呼叫的 server),**非**加 fs/terminal client cap。propose-only `request_permission` deny + fs/terminal `-32601`(acp-stdio.ts:232-244)**留作 fail-closed backstop**(Hermes 提它自己的 fs/terminal/built-in 仍 denied)。
- **誠實分界**:EXEC4a(in-repo,verify-green):Fake MCP client + Fake substrate 證 governed MCP 邊界。EXEC4b(live,user-initiated):真 Hermes 自主 discover+call over 真 OpenShell。**redaction best-effort;真 credential 邊界 = sandbox 零憑證+無 egress。** 真 ACP mcpServers descriptor 形狀(stdio vs http/sse)只在 live 釘。

## (1) Recommended design
新增 Agent-OS-owned MCP server,只暴露 2 個 seed 工具,`tools/call` handler = EXEC3a binding+治理路徑(verbatim 重用)。

## (2) Seam change（最小,最大重用)
NEW(hermes vendor zone,只 import neutral barrels):
1. `src/runtime/brain/adapters/hermes/mcp/exec-mcp-server.ts` —— protocol-level MCP server:`tools/list` 回**恰好** `seedBindings()` keys、各 `inputSchema` 由該 binding 的 **strict argSchema 衍生(single source of truth)**;`tools/call` handler 呼 `runGovernedToolCall(deps, {tool,context,args})` → 映 `GovernedOutcome`→MCP result;fail-closed parse/dispatch(鏡 acp-stdio.ts:298-301 malformed→deny / :237-244 unknown method→`-32601`,**永不 default-allow**)。
2. `src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.mjs` —— 薄 stdio entrypoint(若採 stdio transport;鏡 `['node', FAKE_ACP]` 的 spawn 模式)。
3. acp-stdio.ts:把 `mcpServers:[]`(:345/:480)換成**一個**指向我們 exec MCP server 的 descriptor。
**REUSE 不動**:`seedRegistry`/`seedBindings`/manifests/bindings(exec-seed-tools.ts)、`bindingWrappedExecEffect`/`ExecToolBinding`(exec-closed-loop.ts)、`makeArgsCredentialScreen`、`makeExecEffect`、`runGovernedToolCall`/commit-before-effect。**不改** pipeline 核。

## (3) EXEC4a（in-repo)/ EXEC4b（live)
- **EXEC4a(verify-green,無 Hermes/credits/sandbox-ownership 決定)**:只建 `mcp/exec-mcp-server.ts`;Fake MCP client(鏡 FakeDesktopHermesTransport,scripted requests/asserted responses)+ Fake substrate。斷言:`tools/list` = **恰好** [exec.echo, exec.ls](inputSchema == strict argSchema 的 JSON-Schema,**別無他物**,無 fs/terminal/raw-argv/shell);bound `tools/call exec.echo {text:'hi'}` 經**全 pipeline**(receipt before effect)→ `isError:false` + redacted 真-ish 輸出;unknown tool → denied@policy `isError:true`(substrate 0 calls);poisoned arg `{text, argv:'; rm -rf /'}` → strict-schema reject `isError:true`(makeExecEffect 0 calls);credential-blind:`{text:<runtime sk- canary>}` → denied@screen `isError:true`;protocol fail-closed(malformed/unknown method → error,非假 ok)。RED-first。
- **EXEC4b(live,user-initiated,gated `AGENTOS_LIVE_DESKTOP_HERMES=1` + `AGENTOS_LIVE_OPENSHELL=1`)**:擴 exec-capstone.live.test.ts (A)——廣告我們的 mcpServers + 真 Hermes + 真 OpenShell → 真 Hermes **自主 `tools/list` 發現 exec.echo/ls + `tools/call` 呼叫** → 治理 → 真 OpenShell 真命令 → 結果 → 續推。斷言 **>=1 EXECUTED outcome(registered+bound,真 exit=0)** + deny-by-default/propose-only/ephemeral-sandbox 對 Hermes 的**其他(非廣告)工具嘗試**仍成立。**低 maxTurns(4)+ 緊 cost**(brain autonomy 現在 ACTIVE)。

## (4) 不變量（保留 7 + NEW 2,各有測)
- 保留:**deny-by-default(只暴露 bounded 工具)**(tools/list 源自 seedBindings keys + authorize 拒未註冊)/ composer-fixed argv(brain 只供 declared params)/ commit-before-effect(MCP 路徑亦然)/ credential-blind(inbound screen + 輸出 redact)/ fail-closed protocol(malformed/unknown→error)/ maxTurns+cost+ephemeral-sandbox / **clientCapabilities 仍無 fs/terminal**(與 mcpServers 正交)。
- **NEW single-execution-path(load-bearing EXEC4 gate)**:MCP tools/call handler **每個 call 只經 `runGovernedToolCall`**——**絕不**直呼 `makeExecEffect`/substrate;mutation(handler 直執行繞過治理)→ 紅。
- **NEW schema-no-drift**:廣告的 inputSchema **由 binding strict argSchema 衍生**(single source of truth);mutation(廣告 schema 與 enforced schema 分歧)→ 紅。

## (5) Test-first plan（RED 先行,EXEC4a,對 Fake)
見 §3 EXEC4a 的 6 條斷言;另:commit-before-effect(tools/call 在 effect 前 append AuditEvent receipt;abort commit → `isError:true`、無假結果)。

## (6) Definition of Done（實測）
- [x] EXEC4a:RED → `pnpm run verify` **exit 0**(1013 passed + 23 skipped;`exec-mcp-server` 11 測綠;EXEC3a/EXEC1/2/DHB/pipeline 既有測不變;depcruise 145 modules clean〔reviewer deep-import 親證 bite〕;secret-scan clean〔canary runtime-built〕;live 不在 verify)。
- [x] **tools/list 只暴露 seed 兩工具**(exec.echo/ls,別無他物——無 fs/terminal/argv/shell;description 來自 manifest;**inputSchema byte-derived from strict argSchema**)/ bound call 經全治理(screen→authorize→cost→commit-before-effect→bindingWrappedExecEffect)/ unknown→denied@policy、poisoned argv→strict reject、secret→denied@screen 皆 isError:true 且 **substrate 0 calls** / **single-execution-path**(唯一 `runGovernedToolCall` edge)/ commit-before-effect(receipt 在 effect 前,abort→isError:true)/ protocol fail-closed(malformed/unknown→JSON-RPC error,非假 ok)。reviewer mutation:schema additionalProperties:true→no-drift 測翻紅;handler 直呼 effect bypass→deny+commit 測翻紅。
- [x] **NEW single-execution-path + schema-no-drift** 各 mutation 證非空;**closure-res.ok deviation 判定 sound**(誠實映 isError、不增第二執行 edge)。
- [x] clientCapabilities 仍 frozen-empty(無 fs/terminal);**acp-stdio.ts `mcpServers:[]` 未動**(EXEC4a 不做真廣告)。
- [x] **EXEC4a 獨立 Opus 4.8 review = PASS**(8 攻擊面 HELD/N/A;2 MINOR informational〔policy+binding 二層拒;argSchemaToJsonSchema 讀 zod _def,fail-closed + exact-match 釘住〕)。
- [ ] **EXEC4b(你親跑/授權代跑後填)**:真 Hermes 自主 discover+call our tool → 真 OpenShell exec → >=1 EXECUTED(真 exit=0)+ 其他工具仍 deny-by-default/propose-only;真 mcpServers descriptor 形狀確認;dialect 分歧→fail-closed。

## (7) Rollback
- `git revert <merge-sha>`(新 mcp/ + acp-stdio mcpServers descriptor + 測)。mcpServers 復原 `[]` 即回 EXEC3 行為;EXEC3a/核不受影響。

## (8) Depends-on / blocks + ⚠️ 待你決定（open decisions）
- Depends-on:EXEC3a(binding/runExecClosedLoop)、EXEC3b(capstone harness)、EXEC2(真 OpenShell exec)、DHB3b(真 Hermes ACP)、ToolRegistry/authorizeToolInvoke、makeArgsCredentialScreen。Blocks:無(autonomous capstone)。DAG 無 cycle ☑。
- **待你決定(寫進 spec,影響 EXEC4b/設計)**:
  1. **⚠️ 是否廣告工具給 brain，是不是對的姿態?**(DHB3 doc 列為 open question;INDEX 標 EXEC4「需自身安全 review(capability-posture 反轉)」)。它**只暴露 bounded 工具(exec.echo/ls)、治理不變 → net-safe**,但「讓 Agent OS 主動把工具廣告給不可信 brain」是**你的戰略決定**。建議:先 EXEC4a 在 in-repo 把 governed MCP 邊界證牢(零 live、零姿態風險),再決定是否 live(EXEC4b)。
  2. **transport + sandbox-ownership(耦合 #1 fork)**:(a) **stdio** descriptor — Hermes spawn 我們的 server child;**但 child 在 Hermes 行程樹內**,要保 WE-stay-executor,該 stdio bin 必須**回呼 Agent OS 的 runGovernedToolCall**(它本身是 Agent OS 碼 + 真 substrate)。(b) **http/sse loopback** — Agent OS **in-process host** 一個 loopback server → `tools/call` **可證進我們的** runGovernedToolCall(**最穩 WE-stay-executor**)。建議:**EXEC4a 建 protocol-level server(transport-agnostic)先證;EXEC4b 釘 http/sse loopback**(或回呼式 stdio bin)。
  3. **廣告工具集**:保持**恰好 exec.echo/ls**(零新攻擊面)。建議 YES。
  4. **inputSchema 來源**:zod→JSON-Schema 衍生(無漂移,但可能加依賴 zod-to-json-schema)vs 手寫常數 + drift 測。建議:**自寫小轉換器(2 個簡單 schema,無新依賴)或手寫 + no-drift 測**。
- **誠實前提**:EXEC4a 證 governed MCP 邊界(Fake);真 Hermes 自主呼叫 + descriptor 形狀 = EXEC4b/live;redaction best-effort,真 credential 邊界 = sandbox 零憑證+無 egress。
