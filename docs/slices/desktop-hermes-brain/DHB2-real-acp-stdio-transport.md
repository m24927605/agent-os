# SLICE-DHB2: 真 `hermes acp` ACP-over-stdio transport + live 證明

- **Phase**: R11-family（live brain runtime）
- **Branches**: slice/dhb2a-acp-stdio-transport（in-repo）、slice/dhb2b-live-desktop-hermes（live）
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: DHB2a <= 1 day（TS only）；DHB2b = live 驗證(user-initiated)
- **狀態**: **DHB2a DONE**（真 ACP-stdio transport,fake 子進程證,獨立 Opus4.8 PASS + M1/M2)。**DHB2b harness DONE**（merged;gated live test + 升級 e2e 腳本〔真 `hermes acp` drive〕;skip-under-verify load-bearing、BLOCKED-clean + 非空 guard + RC 傳遞、credential-blind〔M3 probe initialize-only 不花額度〕、reused 未動;獨立 Opus4.8 reviewer=PASS)。**DHB2b LIVE-RUN = 待你親跑**(`AGENTOS_LIVE_DESKTOP_HERMES=1 pnpm run e2e:live-desktop-hermes`,用你 Hermes credits)。

## (0) 動機 + 現況 + ⚠️ 誠實分界
DHB1 已用 **Fake ACP transport** 證接縫 + credential-blind + fail-closed。DHB2 把 `DesktopHermesTransport` 接到**真本機 `hermes acp`**(JSON-RPC over stdio)。
- **DHB2a(in-repo,可在 verify 內證)**:`AcpStdioTransport implements DesktopHermesTransport` —— spawn `hermes acp` 子進程、走 ACP JSON-RPC over stdio handshake、把 `session/update` 轉成 DHB1 的 `AcpUpdateFrame`(重用 `parseFrame`)。**用 fake `hermes acp` 腳本(in-tree,吐 canned JSON-RPC 幀)單元測**:handshake、frame 解析、fail-closed、credential-blind —— **不需真模型呼叫、不花 credits**。
- **DHB2b(live,gated,user-initiated)**:對**真 `hermes acp` + 你已認證的 Hermes**(真模型)跑 `e2e:live-desktop-hermes`,確認**確切 ACP dialect** + **propose-only** + intent→提案→治理→effect 全鏈。**會用你 Hermes 帳號的 model credits + 觸及你的 credentials**,故**由你啟動**(設 `AGENTOS_LIVE_DESKTOP_HERMES=1` 親跑;我不擅自跑)。
- **誠實**:DHB2a 證 transport 的 protocol/解析/fail-closed/credential-blind(fake 子進程);「真的接上你 Hermes + 確切 dialect + propose-only」由 DHB2b live 證。

## (1) ID + Title
SLICE-DHB2 —（DHB2a)`AcpStdioTransport`:spawn `hermes acp`(可設命令,預設 `hermes acp`)→ JSON-RPC over stdio:`initialize`(protocol version + client capabilities)→ `session/new`(cwd)→ `session/prompt`(intent 作 prompt content)→ 讀串流 `session/update` 通知 → yield `AcpUpdateFrame`(經 DHB1 `parseFrame` → `HermesTurn`);**propose-only**:對 ACP `session/request_permission`(Hermes 要求執行 tool)**一律 deny/不授權**——只**擷取**該 tool_call 當提案交 Agent OS 治理,**絕不讓 Hermes 自行執行**;fail-closed(spawn 失敗/非零退出/壞 JSON-RPC/protocol error → stream error → TurnSource 停);credential-blind(只送 intent + ACP 協定幀,never 送 Agent OS secret,never 讀 Hermes api_key)。fake `hermes acp` 腳本單元測。（DHB2b)gated live e2e 升級成真 drive。

## (2) Goal（一句話）
把 DHB1 的 transport 接縫接到**真本機 `hermes acp`**:in-repo 用 fake 子進程證 ACP protocol/解析/propose-only/fail-closed/credential-blind(DHB2a),再由你親跑 live 證真 Hermes 全鏈(DHB2b)。

## (3) In-scope / Out-of-scope
- **DHB2a in-scope（in-repo、verify 內）**:
  - `AcpStdioTransport implements DesktopHermesTransport`(`src/runtime/brain/adapters/hermes/acp-stdio.ts`;經 hermes barrel)。
  - ACP JSON-RPC over stdio client:`initialize`/`session/new`/`session/prompt` 送出 + `session/update` 串流讀入 + 反序列化成 `AcpUpdateFrame`(line-delimited / Content-Length framing 依 ACP);錯誤/EOF/非零退出 → fail-closed。
  - **propose-only**:`session/request_permission`(client←agent request)一律回 **deny**(不讓 Hermes 跑 tool);tool_call update 仍擷取成提案幀。需在 DHB2b 對真 ACP 行為確認(`--check` + 實跑)。
  - **credential-blind**:出站只有 intent + ACP 協定欄位;**從不讀/不送** `~/.hermes` 的 `.env`/`auth.json`/api_key。
  - 單元測(fake `hermes acp`:in-tree 腳本/子進程 double,吐 canned JSON-RPC):handshake 正確序;`session/update` → AcpUpdateFrame → `parseFrame` → HermesTurn;**permission request → deny**(propose-only);spawn 失敗/非零/壞幀/EOF mid-stream → **fail-closed**(停串、不 yield ok);intent-only 出站(spy 子進程記錄 stdin → 無 Agent OS secret)。
  - `pnpm run verify` 綠;depcruise(adapters/hermes/ 內、經 barrel);secret-scan clean。
- **DHB2b(live,gated,user-initiated;不在 verify)**:
  - `scripts/e2e-live-desktop-hermes.sh` 從骨架升級成真 drive:gate on `command -v hermes` + `AGENTOS_LIVE_DESKTOP_HERMES=1` →（你親跑)spawn 真 `hermes acp`、送一個 intent、確認回串 session/update + tool_call、propose-only(Hermes 不自跑)、全鏈 intent→提案→治理→effect(用 Fake/in-memory substrate)。
  - 確認**確切 ACP dialect**(Hermes 實際用的 method/field;`hermes acp --check`);若與 DHB2a 假設不符 → 修 DHB2a 的 mapping(回到 verify 內重證)。
  - **誠實**:此步用你 Hermes 的 model credits + 認證,**由你啟動**;我提供 harness,不擅自跑。
- **Out-of-scope**:改 `HermesBrainShim`/`HermesTurn`/screen/Brain Port(重用);Hermes 端設定/認證(你的領域,credential-blind);OpenShell 路徑(那是 `e2e:live-hermes`)。

## (4) Design delta + 依賴方向
- DHB2a:新增 `AcpStdioTransport`(+ JSON-RPC over stdio 小 client);重用 DHB1 `AcpUpdateFrame`/`parseFrame`/`DesktopHermesTurnSource`。可能用 node 內建 `child_process` + WebStreams,無新依賴(若 ACP framing 需極小 helper 則 in-tree)。檔在 `adapters/hermes/`,經 barrel。
- **PUBLIC**:`AcpStdioTransport`(+ 設定:command/args/cwd/timeout)。

## (5) Test-first plan（RED 先行,DHB2a）
- fake `hermes acp` 子進程(in-tree 腳本,吐 canned JSON-RPC):
  - handshake 正確(initialize→session/new→session/prompt 序;client capabilities 正確)。
  - `session/update`(agent_message_chunk + tool_call)→ AcpUpdateFrame → parseFrame → HermesTurn → BrainEvent → 治理通過。
  - **propose-only**:fake 發 `session/request_permission` → transport 回 **deny**(斷言送出的 response 是 deny;Hermes 不獲授權)。
  - **fail-closed**:spawn 不存在的命令 / 子進程非零退出 / 壞 JSON-RPC 幀 / stdout EOF mid-stream → stream error、TurnSource 停、不 yield ok。
  - **credential-blind**:spy 子進程記錄收到的 stdin → 只有 intent + ACP 協定,**無任何 Agent OS secret**;Hermes api_key 從不被讀。
- 在 `AcpStdioTransport` 前紅。

## (6) Definition of Done（待實測填）
- **DHB2a**（實測,DONE）:
  - [x] RED → `pnpm run verify` **exit 0**(fake-子進程單元測 11 tests 綠;**949 passed + 18 skipped**;depcruise 138 modules clean〔reviewer deep-import 親證 not-to-internal bite〕;secret-scan clean;live e2e 不在 verify)。
  - [x] handshake(initialize→session/new→session/prompt 序)/`session/update`→AcpUpdateFrame→parseFrame→治理通過/propose-only(`session/request_permission`→cancelled、Hermes 不自跑)/fail-closed(spawn-fail/非零/壞幀/EOF 皆 throw→停)/credential-blind(stdin 只 intent+協定、child env minimal 不繼承 parent secret) 各有 mutation 證非空(auto-approve→propose-only 紅;swallow-error→4 fail-closed 全紅;secret-on-prompt→credential-blind 紅;`minimalEnv` spread `process.env`→child-env 測試紅;`-32601` 改成 success→fs/terminal-deny 測試紅)。
  - [x] **採納 reviewer M1**(child-env 不繼承 parent secret 專測:parent `sk-…` canary 不入 child env)+ **M2**(fs/terminal agent→client request → `-32601` deny-by-default、無 host access)。
  - [x] 真子進程(`node <fake.mjs>` line-delimited JSON-RPC over real stdio,非 in-process stub);child SIGKILL-in-finally 於 done/error/**early-break** 皆觸發,**無 orphan**(reviewer 親證 early-break)。minimal client capabilities(無 fs/terminal)。
  - [x] 接縫三檔(shim/port/screen)+ DHB1 desktop.ts + live e2e/package.json e2e entry **未動**;重用 DHB1 parseFrame/AcpUpdateFrame/TurnSource。
  - [x] **獨立 Opus 4.8 review = PASS**(8 攻擊面 HELD/N/A;core-safety 4 項 non-vacuous;2 MINOR〔M1/M2〕已採納補測;2 INFO〔string JSON-RPC id、wire-format 假設〕記為 DHB2b dialect 確認項)。
- **DHB2b harness（DONE,merged）**:
  - [x] gated live test `src/runtime/brain/adapters/hermes/desktop.live.test.ts`(gate on `AGENTOS_LIVE_DESKTOP_HERMES==="1"`,verify 下 **skip**〔load-bearing,reviewer always-on mutation 證 vitest 會跑〕);構 `AcpStdioTransport`→`DesktopHermesTurnSource`→`HermesBrainShim`→`governBrainStream`,斷言 ≥1 真 frame / governed 提案 / **propose-only 無檔被建** / credential-blind;log M3(initialize-only probe:id number/string)+ M4(observed kinds + 提案)dialect 診斷。
  - [x] 升級 `scripts/e2e-live-desktop-hermes.sh`:跑 gated vitest + 保留兩 clean-BLOCK preflight + **非空 guard**(skip/no-passed → FAIL)+ RC 傳遞。
  - [x] `pnpm run verify` exit 0(949 + 19 skipped,live test skip;e2e 不在 verify);BLOCKED-clean(gate 未設→exit 0);reused 檔未動;獨立 Opus4.8 review = PASS。
- **DHB2b live-run（待你親跑後填)**:
  - [ ] `AGENTOS_LIVE_DESKTOP_HERMES=1 pnpm run e2e:live-desktop-hermes` 對真 `hermes acp` 綠:intent → session/update + tool_call、propose-only(Hermes 不自跑)、intent→提案→治理→effect 全鏈;確切 ACP dialect 確認(必要時修 DHB2a mapping 回 verify 重證)。**reviewer DHB2b 待確認項**:(M3)真 Hermes 若用 **string JSON-RPC id**(DHB2a 只配對 number id;現會 fail-closed 卡 timeout)→ 視需要擴 id 配對;(M4)wire-format 假設(newline-delimited〔非 Content-Length〕、`protocolVersion:1`、`session/request_permission` outcome 形狀 `{outcome:{outcome:"selected",optionId}}`、`stopReason`)對真 `hermes acp --check`/實跑核對。
  - [ ] 誠實記錄:用了你 Hermes 的 model credits;credential-blind 維持(我從不讀你的 key)。

## (7) Rollback
- `git revert <merge-sha>`(DHB2a:新 transport + 單元測;DHB2b:e2e 腳本升級)。DHB1/接縫不受影響。

## (8) Depends-on / blocks
- Depends-on:**DHB1**(`DesktopHermesTransport`/`AcpUpdateFrame`/`parseFrame`/`DesktopHermesTurnSource`)、HermesBrainShim、screen、Brain Port。
- Blocks:無(desktop Hermes 作 brain 全鏈完成)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:DHB2a 證 ACP-stdio transport 的 protocol/解析/propose-only/fail-closed/credential-blind(fake 子進程,verify 內);真 Hermes 全鏈 + 確切 dialect = DHB2b live,**由你啟動**(用你的 credits/credentials)。
