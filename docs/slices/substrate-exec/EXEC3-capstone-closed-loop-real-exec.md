# SLICE-EXEC3（capstone): 把真 exec 接進 DHB3 閉環 — desktop Hermes 提案 → 治理 → 真命令 → 真輸出 → 續推

- **Phase**: capstone（join DHB3 閉環 × EXEC1/2 真 exec)
- **Branches**: slice/exec3a-closed-loop-real-exec（in-repo)、slice/exec3b-live-capstone（live)
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: EXEC3a <= 1–1.5 day（TS only）；EXEC3b = live(user-initiated)
- **狀態**: **EXEC3a DONE（merged）**;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS(⚠️ 核心 argv-binding 無任意命令 + 7 不變量經 mutation 證實;full-bypass mutation → `bash -c rm -rf /` 達 effect 翻紅;pipeline/EXEC1/2/DHB1-2 byte-unchanged)。**EXEC3b OPEN**(live capstone,user-initiated)。

## (0) 動機 + ⚠️ 最高風險(不可信 brain 驅動真命令)+ 誠實分界（grounded,設計探索 task wagswj0il)
所有零件已各自 live:DHB3 閉環(`runClosedLoop`,desktop Hermes propose-only 多輪)、EXEC1/2 真 exec(`makeExecEffect`/`makeOpenShellExecCapable`,真 OpenShell sandbox 跑真命令)。EXEC3 **JOIN**:把 `deps.effect` 由 canned stub 換成真 exec,於是 **desktop Hermes 提案 → 治理 → 真命令(sandbox)→ 真輸出(redacted)→ Hermes 續推**。**這是全產品安全風險最高的接縫——把 UNTRUSTED brain 連到 REAL 命令執行。**
- **關鍵威脅(grounded)**:`authorizeToolInvoke` 的 deny-by-default **只到 name-level**(authorize.ts:31-33 註明不看 resourcePattern);`ToolManifest`(manifest.ts:15-27)**無 command/argv 欄位**。故「註冊工具」**不是 bounded 命令**——若讓 brain 供 raw argv,name 檢查擋不住 `rm -rf /` / `bash -c` / curl-exfil。
- **NEW 信任接縫(本刀核心)= argv-binding**:brain **只提案「註冊工具名 + declared args」,永不供 argv[0]/raw argv**;composer 持一張與 ToolRegistry 並行的 `Map<toolName,{argvPrefix: string[], argSchema}>`;effect wrapper:① 查 binding(缺→fail-closed deny)② strict argSchema 驗 brain args(未知/多餘 key→deny)③ 組 `argv = [...argvPrefix, ...validatedPositionals]` 為**純 vector(永不 shell string、永不 `sh -c`)**→ 才呼真 `makeExecEffect`。
- **誠實分界**:
  - EXEC3a(in-repo,verify-green):Fake substrate(echo argv)+ scripted Hermes → 證**整個 join 邏輯 + 全不變量**,零 live。
  - EXEC3b(live capstone,user-initiated,gated):真 OpenShell ephemeral sandbox + 真 desktop Hermes ACP,小 maxTurns + 緊 cost。
  - **redaction 是 best-effort(只擋已知 secret shape,exec-effect.ts:129-130)——擋不住命令讀 mounted secret 再 base64/拆分編碼**。故**真正的 credential 邊界 = ephemeral sandbox 持「零真憑證」(env 只 placeholder/bundleRef)+ 無 outbound 網路**,**非** redaction。EXEC3b 須確認 sandbox provisioned with no real credential + no egress(部署/provisioning 事實)。

## (1) ID + Title — Design A
SLICE-EXEC3 = composer-held command-template binding(`{argvPrefix, argSchema}`)+ **ephemeral per-loop sandbox** + effect 注入**閉環之上**。brain 只提案註冊工具 + declared args;wrapper 組 argv 純 vector;真 exec 經 `makeExecEffect`/`makeOpenShellExecCapable`。

## (2) Seam change（最小;pipeline/runGovernedToolCall 不動)
1. **closed-loop.ts 一處最小修**:`runClosedLoop` 的 deps generic 由固定 `GovernedToolCallDeps<GovernedCall,R>`(:95)放寬為 `<TC extends GovernedCall, R>`,TC 可帶**optional** `args`;line 130 `const call = { tool: p.tool, context }` → `{ tool: p.tool, context, args: p.args } as TC`(**args 保持 optional**,既有 closed-loop.test.ts 不變;pipeline.ts 只讀 .tool/.context,:71-83,安全)。
2. **新檔(不改既有模組)**`src/runtime/brain/adapters/hermes/exec-closed-loop.ts`:`runExecClosedLoop(transport, substrate, baseDeps, bindings, context, intent, opts)` —— 擁有 **sandbox create/start → destroy(fail-closed finally)** + 組 `deps = {...baseDeps, effect: bindingWrappedExecEffect(substrate, sandboxId, bindings, detectSecret)}` → `runClosedLoop`。binding wrapper(查 binding→驗 argSchema→組 argvPrefix+args→`makeExecEffect`)亦此檔。

## (3) EXEC3a（in-repo)/ EXEC3b（live capstone)
- **EXEC3a(verify 內,無 model/docker/~/.hermes)**:substrate=`FakeSandboxAdapter`(echo argv.join);transport=in-tree fake `hermes acp`(`FAKE_ACP_SCENARIO=loop`,frames 帶 `args:{argv}`〔line-130 forward 後〕);deps.effect=binding-wrapped `makeExecEffect` over Fake。證 join:propose 註冊 exec 工具 → registry+binding admit → commit → Fake exec → redacted 真輸出回饋 → 續推(turns>=2)+ 全不變量,RED-first。
- **EXEC3b(live,user-initiated,gated `*.live.test.ts`)**:同 Design A composer;substrate=`makeOpenShellExecCapable(real OpenShell)` over **真 ephemeral sandbox**(loop 起建、finally destroy);transport=真 DuplexDesktopHermes ACP。**小 maxTurns(2-3)+ 緊 cost** 限首次真-effect blast radius。echo-hello 端到端。**會用真 OpenShell + 真 Hermes credits;由你親跑/授權代跑。**

## (4) 不變量（保留 5 + NEW 2,各有測)
- 保留 **brain-untrusted/deny-by-default(只准註冊工具)**:每提案重入 runGovernedToolCall→authorize,未註冊→denied@policy,不到 effect。
- 保留 **commit-before-effect(在真命令前)**:`makeExecEffect` 只在 commitBeforeEffect 的 effect callback 跑(pipeline.ts:85-89);abort commit→execSandbox 0 calls。
- 保留 **credential-blind env 進 + output 出**(+ 閉環再 redact 一次,double)。
- 保留 **fail-closed**(`{ok:false}`→序列化 result line,無假 exit 0)。
- 保留 **blast-radius(maxTurns + cost)**——現在因 effects 為真而**真有意義**。
- **NEW ephemeral-sandbox containment**:compose helper loop 起 create、finally destroy(host-damage bound);sandbox 持零真憑證 + 無 egress 才是真 credential 邊界。
- **NEW argv-binding 信任接縫**(最高價值):brain 只供 declared params;argv[0]+flag 由 composer 固定;wrapper 以 strict schema 拒未知/多餘 arg key;**永不 shell-string/`sh -c`**。

## (5) Test-first plan（RED 先行,EXEC3a,對 Fake)
- RED1 join happy:scripted Hermes propose 註冊 exec 工具 + `args:{argv}` → `runExecClosedLoop` + Fake → turns>=2、每提案經治理、Fake exec 真輸出回饋。
- RED2 **惡意提案 denied-不執行-loop 續行**:(a) 未註冊工具名 → denied@policy、execSandbox 0;(b) 註冊工具但帶 binding schema 拒的多餘/未知 arg key → deny;loop 安全續行(回饋 "DENIED")。
- RED3 credential-blind 雙向:(a) env 帶 runtime-built `sk-` canary → makeExecEffect deny、execSandbox 0;(b) Fake exec stdout echo canary → 回饋文字 redacted、canary 不在。
- RED4 blast-radius cap:`loop_forever` + maxTurns=3 → turns=3、stoppedBy=maxTurns、effectCalls=3(真-effect 數有界);緊 cost 變體 → 超預算 deny。
- RED5 commit-before-REAL-effect:appender reject → 真 makeExecEffect/execSandbox **0 calls**、outcome denied@commit、回饋含 "DENIED" 非 "result of"(無假結果)。
- RED6 ephemeral-sandbox lifecycle:createSandbox/startSandbox 在首提案前、destroySandbox 在 finally(即使 transport throw / maxTurns)皆跑;mutation(不 destroy)→ 紅。

## (6) Definition of Done（實測）
- [x] EXEC3a:RED → `pnpm run verify` **exit 0**(996 passed + 21 skipped;join 測 11/11;**pipeline/runGovernedToolCall/EXEC1/EXEC2/DHB1-2 byte-unchanged + 既有測〔closed-loop 12 / exec-effect 12 / exec-buffered 12〕綠**;depcruise 142 modules clean〔reviewer deep-import 親證 not-to-internal bite〕;secret-scan clean;live 不在 verify;無 orphan)。
- [x] **⚠️ argv-binding 無任意命令(核心,非 vacuous)**:argv 只在 1 處建(`exec-closed-loop.ts:127` `[...argvPrefix, ...toArgv(validated)]`)、**無 `sh -c`/`bash -c`/shell-string**;未知/多餘 arg key 被 strict argSchema 拒(makeExecEffect 0 calls);**reviewer full-bypass mutation(wrapper 轉 raw args 為 argv)→ `["bash","-c","rm -rf /"]` 達 execSandbox → 6 測翻紅**(證不可信 brain 無法執行任意命令)。
- [x] 不變量:deny-by-default(未註冊→denied@policy、absent binding→deny、empty argv→ExecCommandSpecSchema.nonempty deny,0 exec)/ commit-before-REAL-effect(appender reject→exec 0、denied@commit)/ credential-blind(env guard deny + double redact + audit 無 raw args)/ fail-closed(無假 exit 0)/ maxTurns(loop_forever+maxTurns=3→execCalls=3)/ ephemeral-sandbox(create-before + **destroy-in-finally 即使 throw/maxTurns**,remove-finally → 兩路翻紅)各 mutation 證非空。
- [x] **獨立 Opus 4.8 review = PASS**(8 攻擊面 HELD/N/A)。Findings(非阻斷):①`as unknown as TC` cast 降型別檢查(contained);②(test-coverage,→ EXEC3b)測試 `screen` 為 permissive stub,未對 declared args 做 credential-screen——真 composition 接真 screen;env guard+double redact+零憑證 sandbox 已獨立證(defense-in-depth);③(MAJOR-with-tracking,**pre-existing 非本刀引入**)depcruise `not-to-internal` 把 src/runtime/* 視為單一 module、runtime 內 deep import 不抓,本刀只走 barrel,tracked。
- [ ] **EXEC3b(你親跑/授權代跑後填)**:`<gated env> …` 真 OpenShell + 真 Hermes:propose→govern→真命令→真輸出→續推,小 maxTurns/緊 cost,綠;**接真 inbound screen + 斷言 secret-shaped declared arg → denied@screen(finding②)**;sandbox 零真憑證+無 egress 確認;dialect 分歧→fail-closed 揭露。

## (7) Rollback
- `git revert <merge-sha>`(closed-loop.ts 2-行 + 新 exec-closed-loop.ts + 測)。pipeline/EXEC1/2/DHB1-3 不受影響;args optional 向後相容。

## (8) Depends-on / blocks + ⚠️ 待你決定（open decisions)
- Depends-on:DHB3(`runClosedLoop`)、EXEC1(`makeExecEffect`)、EXEC2(`makeOpenShellExecCapable`)、ToolRegistry/authorizeToolInvoke、runGovernedToolCall/commit-before-effect。Blocks:無(capstone)。DAG 無 cycle ☑。
- **待你決定(寫進 spec)**:
  1. **初始允許的 exec 工具集**(最小安全種子):建議 1–3 個唯讀工具,如 `exec.echo`(argvPrefix `['echo']`、零 brain arg)、`exec.ls`(argvPrefix `['ls']`、一個驗證過的 path arg)。要哪些 + 各 sideEffect 分類?
  2. **ephemeral sandbox 預設 vs adopt-existing**:建議 **ephemeral per-loop create+destroy** 為預設(隔離/blast-radius);adopt-existing 僅顯式 opt-in。
  3. **首次真-effect 的 per-loop cost/turn 上限**:DHB3a 預設 maxTurns=12 / 測用 1M token;EXEC3b 真 exec 建議**更緊(maxTurns 2–3 + 小 token cap)**。
  4. **binding 位置**:Design A(composer 持 side Map,manifest 凍結,現在 ship)vs Design B(擴 `ToolManifest` 加 optional exec block,registry-native 單一來源)。建議 **A 現在、B 後續**。
- **誠實前提**:EXEC3a 證 join 邏輯 + 全不變量(Fake);真命令在真 sandbox + 真 Hermes 回饋-邊 = EXEC3b/live;**redaction best-effort,真 credential 邊界 = sandbox 零憑證+無 egress**。
