# SLICE-EXEC4c: stdio MCP bin — 真 Hermes 自主 spawn + 呼叫我們的 governed 工具（autonomous capstone）

- **Phase**: autonomous capstone（Hermes-spawned governed MCP server over stdio)
- **Branches**: slice/exec4c-stdio-bin（in-repo)、slice/exec4c-live-autonomous（live)
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: EXEC4c-a <= 1–1.5 day（TS only)；EXEC4c-b = live(user-initiated)
- **狀態**: **EXEC4c-a DONE（merged）**;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS(per-line fail-closed / stdout protocol-only / single-execution-path over stdio / deny-by-default〔canary stdout+stderr 皆無〕,mutation 證實;core byte-unchanged;descriptor McpServerStdio 且未 wired;FAKE 不拉 vendor)。**EXEC4c-b harness DONE（merged）**:bin REAL-mode 共享-kernel WORM(`createPartitionedIngestSink`,injectable transport,FAKE 仍 in-memory,commit-before-effect 保留)+ stdio-descriptor live 測;獨立 Opus4.8 reviewer=PASS。**EXEC4c-b LIVE-RUN ✅ 通過(2026-06-24)**:真 Hermes 自主 spawn bin + tools/list+tools/call → 真 OpenShell exec(真 exit=0+hello)+ deny-by-default + bounded + 共享 kernel 鏈 entries=1(統一 evidence)。**autonomous capstone 端到端 live。**(先 -32602 釘出 `McpServerStdio.env=List[EnvVariable]`,修後通過。)

## (0) 動機 + ⚠️ 為何是 stdio bin（live 釘出)
EXEC4b live 釘實:**Hermes `hermes acp` 只支援 STDIO mcpServers**(`acp_adapter/server.py:880-891` AgentCapabilities 無 mcp_capabilities → 預設 http=False/sse=False;server.py:900「ACP is stdio-only, local-trust」)。故 http loopback 不可用,autonomous 路徑 = **Hermes SPAWN 一個 Agent OS stdio MCP server bin**。
- **設計**:`exec-mcp-server-bin`(Agent OS 碼,經 **newline-delimited JSON-RPC over stdin/stdout** 講 MCP——同 fake-hermes-acp.mjs 的 framing)dispatch 進 **既有 `createExecMcpServer(deps).handle`**(transport-agnostic,單一 governed edge,EXEC4a 已證)。bin 自建 deps:真 OpenShell substrate(`makeOpenShellExecCapable` + ephemeral sandbox)+ seed bindings + screen/authorize/cost + **WORM appender**。descriptor = `{name:"agentos-exec", command:"node", args:[bin], env:<minimal>}`(stdio)。
- **WE-stay-executor(仍成立)**:bin 是 Agent OS **編譯碼**;即使 Hermes spawn 它、控其 stdin/stdout/生命週期,**所有 tools/call 仍只經 `runGovernedToolCall`**(brain 無法竄改其治理邏輯;adversarial JSON-RPC → 仍 governed;kill bin → 只是停、fail-closed)。
- **⚠️ WORM topology(誠實 + 緩解)**:bin 在 Hermes 行程樹內、是獨立行程。**緩解**:bin 的 WORM appender = **`createIngestAppender` 寫同一個真 WORM kernel**(via ingest gRPC)→ **evidence 統一成一條鏈、可獨立驗證**,非分裂的 in-memory log。(open decision:統一 kernel〔建議〕vs in-memory split。)

## (1) Recommended design
stdio bin 包 `createExecMcpServer.handle`;deps 含真 OpenShell + 寫共享 WORM kernel;descriptor 為 stdio。

## (2) Seam change（最小,最大重用)
NEW(hermes vendor zone):
1. `src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.ts`(+ 編譯/執行入口):stdin newline-delimited JSON-RPC reader → `createExecMcpServer(deps).handle(req)` → stdout newline-delimited response。**stdout 僅協定**(無污染,同 ACP stdio 紀律);malformed line → JSON-RPC error(fail-closed,非假 ok)。bin 啟動建 deps + ephemeral sandbox(init create / exit destroy);**minimal env**(無 Agent OS secret);自建 OpenShell mTLS(讀 OpenShell client materials,非我經手的 secret);exec env placeholder-only。
2. 一個 helper 把 stdio descriptor 餵給 acp-stdio 的 `mcpServers`(EXEC4b 已加可注入 `mcpServers?`,EXEC4c 用 stdio 形狀的 descriptor)。
**REUSE 不動**:`createExecMcpServer`(EXEC4a 的 governed handle + single-execution-path)、`seedRegistry`/`seedBindings`、`bindingWrappedExecEffect`、`makeArgsCredentialScreen`、`makeOpenShellExecCapable`、`createIngestAppender`、`runGovernedToolCall`。

## (3) EXEC4c-a（in-repo)/ EXEC4c-b（live)
- **EXEC4c-a(verify-green,無 Hermes/credits)**:把 bin 當**子進程** spawn(`node <bin>`),Fake MCP client 經其 stdio 送 `initialize`/`tools/list`/`tools/call`,deps = Fake substrate + Fake/in-memory appender。斷言:tools/list 只 exec.echo/ls;bound tools/call 經全治理(receipt before effect);unknown/secret/poisoned → isError:true、substrate 0;**stdio framing fail-closed**(malformed line → error、stdout 僅協定);**single-execution-path**(重用 EXEC4a handle)。RED-first;non-vacuity。
- **EXEC4c-b(live,user-initiated,dual-gate)**:advertise **stdio descriptor** → 真 Hermes **spawn 我們的 bin** → `tools/list` 自主發現 → `tools/call` 呼叫 → bin 的 governed pipeline → **真 OpenShell exec** → 結果回 → Hermes 續推。WORM 寫**共享真 kernel**(統一 evidence)。斷言 >=1 autonomous EXECUTED(真 exit=0)+ deny-by-default for Hermes 其他工具。**這是 (A)+(B)+(EXEC4b http)都無法展示的「真 Hermes 自主呼叫我們的工具」**。

## (4) 不變量（重用 EXEC4a 7 + NEW)
重用(bin 包同一 handle):deny-by-default(只暴露 bounded)/ single-execution-path / schema-no-drift / commit-before-effect / credential-blind / fail-closed / composer-fixed argv。NEW:**stdio framing fail-closed**(malformed JSON line → JSON-RPC error,stdout 僅協定、無污染)/ **bin deps credential-blind**(minimal env、無 Agent OS secret、exec env placeholder-only)/ **WORM 統一**(寫共享 kernel,可獨立驗證)/ **WE-stay-executor under Hermes-spawn**(bin 編譯碼,adversarial JSON-RPC 仍 governed)。

## (5) Test-first plan（RED 先行,EXEC4c-a)
spawn bin 子進程 + Fake MCP client over stdio + Fake substrate:tools/list 只 2 工具;bound call governed(receipt-before-effect);unknown/poisoned/secret → isError:true substrate 0;malformed stdin line → JSON-RPC error(fail-closed);stdout 僅協定(spy:無非協定輸出);single-execution-path(mutation:bin 繞 handle 直執行 → deny 測紅);無 orphan(bin 子進程 teardown)。

## (6) Definition of Done（實測）
- [x] EXEC4c-a:RED → `pnpm run verify` **exit 0**(1032 passed + 24 skipped;stdio core 6 + subprocess〔spawn 真 dist bin,FAKE 模式〕3 測綠;EXEC4a〔11〕/EXEC4b〔6〕/EXEC3a〔11〕/acp-stdio〔11/4〕/EXEC1/2/DHB/pipeline 不變;depcruise 150 modules clean〔reviewer deep-import 親證 bite〕;secret-scan clean;live 不在 verify;**無 orphan**)。
- [x] tools/list-only-bounded(exec.echo/ls,schema 衍生)/ governed tools/call(commit-before-effect receipt-before-effect)/ unknown+poisoned+secret→isError:true **substrate 0**(legit 僅 1)/ **stdio per-line fail-closed**(malformed→-32700、loop 存活)/ **stdout protocol-only**(診斷走 stderr)/ **single-execution-path**(只經 `createExecMcpServer.handle`→`runGovernedToolCall`),各 mutation 翻紅證實(malformed-fabricate / stdout-banner / bypass-handle / deny-vectors)。canary stdout+stderr **皆無**。
- [x] bin credential-blind(minimal env、不讀 ~/.hermes)+ WE-stay-executor(bin 編譯碼;adversarial JSON-RPC 仍 governed;FAKE 不拉 vendor〔lazy openshell import〕);ephemeral sandbox create-on-startup/destroy-on-exit/SIGTERM/SIGINT;descriptor McpServerStdio 且**未** wired 進 acp-stdio 預設(仍 [])。
- [x] **EXEC4c-a 獨立 Opus 4.8 review = PASS**(8 攻擊面 HELD/N/A;4 mutation 翻紅;2 INFO〔REAL-mode WORM 暫 in-memory stub→EXEC4c-b 接共享 kernel;redaction best-effort,真邊界=零憑證 no-egress sandbox〕皆誠實標記、不弱化已測不變量)。
- [x] **EXEC4c-b harness DONE（merged）**:bin REAL-mode WORM = `createPartitionedIngestSink`(共享 kernel,partition `tenant-bin`,injectable AppendTransport;live=`createRpcAppendTransport({endpoint:AGENTOS_KERNEL_INGEST_ENDPOINT})` 非-secret;test=Fake)→ 統一 evidence;**commit-before-effect 保留**(stub/defer mutation 翻紅);**FAKE 仍 in-memory**(EXEC4c-a subprocess 3 測續綠;FAKE-to-kernel mutation 翻紅);injectable seam(`buildBinDeps {ingestTransport,substrate,onEffect}`)為**測試縫**——onEffect 觀測-only、不繞 `runGovernedToolCall`、不增第二執行路徑;**entry-point guard**(`import.meta.url===…argv[1]`)使 import 不觸發 startup。stdio-descriptor live 測(dual-gate,skip-under-verify load-bearing)+ in-repo WORM-wiring/descriptor 單元測;`pnpm run verify` exit 0(1036 passed + 25 skipped;depcruise 151 modules clean〔ingest barrel neutral、no-vendor-in-core〕;secret-scan clean;EXEC4c-a/EXEC4a/pipeline/acp-stdio〔[]〕byte-unchanged)。獨立 Opus4.8 reviewer=PASS(8 攻擊面 HELD/N/A;2 MINOR〔REAL appender `as never` cast=type-hygiene 追蹤項,行為已證同一 canonical event;`.claude/*.lock` harness 噪音已排除〕+ 1 observation,皆非阻斷)。
- [x] **EXEC4c-b LIVE-RUN ✅ 通過(2026-06-24,user-authorized 代跑)**:起 partitioned kernel(`--partitions tenant-bin`@127.0.0.1:50543,in-memory key)→ `AGENTOS_LIVE_DESKTOP_HERMES=1 AGENTOS_LIVE_OPENSHELL=1 AGENTOS_LIVE_KERNEL_ENDPOINT=127.0.0.1:50543 pnpm run e2e:live-exec-mcp-stdio` **綠**(1 test,真 Hermes 15.2s)。先 fail-closed 釘出 `McpServerStdio.env=List[EnvVariable]`(非 dict;-32602),修後重跑:`[EXEC4c-b] stoppedBy=terminal, turns=2, governed=1, frames=116`;**`sawExecTool=true, sawEchoedOutput(exit=0 + hello)=true`** —— **真 Hermes 自主 spawn 我們的 bin + tools/list 發現 + tools/call 呼叫 exec.echo → bin 的 `runGovernedToolCall` → 真 OpenShell exec → 真 exit=0 + hello**;deny-by-default 對其他守住、bounded;**`SHARED kernel chain for partition 'tenant-bin': entries=1`** —— bin receipt 落進**共享 kernel 鏈(統一 evidence,WORM-in-child 緩解成立)**。無 orphan(trap 收 kernel)。**autonomous capstone 端到端 live 成立——(A)+(B)+(EXEC4b http) 都無法展示的「真 Hermes 自主呼叫我們的 governed 工具→真 exec」現已 live。#4 姿態(Hermes-spawned governance 行程,WE-stay-executor 成立)落地。**

## (7) Rollback
- `git revert <merge-sha>`(新 bin + descriptor helper + 測)。EXEC4a/EXEC4b/核不受影響;mcpServers 復原 [] 即回非廣告。

## (8) Depends-on / blocks + ⚠️ 待你決定
- Depends-on:EXEC4a(`createExecMcpServer` governed handle)、EXEC4b(acp-stdio 可注入 mcpServers)、EXEC3a(bindings)、EXEC2(`makeOpenShellExecCapable`)、`createIngestAppender`(共享 WORM)、DHB(真 Hermes ACP)。Blocks:無(autonomous capstone 終態)。DAG 無 cycle ☑。
- **待你決定**:① **WORM topology**:bin 寫**共享真 kernel**(統一 evidence,建議)vs in-memory split。② bin 的 sandbox 生命週期:init-create/exit-destroy(建議)vs per-call。③ bin 自建 OpenShell mTLS 連線(讀 OpenShell client materials)是否接受(這非我經手的 secret;是 OpenShell 既有信任根)。④ 是否接受「Hermes-spawned governance 行程」這個 topology(WE-stay-executor 仍成立,但 bin 在 Hermes 行程樹內)。
- **誠實前提**:EXEC4c-a 證 stdio bin 的 governed 邊界 + framing fail-closed(Fake);真 Hermes 自主 spawn+discover+call + 真 OpenShell exec + 共享 WORM = EXEC4c-b/live;redaction best-effort,真 credential 邊界 = zero-credential no-egress sandbox。
