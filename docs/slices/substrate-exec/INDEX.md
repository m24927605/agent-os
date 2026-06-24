# Substrate exec primitive — INDEX（讓 governed effect 真的「跑命令拿輸出」)

> 2026-06-24。目標:補上 `ExecutionSubstrate` 唯一缺的能力——**在 sandbox 裡執行命令並拿回 {exitCode, stdout,
> stderr}**,讓 governed effect 從「canned stub」變成「**真實執行 + 真結果**」。這是讓 Agent OS 真正「替你把事
> 做完」、並讓 desktop-Hermes 閉環(DHB3)對**真命令輸出**續推的關鍵一步。

## 0. 現況（grounded,file:line)
- **port 缺 exec**:`SandboxAdapter`(src/runtime/substrate/port.ts:46-50)只有 `createSandbox/startSandbox/stopSandbox/destroySandbox`(lifecycle)+ `AdapterResult`;`NullSandboxAdapter`(fail-closed deny-all)/`FakeSandboxAdapter`(in-memory)。**無 exec/run/invoke。**
- **但 exec 能力已在 OpenShell transport 層**:`src/runtime/openshell/client.ts:221+` 已有 `ExecSandboxRequest` / `ExecSandboxStdout` / `ExecSandboxStderr` / `ExecSandboxExit{exitCode?}` / `ExecSandboxEvent{stdout?,stderr?,exit?}`——**streaming exec,fail-closed**(client.ts:213-214:exec 串在 terminal `ExecSandboxExit` 前關閉 → 絕不假造 exit 0);exec env 經 SecretResolver placeholder(provider-env.ts)。**缺口 = 把它經 port 暴露 + 接 governed effect。**
- **effect 形狀**:`EffectResult={ok,detail?,tokensUsed?}`(pipeline.ts:31);effect=`(toolCall)=>Promise<EffectResult>`(:43),在 commit-before-effect **之後**跑(:78-88)。
- **credential-blind 既有機制**:`CredentialLease`(src/credential/lease.ts)bundleRef-only;secret 由 **OpenShell SecretResolver egress 解析**(lease 只帶 bundleRef + env KEY 名,never value)。

## 1. ⚠️ credential-blind 不變量（exec 的核心)
- **輸入端**:命令的 env 只放 **bundleRef/placeholder**(由 substrate 的 SecretResolver 在 egress 解析),**raw secret 永不進 Agent OS 行程/log/命令列**——對稱於 brain 的 bundleRef-only args。
- **輸出端**:stdout/stderr **經 `redactSecrets` 才成為 `EffectResult` / 才回饋給 Hermes**(命令可能 echo 出 secret)。
- commit-before-effect / deny-by-default / fail-closed 不動(exec 是 effect,在 commit 之後;只有授權工具到得了 effect)。

## 2. 切片分解
| Slice | 範圍 | 狀態 |
|---|---|---|
| **EXEC1**(in-repo,Fake-proven) | `SandboxAdapter` 加 `execSandbox(ctx, sandboxId, spec)→ExecResult{exitCode,stdout,stderr}`(placeholder-only env)+ `FakeSandboxAdapter` impl(deterministic)+ `NullSandboxAdapter` fail-closed + 一個 **exec-backed governed effect**(跑命令→redact 輸出→EffectResult)+ credential-blind(placeholder 進/redact 出)+ fail-closed。Fake 證,verify 內。spec:`EXEC1-substrate-exec-port.md` | ✅ **DONE**(`ExecCapableSandboxAdapter` port + Fake/Null + `makeExecEffect`;credential-blind 進/出 + fail-closed〔無假 exit 0〕+ 64KB cap〔redact 後〕+ commit-before-effect,mutation 證實;pipeline/guard/OpenShell 未動;12 tests;獨立 Opus4.8 review PASS)|
| **EXEC2**(reconcile + live,gated) | **薄 buffered wrapper** `makeOpenShellExecCapable`:把 OpenShell 既有 streaming `execSandbox`/`ExecOutcome`(已 fail-closed + 8MiB cap + deadline deny)收斂成 port 的 buffered `ExecResult`(不碰 OpenShell 既有碼)+ in-repo reconcile 測 + gated live(對真 OpenShell:create→exec 真命令→真輸出 redact+cap→destroy)。spec:`EXEC2-openshell-exec-live.md` | ✅ **DONE(in-repo reconcile + gated live harness)**:`makeOpenShellExecCapable` fail-closed 映射 + credential-blind 透 wrapper + lifecycle 同實例,mutation 證實;OpenShell 既有碼/39 exec 測/EXEC1 未動;獨立 Opus4.8 review PASS。**✅ live-run 通過(2026-06-24)**:真 OpenShell create→exec `echo hello`→真 {exitCode,stdout} redact+cap→destroy,綠|
| **EXEC3a**(capstone,in-repo) | 把真 exec 接進 DHB3 閉環(**Design A**:brain 只提案註冊工具名+declared args,composer 持 `{argvPrefix,argSchema}` binding,argv 純 vector 永不 shell;ephemeral per-loop sandbox;effect 注入閉環之上)。Fake substrate + scripted Hermes 證 join + 全不變量(含 NEW argv-binding 接縫 + ephemeral-sandbox containment)。spec:`EXEC3-capstone-closed-loop-real-exec.md` | ✅ **DONE**(argv-binding 無任意命令〔full-bypass mutation→bash -c 翻紅〕+ deny-by-default + commit-before-real-effect + credential-blind + ephemeral-sandbox destroy-in-finally,mutation 證實;pipeline/EXEC1/2/DHB1-2 byte-unchanged;獨立 Opus4.8 review PASS)|
| **EXEC3b**(capstone,live,**user-initiated**) | 真 Hermes × 真 OpenShell:**(A)** 對真 brain 證 SAFETY(它提案它自己的工具→deny-by-default/propose-only/credential-blind/bounded/ephemeral-sandbox)+ **(B)** success 路徑(受控 exec.echo/ls 提案 over 真 OpenShell→真輸出回饋)+ 真 inbound screen(finding②)。dual-gate。spec:`EXEC3b-live-capstone.md`。**誠實:真 Hermes 自主呼叫我們的工具需 MCP 廣告=EXEC4;真 credential 邊界=sandbox 零憑證+無 egress** | ✅ **harness DONE**(真 inbound screen〔finding②〕+ (A)(B) gated live + dual-gate script,non-vacuity 證實;core 未動;獨立 Opus4.8 review PASS)。**✅ (A)+(B) LIVE 通過(2026-06-24)**:(A) 真 Hermes 提自己工具→全 denied@policy(0 execs,propose-only,bounded,ephemeral sandbox);(B) 受控 exec.echo→真 OpenShell 真命令→真 'hello'+'exit=0'。安全網對真 brain 成立 + 授權路徑端到端|
| **EXEC4a**(in-repo) | Agent-OS-owned MCP server **只暴露 exec.echo/ls**;`tools/call` handler = EXEC3a binding+治理路徑(零新執行路徑,WE-stay-executor)。Fake MCP client + Fake substrate 證 governed MCP 邊界 + NEW single-execution-path + schema-no-drift 不變量。spec:`EXEC4-mcp-advertise-tools.md` | ✅ **DONE**(tools/list 只暴露 exec.echo/ls〔schema 衍生〕、tools/call→runGovernedToolCall 唯一 edge、unknown/poisoned/secret→isError:true substrate 0、commit-before-effect,mutation 證實;acp-stdio〔mcpServers []〕/pipeline 未動;獨立 Opus4.8 review PASS)|
| **EXEC4b**(live,**user-initiated**) | 廣告 mcpServers + 真 Hermes + 真 OpenShell → 真 Hermes **自主 tools/list 發現 + tools/call 呼叫** exec.echo/ls → 治理 → 真命令 → 真輸出 → 續推((A)+(B) 結構上無法展示的 autonomous success)。**clientCapabilities 仍無 fs/terminal;⚠️「廣告工具給 brain」是戰略+安全 review 決定** | ✅ **harness DONE**(user 批准廣告姿態;acp-stdio backward-compat mcpServers 注入 + 127.0.0.1 in-process loopback MCP server〔不繞治理、network-contained〕+ dual-gate live;core 未動除注入;獨立 Opus4.8 review PASS)。**live-run 跑了→FAIL-CLOSED 釘出真 dialect**:`-32602`,**Hermes 只支援 STDIO mcpServers**(server.py:900「ACP is stdio-only」),http loopback 不被此 Hermes 用(但對 http-MCP client 仍正確)。安全網守住。→ autonomous = EXEC4c|
| **EXEC4c-a**(in-repo) | **stdio MCP bin**(`exec-mcp-server-bin`,Agent OS 碼,newline-delimited JSON-RPC over stdin/stdout → 既有 `createExecMcpServer.handle`,單一 governed edge)+ 真 OpenShell deps + WORM 寫**共享 kernel**(統一 evidence)。子進程 + Fake MCP client/substrate 證 governed 邊界 + stdio framing fail-closed + WE-stay-executor。spec:`EXEC4c-stdio-bin-autonomous.md` | DRAFT(spec 好,待開工)|
| **EXEC4c-b**(live,**user-initiated**) | advertise **stdio descriptor** → 真 Hermes **spawn 我們的 bin** → 自主 tools/list 發現 + tools/call 呼叫 → governed → 真 OpenShell exec → 續推。**真 Hermes 自主呼叫我們工具的 autonomous capstone**(http 路被 stdio-only 擋,stdio 是唯一可行)。⚠️ WORM-in-child topology(緩解:寫共享 kernel)；WE-stay-executor 成立 | OPEN(待 EXEC4c-a + 你親跑)|

## 3. 待你決定（open decisions)
1. **buffered vs streaming exec result**:OpenShell RPC 是 streaming;port 可先 **buffer 成 {exitCode,stdout,stderr}**(簡單、貼合 EffectResult)、streaming 留後續。建議:EXEC1 buffered。
2. **`EffectResult` 是否加結構化 `output?`**(exitCode/stdout/stderr)還是塞 `detail` 字串?(DHB3 open decision 之一。)建議:加一個結構化 result(或 EffectResult.output?),讓 DHB3 回饋結構化真結果。
3. **輸出大小上限**:命令可能噴巨量輸出 → **cap + truncate**(成本 + 回饋給 untrusted Hermes 的安全)。建議:EXEC1 設一個保守 cap(如 64KB,redact 後截斷,標記 truncated)。
4. exec env 的憑證 placeholder 是否走既有 `CredentialLease`/SecretResolver 流?建議:**重用**,不另造。

## 4. 交付順序
EXEC1(in-repo:port + Fake + exec-backed effect + credential-blind)→ EXEC2(live OpenShell `ExecSandbox`)→ EXEC3(接 DHB3 閉環,真輸出回饋)。每刀 doc-first + RED + `pnpm run verify` 綠 + 獨立 Opus 4.8 review + merge;EXEC2/EXEC3 的 live 由你的 OpenShell 環境驗。
