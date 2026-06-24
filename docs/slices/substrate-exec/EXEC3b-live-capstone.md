# SLICE-EXEC3b（live capstone): 真 Hermes × 真 OpenShell 的閉環 — 對真 brain 證 SAFETY + 真 exec success 路徑

- **Phase**: capstone live（gated,user-initiated)
- **Branch**: slice/exec3b-live-capstone（harness in-repo,skip-under-verify)
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: harness <= 1 day（TS only）；live-run = user-initiated
- **狀態**: **harness DONE（merged）**;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS(真 screen 非 vacuous / exec-effect rename byte-identical / seed-tools drift-free / (A)(B) gating load-bearing + 誠實切分 / readinessGated wrapper sound;core 未動)。**(A)(B) live-run = 待跑**(A: `AGENTOS_LIVE_DESKTOP_HERMES=1 AGENTOS_LIVE_OPENSHELL=1`;B: `AGENTOS_LIVE_OPENSHELL=1`)。

## (0) 動機 + ⚠️ 必須誠實面對的設計實況（grounded)
EXEC3a 已 in-repo 證 join(scripted Hermes 提案 `exec.echo` → 治理 → Fake exec → 回饋 → 續推)。EXEC3b = 用**真 OpenShell ephemeral sandbox + 真 desktop Hermes ACP** 跑整個 join,並補 finding②(真 inbound screen)。
- **⚠️ 設計實況(誠實,grounded)**:真 Hermes 經 ACP 提案的是**它自己的內建工具**(`hermes acp` 的 tool schema),**不是我們註冊的 `exec.echo`/`exec.ls`**——除非我們經 **MCP 把 Agent OS 的工具廣告給 Hermes**(`session/new.mcpServers`,= DHB3 deferred 的 Design A-MCP;acp-stdio.ts 現 `mcpServers:[]`、clientCapabilities frozen-empty)。所以「**真 Hermes 自主呼叫我們的工具 → 真 exec**」需 MCP 廣告 = **EXEC4**,不在本刀。
- **EXEC3b 因此誠實切兩個可 live 證的東西**:
  - **(A) SAFETY against a REAL brain(本刀主證)**:真 Hermes 對一個 intent 提案它自己的工具 → 全部重入治理 → **deny-by-default**(未註冊/未綁定 → denied@policy / no-binding deny)、**propose-only**(Hermes 不自跑)、**credential-blind**、**bounded**(maxTurns/cost)、**ephemeral sandbox create+destroy**。即「把真不可信 brain 接上後,安全網對它的真實提案成立」。
  - **(B) SUCCESS 路徑(真 exec,受控提案)**:用 **harness 注入的受控 `exec.echo`/`exec.ls` 提案**(scripted-over-the-real-substrate,或一段把已知 registered 提案餵進 `runExecClosedLoop` 的 transport double),over **真 OpenShell**:registered tool → 治理 → **真 OpenShell sandbox 跑真命令** → 真輸出(redact)回饋。即「join 對真 OpenShell 端到端成立」。((B) 的 Hermes 端是受控,因 (A) 的限制;真 Hermes 自主走 (B) = EXEC4/MCP。)
- **finding② 補上**:baseDeps.screen = 真 credential screen(`detectSecret` over call args;ScreenOutcome `{ok:false}` on secret-shaped)→ 斷言 secret-shaped declared arg → **denied@screen**。

## (1) ID + Title
SLICE-EXEC3b —（a)gated live harness 組合:`runExecClosedLoop(realTransport=AcpStdioTransport(["hermes","acp"]) | controlled, substrate=makeOpenShellExecCapable(new OpenShellSandboxAdapter(real mTLS @127.0.0.1:17670)), baseDeps{真 screen/authorize/cost/WORM appender}, bindings={exec.echo,exec.ls}, context, intent, {maxTurns:小})`;(b)真 inbound screen(detectSecret over args);(c)兩個 gated 測:(A) 真 Hermes SAFETY、(B) 受控提案真 OpenShell exec success;(d)dual-gate `AGENTOS_LIVE_DESKTOP_HERMES=1`(A 需)+ `AGENTOS_LIVE_OPENSHELL=1`(A/B 需);skip-under-verify;script `e2e:live-capstone`。

## (2) In-scope / Out-of-scope
- In-scope:
  - **真 credential screen** helper(`makeArgsCredentialScreen(detectSecret): (TC)=>ScreenOutcome`,reject secret-shaped args)接 baseDeps.screen。
  - **(A) SAFETY live 測**(gate 真 Hermes + 真 OpenShell):真 Hermes 對 intent 提案 → 治理;斷言 stoppedBy ∈ terminal/maxTurns、**propose-only**(Hermes 未自跑)、**deny-by-default**(它的非註冊提案 → denied,execSandbox 0 for them)、credential-blind、ephemeral sandbox create+destroy、bounded;log 真 Hermes 實際提了什麼(觀測)。
  - **(B) SUCCESS live 測**(gate 真 OpenShell;受控提案):注入 `exec.echo {text:"hello"}`/`exec.ls {path:"."}` → 真 OpenShell create→govern→真 exec→真輸出(redact)回饋→destroy;斷言真 {exitCode,stdout} 含預期、propose-only、credential-blind。
  - **secret-arg → denied@screen** 斷言(真 screen)。
  - 小 maxTurns(2–3)+ 緊 cost;ephemeral sandbox finally-destroy;不讀 ~/.hermes;script clean-BLOCK + 非空 guard;不在 verify。
- Out-of-scope（誠實標記):
  - **真 Hermes 自主呼叫我們的工具(MCP 廣告 `session/new.mcpServers` / Design A-MCP)= EXEC4**——(A) 因此只證 SAFETY,(B) 用受控提案。
  - 改 EXEC3a/EXEC1/2/DHB 核(只組合 + 真 screen helper)。
  - sandbox 的零憑證/無 egress provisioning 是**部署事實**——EXEC3b 斷言/記錄,不負責 provision。

## (3) ⚠️ 誠實:真 credential 邊界
`makeExecEffect` 的 redaction 是 **best-effort(只擋已知 secret shape)**——擋不住命令讀 mounted secret 再 base64/拆分。故**真 credential 邊界 = ephemeral OpenShell sandbox 持「零真憑證」(env 只 placeholder/bundleRef)+ 無 outbound 網路**。EXEC3b 須**確認/記錄**該 sandbox 如此 provisioned(部署事實);若不能確認,(B) 只跑不含任何憑證的 echo/ls(本就如此),且**明記** redaction 非邊界。

## (4) 不變量（沿用 EXEC3a + live 證 + NEW 真 screen）
保留:deny-by-default(對真 brain)/ propose-only / commit-before-effect / credential-blind(env + double redact)/ fail-closed / maxTurns+cost / ephemeral-sandbox。NEW:**真 inbound args screen**(secret-shaped declared arg → denied@screen,補 finding②)。

## (5) Test-first / 驗證計畫
- harness in-repo:RED-first 對 **Fake**(skip-under-verify 的 gated 測在 verify 下 skip;harness 邏輯 + 真 screen helper 可用 Fake 單元證:secret-arg→denied@screen;`makeArgsCredentialScreen` mutation 證非空)。
- (A)(B) live:gated,user-initiated。

## (6) Definition of Done（實測）
- [x] harness:`pnpm run verify` **exit 0**(1002 passed + 23 skipped;`args-credential-screen` 6 單元測綠;(A)(B) live skip-under-verify〔load-bearing〕;depcruise 144 modules clean〔reviewer deep-import 親證 bite〕;secret-scan clean;EXEC3a/EXEC1/EXEC2/DHB/pipeline/closed-loop 核**未動**;e2e:live-capstone 不在 verify;無 orphan)。
- [x] **`makeArgsCredentialScreen`(finding② 修)**:secret-shaped arg → `{ok:false}`、wired 為 deps.screen 時 effect 永不達(denied@screen);throw → deny(fail-closed);default = 真 redactSecrets-changed detector;reviewer always-ok mutation → 4 測翻紅。
- [x] **(A) SAFETY / (B) SUCCESS gating + 誠實切分**:(A) dual-gate(真 Hermes+真 OpenShell)斷言 deny-by-default `executed===0`/propose-only/credential-blind/ephemeral-sandbox/bounded + log 真 Hermes 提案(觀測);(B) gate OpenShell、受控 exec.echo 提案 over 真 OpenShell 斷言真 "hello"+"exit=0";**不假稱 autonomous 成功**(autonomous=EXEC4)。
- [x] exec-effect.ts rename(`defaultDetectSecret`→exported `defaultExecSecretDetector`)byte-identical(EXEC1/2 24 測綠);exec-seed-tools 抽取 drift-free(EXEC3a 11 綠,bindings byte-identical)。
- [x] dual-gate + clean-BLOCK exit 0(無 gate)+ 非空 guard(skip/no-passed→FAIL)+ ephemeral sandbox finally-destroy(loop 自有 finally,(B) 斷言 destroyed===created);readinessGated wrapper test-local、verbatim delegate、premise 證實(startSandbox 是 noop shim)。
- [x] **獨立 Opus 4.8 review = PASS**(8 攻擊面 HELD/N/A;零 BLOCKER/MAJOR/MINOR;1 observation〔depcruise runtime 深度-1 廣度,pre-existing,本刀走 barrel〕)。
- [ ] **(A) SAFETY live(你親跑/授權代跑後填)**:真 Hermes + 真 OpenShell:它的提案被治理、deny-by-default/propose-only/credential-blind/bounded/ephemeral-sandbox 成立;log 真 Hermes 提了什麼。
- [ ] **(B) SUCCESS live**:受控 exec.echo/exec.ls over 真 OpenShell → 真輸出回饋,綠;sandbox 零憑證+無 egress 確認/記錄。

## (7) Rollback
- `git revert <merge-sha>`(真 screen helper + 2 gated 測 + script)。EXEC3a/核不受影響。

## (8) Depends-on / blocks + 待你決定
- Depends-on:EXEC3a(`runExecClosedLoop`/bindings)、EXEC2(`makeOpenShellExecCapable` live)、DHB3b(真 Hermes ACP live)、credential-guard(`detectSecret`)。Blocks:**EXEC4**(MCP 廣告 → 真 Hermes 自主呼叫我們的工具)。DAG 無 cycle ☑。
- **待你決定**:① (B) 受控提案的形式(harness 注入 transport double vs 一段 scripted-over-real)。② intent 給真 Hermes 的內容(觀測它提什麼;建議 benign 如「list the current directory」)。③ 是否現在就規劃 EXEC4(MCP 廣告)讓真 Hermes 自主走 success 路徑。
- **誠實前提**:EXEC3b live 證「安全網對真不可信 brain 成立」(A)+「join 對真 OpenShell 端到端成立」(B,受控提案);**真 Hermes 自主呼叫我們的工具 = EXEC4(MCP)**;redaction 非 credential 邊界,sandbox 零憑證+無 egress 才是。
