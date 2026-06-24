# Slices: Agent OS → Hermes Desktop 整合

## 0. 北極星對位（為何不做 Web UI）
HEADLINE = capability × experience。**體驗 = Hermes Desktop**（站在巨人肩膀:它的 TUI/desktop/oneshot 介面就是使用者面）；**Agent OS = 被 Hermes 呼叫的 governed BODY/工具**（經 MCP）。機制**已 live 證**（EXEC4c-b:真 Hermes spawn 我們的 governed MCP bin → tools/list+tools/call → 治理 → 真 OpenShell exec + 共享 WORM）。HDI 不做 UI,而是讓**真的 Hermes Desktop 使用者**接上 Agent OS。

## 1. Grounded 事實（從安裝的 Hermes 源碼確認，2026-06-24）
- Hermes Desktop/CLI 讀 **`~/.hermes/config.yaml`** 的 **`mcp_servers`**（map;會 auto-reload,cli.py 有 watcher）。格式（cli-config.yaml.example）:`<name>: {command, args:[...], env:{KEY: "val"}}`（env 是 **YAML map**,不同於 ACP 的 `List[EnvVariable]`)；或 `{url: ...}`（HTTP/SSE)。
- **`hermes mcp add <name> --command <cmd> --args ... --env KEY=val`**（hermes_cli/subcommands/mcp.py）+ `hermes mcp remove`/`list`:Hermes 自己的 CLI 就能 upsert config.yaml 的 mcp_servers——**安裝 helper 委派給它**,我們不手改 YAML（Hermes 擁有其格式)。
- **`hermes -z/--oneshot -p "<prompt>"`**(+ `--hooks-auto-accept`):headless 一次性執行、只印最終結果 → **desktop-path live 確認可自動化**(讀 config.yaml mcp_servers)。
- 已具備且 live-proven:`exec-mcp-server-bin`（Agent OS 編譯 bin,Hermes spawn 它經 stdio 講 MCP）、REAL-mode 共享-kernel WORM、`execMcpStdioDescriptor`（ACP 形狀）。

## 2. 切片分解
| Slice | 範圍 | 狀態 |
|---|---|---|
| **HDI1**(install + desktop-path 確認) | ① **install helper**:委派 `hermes mcp add agentos-exec --command node --args <abs bin> --env AGENTOS_OPENSHELL_ENDPOINT=… --env AGENTOS_KERNEL_INGEST_ENDPOINT=…`(idempotent;script clean-block 若無 hermes;**純函式建 argv 可單元測**,不需 Hermes)。② **desktop-path gated live**:`hermes --oneshot -p "用 echo 工具印 hello" --hooks-auto-accept` 讀 config.yaml → 自主發現+呼叫我們 governed exec.echo → 真 OpenShell exec + WORM(**config.yaml 路徑,異於 EXEC4c-b 的 ACP 路徑**)。證「Hermes Desktop 使用者真的用得到」。spec:`HDI1-hermes-desktop-mcp-install.md` | ✅ **in-repo DONE**(`buildHermesMcpAddArgv`〔--args 最後、--env KEY=VALUE、credential-blind THROW〕+ 委派 `hermes mcp add` 的非破壞 idempotent script〔no-hermes clean-block + manual snippet〕+ HERMES_HOME-隔離 desktop-path live 測;10 單元測;core byte-unchanged;獨立 Opus4.8 review PASS 零 findings;真實 config 前後乾淨)。**✅ LIVE-RUN 通過(2026-06-25)**:真 Hermes Desktop 經 **config.yaml direct-write** 讀 mcp_servers → spawn bin → 自主 tools/list+tools/call exec.echo → 真 OpenShell exec(exit=0+hello)+ 共享鏈 entries=1 + deny-by-default。三輪釘出:`hermes mcp add` 互動式→改 direct-write;隔離缺 auth→user 授權 clone creds(fs-copy、永不印、afterAll 清);旗標錯→`--oneshot <prompt> --accept-hooks`。credential-clone safety 獨立 review HELD。**Hermes Desktop 使用者真的用得到 Agent OS。**|
| **HDI2**(有用的 governed 工具集 — capability 半) | 超越 exec.echo/ls,長出 bounded governed 工具 bindings(每個 = manifest + `ExecToolBinding{argvPrefix,strict argSchema,toArgv}` 永不 sh -c + allow rule + 測)。先 read-only 安全集(exec.cat/head/pwd),再考慮 bounded general exec。每工具威力被 binding 界定;deny-by-default/credential-blind/commit-before-effect/WORM。spec:`HDI2-governed-toolset.md`(待開) | OPEN(HDI1 後) |

## 3. 不變量（沿用 + NEW）
沿用:deny-by-default / credential-blind / commit-before-effect / 共享-kernel WORM / single-execution-path（每工具經 `runGovernedToolCall`）/ composer-fixed argv（永不 sh -c）/ WE-stay-executor（bin 是 Agent OS 編譯碼）。NEW:**install idempotent + 非破壞**(委派 `hermes mcp add`/`remove`,不 clobber 使用者 config.yaml);**config.yaml 路徑 ≡ ACP 路徑**(兩者都 → Hermes register_mcp_servers → 我們同一個 bin → 同一治理)。

## 4. 誠實前提
- 機制已 live（EXEC4c-b/ACP）;HDI1 = desktop 使用者的 onboarding + config.yaml 路徑的 live 確認;HDI2 = 有用工具集。
- **不做 Web UI**（Hermes Desktop 即體驗）。
- credential 邊界 = 零憑證 no-egress sandbox(不變);config.yaml env 內 endpoints 是非-secret host:port。
- **絕不把使用者的 Hermes 金鑰 / .env 帶進我們的工具呼叫**;install 只寫非-secret 的 command/args/endpoints。
