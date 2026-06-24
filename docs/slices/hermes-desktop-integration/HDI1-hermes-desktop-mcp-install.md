# SLICE-HDI1: Agent OS → Hermes Desktop 安裝 + desktop-path live 確認

- **Phase**: product-experience（Hermes Desktop = 體驗面;Agent OS = governed BODY via MCP）
- **Branches**: slice/hdi1-hermes-desktop-install（in-repo helper + 單元測）、live = 同檔 gated test
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: helper + 測 <= 1 day（TS only;新增依賴 0）;live-run = user-initiated
- **狀態**: **in-repo DONE（merged）**;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer=PASS(零 findings:install argv 正確〔--args 最後、--env KEY=VALUE,對真 `hermes mcp add --help` 校準〕/ credential-blind〔secret-shaped env→THROW、fail-closed-on-detector-throw〕/ script 非破壞 + no-hermes clean-block / live HERMES_HOME 隔離,mutation 證實;core byte-unchanged;**真實 ~/.hermes config review 前後皆乾淨**)。**desktop-path LIVE-RUN 待跑**。

## (0) 動機 + ⚠️ 為何不是 Web UI（grounded)
北極星 HEADLINE = capability × experience,但**體驗就是 Hermes Desktop**（站在巨人肩膀）。我們**不造 UI**;我們讓 Hermes Desktop 使用者把 Agent OS 的 governed 工具接進他既有的 Hermes。機制**已 live 證**（EXEC4c-b:真 Hermes spawn `exec-mcp-server-bin` → tools/list+tools/call → 治理 → 真 OpenShell exec + 共享 WORM）。HDI1 補的是**「真 Desktop 使用者」與「已證機制」之間的最後一哩**:把 bin 註冊進 `~/.hermes/config.yaml` 的 `mcp_servers`(desktop/CLI 路徑,異於我們 live 走的 `hermes acp` session/new 路徑)+ 用真 Desktop 確認。

Grounded(安裝的 Hermes 源碼):
- 讀 **`~/.hermes/config.yaml` → `mcp_servers`**(map,auto-reload watcher;cli.py:9927)。
- **`hermes mcp add <name> --command <cmd> --args <...> --env KEY=val`**(+ `remove`/`list`,hermes_cli/subcommands/mcp.py):Hermes 自己 upsert config.yaml → **helper 委派給它**(不手改 YAML;Hermes 擁有格式,含 env-map 形狀)。
- **`hermes -z/--oneshot -p "<prompt>" --hooks-auto-accept`**:headless 一次性、只印最終結果 → desktop-path live 可自動化。

## (1) ID + Title
SLICE-HDI1 —(a)`agentos`-side install helper(純函式建 `hermes mcp add` argv + 一支薄 script 委派執行);(b)desktop-path gated live 測(真 Desktop `hermes --oneshot` 讀 config.yaml → 自主發現+呼叫我們 governed exec.echo → 真 OpenShell exec + 共享 WORM);(c)`e2e:live-hermes-desktop` script + dual-gate;skip-under-verify。

## (2) In-scope / Out-of-scope
- In-scope:
  - **install helper(純函式)** `buildHermesMcpAddArgv({name, binPath, endpoints})`:回傳 `["mcp","add","agentos-exec","--command","node","--args",binPath,"--env","AGENTOS_OPENSHELL_ENDPOINT=…","--env","AGENTOS_KERNEL_INGEST_ENDPOINT=…", …]`(endpoints 為非-secret host:port)。**純、可單元測、不需 Hermes**。
  - **薄 script** `scripts/install-hermes-desktop.sh`:解析已 build 的 bin 絕對路徑 → idempotent(`hermes mcp remove agentos-exec` 容錯 + `hermes mcp add …`)→ `hermes mcp list` 驗證;`hermes` 不在 PATH → clean BLOCK(exit 0,印手動 config.yaml 片段)。**非破壞**(只動 `mcp_servers.agentos-exec`,委派 Hermes 自己改)。
  - **desktop-path gated live 測** `hermes-desktop.live.test.ts`(dual-gate `AGENTOS_LIVE_DESKTOP_HERMES=1` + `AGENTOS_LIVE_OPENSHELL=1`,選配 kernel gate):用**隔離的 HERMES config**(臨時 `HOME`/`HERMES_CONFIG` 或臨時 config.yaml,**不污染使用者既有 config**)寫入 mcp_servers.agentos-exec → `hermes --oneshot -p "Use the available echo tool to print the word hello" --hooks-auto-accept`(+ provider/model 旗標)→ 斷言:輸出含真 'hello'/exit=0 的證據、≥1 我們 governed exec 經 config.yaml 路徑被自主呼叫;(kernel gate 開)共享 kernel 鏈 `tenant-bin` entries≥1;deny-by-default 對它其他工具;bounded。fail-closed-with-diagnostic;teardown(臨時 config + sandbox)。
  - in-repo 可證:`buildHermesMcpAddArgv` 單元測(正確 argv + endpoints 為非-secret + 無金鑰)+ script 無-hermes clean-BLOCK + 非空 guard。
- Out-of-scope(誠實標記):
  - **Web/GUI UI**——不做(Hermes Desktop 即體驗)。
  - **有用工具集成長**(exec.cat/head/… general exec)= HDI2。
  - 改 EXEC4a/4c bin / pipeline / 核(只加 install helper + desktop-path 測)。
  - sandbox 零憑證/無 egress provisioning = 部署事實(斷言/記錄,不 provision)。

## (3) ⚠️ 誠實:憑證與隔離
- install **只寫非-secret**(command/args/bin 路徑/OpenShell+kernel host:port endpoints)進 config.yaml;**絕不**寫使用者的 Hermes 金鑰、`~/.hermes` 內容、或任何 .env。
- desktop-path live 測用**隔離 config**(臨時 HOME/HERMES_CONFIG),不改動使用者既有 `~/.hermes/config.yaml`(除非使用者親自跑 install script)。
- 真 credential 邊界仍 = 零憑證 no-egress sandbox(redaction best-effort,非邊界)。

## (4) 不變量
沿用:deny-by-default / credential-blind / commit-before-effect / 共享-kernel WORM / single-execution-path（每呼叫經 `runGovernedToolCall`)/ composer-fixed argv（永不 sh -c)/ WE-stay-executor。NEW:**install idempotent + 非破壞**(委派 `hermes mcp add/remove`,只動 agentos-exec 鍵,容錯重跑);**config.yaml 路徑 ≡ ACP 路徑**(兩者都 → Hermes register_mcp_servers → 同一個 governed bin → 同一治理 + 共享 WORM);**install 不寫 secret**。

## (5) Test-first plan（RED 先行）
- in-repo(verify 內):`buildHermesMcpAddArgv` RED→GREEN(正確 `mcp add` argv;endpoints 入 `--env`;**斷言輸出無金鑰/secret 形狀**,mutation:塞 secret → 測翻紅)。script 無-gate/無-hermes clean-BLOCK + 非空 guard。
- desktop-path live(gated,user-initiated):隔離 config + `hermes --oneshot` 自主呼叫 → 真 exec;非空 guard(skip/no-pass→FAIL)。

## (6) Definition of Done（實測）
- [x] in-repo:RED → `pnpm run verify` **exit 0**(1046 passed + 26 skipped;`hermes-desktop-install` 10 單元測綠;EXEC4a/4c/pipeline/核 byte-unchanged〔EXEC4c/4a 30 測綠〕;depcruise 152 modules clean〔reviewer deep-import 親證 bite〕;secret-scan clean〔canary runtime-built〕;live skip-under-verify load-bearing、不在 verify;無 orphan)。
- [x] `buildHermesMcpAddArgv` 正確建 `["mcp","add","agentos-exec","--command","node","--env",…K=V,"--args",binPath]`(**`--args` 最後**〔REMAINDER〕、`--env` KEY=VALUE、對真 `hermes mcp add --help` 校準)+ **credential-blind**(secret-shaped env→THROW、detector throw→THROW fail-closed;`renderHermesConfigYamlSnippet` 同 guard);mutation 翻紅(--args-order / secret-guard-removal / fail-open)。script **非破壞**(委派 `hermes mcp add/remove`、只動 agentos-exec 鍵、不手改 config.yaml)+ 無-hermes clean-BLOCK + manual snippet + idempotent(remove+add 容錯)+ secret→abort 在碰 Hermes 前。
- [x] **獨立 Opus 4.8 review = PASS**(零 BLOCKER/MAJOR/MINOR;8 攻擊面 HELD/N/A;**真實 ~/.hermes config review 前後皆 `hermes mcp list`=乾淨**)。註:writer dev 中誤跑 install script(`hermes` 在真實 PATH),但無-TTY 提示處取消未持久化;經我 + reviewer 兩次獨立 `hermes mcp list` 確認真實 config 乾淨、已遠程化。
- [x] **desktop-path LIVE-RUN ✅ 通過(2026-06-25,user-authorized 代跑)**:起 partitioned kernel(tenant-bin)+ `AGENTOS_LIVE_DESKTOP_HERMES=1 AGENTOS_LIVE_OPENSHELL=1 AGENTOS_LIVE_KERNEL_ENDPOINT=… pnpm run e2e:live-hermes-desktop` **綠**(真 Hermes 9.8s)。三輪 live 釘出實況:(1)`hermes mcp add` 互動式無 headless 旁路 → 改**直接寫 config.yaml**;(2)隔離 HERMES_HOME 缺 provider/auth → **user 授權 clone**(fs byte-copy `config.yaml`+`auth.json`+`auth.lock`+`.env` 進 temp、永不印值、afterAll 遞迴刪+斷言消失);(3)`hermes --oneshot -p … --hooks-auto-accept` 旗標錯(argparse exit 2)→ 修為 **`--oneshot <prompt> --accept-hooks`**(對 `hermes --help` 校準)。修後:`one-shot exit=0; output 'hello'`、`sawEchoedOutput=true`、**`SHARED kernel chain 'tenant-bin': entries=1`**(統一 evidence)、deny-by-default、bounded。**證「Hermes Desktop 使用者經 config.yaml 路徑真的用得到 Agent OS → 真 exec」。** 真實 ~/.hermes 未改、temp 已清、無 orphan。獨立 Opus4.8 reviewer=PASS(credential-clone safety HELD:fs-copy-only/零內容 logging/temp 所有路徑皆清/排除 install 目錄/真 home read-only)。

## (7) Rollback
- `git revert <merge-sha>`(install helper + script + desktop-path 測)。bin/EXEC4a/4c/核不受影響。使用者端移除 = `hermes mcp remove agentos-exec`。

## (8) Depends-on / blocks + ⚠️ 待你決定
- Depends-on:EXEC4c-a/b(`exec-mcp-server-bin` + 共享-kernel WORM)、EXEC4a(governed handle)、DHB(真 Hermes)、真 OpenShell + kernel(live)。Blocks:HDI2(有用工具集)。DAG 無 cycle ☑。
- **待你決定**:① install 方式:**委派 `hermes mcp add`(建議,Hermes 擁有格式)** vs 自寫 YAML merge vs 純文件片段。② desktop-path live 用 `hermes --oneshot`(headless,建議)vs 手動確認。③ HDI1 完成後是否續開 HDI2(read-only 安全工具集先行)。
- **誠實前提**:HDI1 證「desktop 使用者經 config.yaml 路徑用得到已 live 的 governed 機制」;**有用工具集 = HDI2**;不做 UI;真 credential 邊界 = 零憑證 no-egress sandbox。
