# SLICE-HDI2: 有用的 governed 工具集（capability × experience 的 capability 半）

- **Phase**: capability — 把 governed 工具集從「證機制的 2 個」長成「真有用」
- **Branches**: slice/hdi2a-readonly-tools（read-only 安全集）、slice/hdi2b-bounded-exec（bounded general exec,posture 決定)
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: HDI2a <= 1 day(每工具 = manifest + binding + 測,純加法);HDI2b = 設計+posture 決定
- **狀態**: **DRAFT（待你核准開工 + 決定範圍)**

## (0) 動機
EXEC4c-b + HDI1 已 live 證:真 Hermes(ACP 與 Desktop config.yaml 兩條路)自主呼叫我們的 governed 工具 → 真 OpenShell exec + 統一 WORM。但目前只有 **exec.echo / exec.ls**(證機制用)。要讓 Hermes Desktop 使用者「發揮最大功用」,需把 **bounded governed 工具集**長出來——**這是純加法**:每個工具 = 一個 manifest + 一個 binding,自動被 MCP server 廣告(`tools/list`)+ 治理(`tools/call → runGovernedToolCall`),`exec.**` allow rule 已涵蓋。

## (1) ⚠️ 為何加工具是安全的（已建的護欄,grounded)
新工具**不**放寬任何治理——既有 binding 模型 + sandbox 邊界已擔保:
- **composer-fixed argv**:`ExecToolBinding{argvPrefix, argSchema(strict), toArgv}` → argv 是**純字串 vector**,在一處組成,**永不 shell 字串、永不 `sh -c`、永不生 brain 原始輸入**。brain 提的 `"; rm -rf /"` 只是某 arg 的字面值(被 `cat`/`ls` 當檔名),非 shell 注入。
- **strict argSchema**:unknown key → reject(brain 無法夾帶 argv)。
- **credential-blind screen**:secret-shaped arg → denied@screen。
- **output cap + redact**:`makeExecEffect` 64KB cap + `redactSecrets`。
- **真邊界 = ephemeral 零憑證 no-egress sandbox**:每 loop 新建、零真憑證、無 outbound 網路、用完銷毀 → 即使跑任意程式也被 sandbox 封死(無可竊、無法外傳、不留存)。
- **deny-by-default / commit-before-effect / 共享 WORM**:每呼叫經 `runGovernedToolCall`,receipt 先進共享 kernel 鏈才 exec。

## (2) HDI2a — read-only 安全集（建議先做,低風險,即時有用)
純加法:每個 = manifest(`sideEffect:"read"`,idempotent)+ binding + 加進 `seedRegistry`/`seedBindings` + 測。建議首批(read-only,sandbox 內無破壞):
| tool | argvPrefix | strict args | toArgv |
|---|---|---|---|
| `exec.cat` | `["cat"]` | `{path: string}` | `[path]` |
| `exec.head` | `["head"]` | `{path: string}` | `[path]`(head 自身預設 10 行;**首批刻意 string-only,不收數值 arg**,使 `argSchemaToJsonSchema` 無需改) |
| `exec.pwd` | `["pwd"]` | `{}`(strict 空) | `[]` |
| `exec.wc` | `["wc"]` | `{path: string}` | `[path]` |
| `exec.grep` | `["grep","-n","-e"]` | `{pattern: string, path: string}` | `[pattern, path]`(pattern 是字面 arg,非 shell;`-e` 防 pattern 被當 flag) |

(lines 等數值 arg 經 zod `.int().min().max()` 界定;pattern/path 為 string;全部 read-only。)

## (3) HDI2b — bounded general exec（「最大功用」,⚠️ posture 決定）
要真正「一台會自己操作的電腦」,最大化是 **`exec.run {argv: string[]}`**:argvPrefix `[]` + `toArgv: (a) => [...a.argv]` → brain 提**完整 argv vector**(非 shell 字串),**直接 execve(無 sh -c)**。威力:brain 可在 sandbox 跑任意程式(`["python3","-c",…]`、`["node",…]`)。
- **仍 bounded**:純 vector(無 shell 注入)+ **sandbox 封死**(零憑證→無可竊;no-egress→`curl` 等外連被擋;ephemeral→不留存)+ governed(deny-by-default 需 exec.run 註冊+allow)+ credential-blind + output-cap + WORM。
- **⚠️ 但這是 capability-posture 抉擇**:從「白名單少數 read-only 工具」→「allow 任意 argv vector(被 sandbox 封死)」。sandbox 邊界承擔全部風險,故須**確認 sandbox provisioning 真的零憑證+no-egress**(部署事實)。`sideEffect` 標 `"write"`、`requiresApproval` 可設 true(每次經治理 approval)。
- 這是**你的決定**:要不要給 brain 一個「在封死 sandbox 內跑任意程式」的工具(最大功用)vs 維持白名單工具集(更保守)。

## (4) 不變量（沿用,不放寬）
deny-by-default / single-execution-path(每工具經 `runGovernedToolCall`)/ composer-fixed argv(純 vector、永不 sh -c)/ strict argSchema / credential-blind / commit-before-effect / 共享 WORM / output cap+redact / ephemeral 零憑證 no-egress sandbox(真邊界)。**HDI2 不新增治理放寬——只新增 binding。**

## (5) Test-first plan（RED 先行）
- HDI2a:每工具 RED→GREEN(tools/list 含新工具且 schema 由 argSchema 衍生;governed tools/call 經全治理跑真 argv;poisoned-key/secret → isError substrate 0;mutation 證 binding 界定〔如塞 argv key → strict reject〕)。在 verify 內(Fake substrate)。
- HDI2b(若做):exec.run RED→GREEN(argv vector 直跑、**永不 sh -c**〔mutation:若實作走 sh -c → 測翻紅〕;curl-egress 在 live 被 sandbox 擋〔斷言/記錄〕;deny-by-default〔未註冊 exec.run → denied〕)。in-repo Fake 證 join;真 sandbox 封死 = live(用 EXEC4c-b/HDI1 既有 gated live 加一個 exec.run 案例)。
- live(選):把新工具加進 EXEC4c-b/HDI1 的 gated live,證真 Hermes 經兩條路自主呼叫新工具 → 真 exec。

## (6) Definition of Done（實測）
- [x] HDI2a:RED → `pnpm run verify` **exit 0**(1069 passed + 26 skipped;新 `exec-seed-tools.test.ts` 16 測綠;tools/list 自動含 7 工具〔schema 衍生〕;每工具 governed tools/call〔Fake〕argv = binding 純 vector + poisoned-key/secret→isError substrate 0,mutation 證實〔grep-no-e/toArgv/non-strict-schema/exact-set+exec.tac〕;EXEC4a〔createExecMcpServer + argSchemaToJsonSchema〕/EXEC4c bin/EXEC3a/pipeline byte-unchanged;depcruise 152 modules clean〔reviewer deep-import 親證 bite〕;secret-scan clean)。
- [x] 5 新工具(exec.cat/head/pwd/wc/grep):manifest(`sideEffect:"read"`)+ binding(argvPrefix + strict string-only argSchema + toArgv 純 vector,grep `-e` 防 pattern-as-flag、pwd 空物件)+ seedRegistry/seedBindings 註冊;**無治理放寬**(每工具經 `runGovernedToolCall`、deny-by-default、credential-blind、commit-before-effect;allow rule `exec.**` 未改;unregistered 仍 denied@policy)。ripple:`exec-mcp-server/stdio/loopback` 的 exact-list 斷言更新為 7-tool seed set(invariant「只有註冊 bounded 工具」保留、across 4 檔皆 non-vacuous)。
- [x] **HDI2a 獨立 Opus 4.8 review = PASS**(零 BLOCKER/MAJOR;binding-bounds-no-sh-c / no-governance-relaxed / exact-set-bites / schema-no-drift 皆 non-vacuous;1 MINOR〔head 簡化為 {path},已 doc-sync 此表〕+ 1 INFO〔見下〕)。
- [ ] **(追蹤,非阻斷)INFO**:MCP server 的 `MANIFEST_DESCRIPTIONS` 只含 echo/ls,5 新工具的 tools/list description 退回工具名(manifest 本身有 description)。改進 = server 從 registry manifest 取 description(單一來源)→ 讓 brain 對工具用途有更好指引。小幅 EXEC4a 改,可單獨開或併入 HDI2b。
- [x] **HDI2b DONE（merged;user-approved posture)**:`exec.run` manifest(`sideEffect:"write"`,idempotent:false,requiresApproval:false——明確 documented 姿態:邊界=治理 pipeline + sealed sandbox,非互動 gate,使 autonomous loop 可用)+ binding(argvPrefix `[]`、`argSchema z.object({argv: z.array(z.string()).min(1)}).strict()`、`toArgv (a)=>[...a.argv]`)→ 直接 execve argv vector、**永不 sh -c**(grep 全 exec path 無 shell 構造;sh -c wrap mutation 翻 HDI2b-2)。`argSchemaToJsonSchema` 擴充 ZodArray<ZodString>→`{type:array,items:string}`,**其餘 shape〔number/array-of-arrays〕仍 THROW**(accept-any-array mutation 翻紅)+ schema-no-drift。**無治理放寬**(exec.run 走同一 `runGovernedToolCall` 唯一 edge:unregistered→denied@policy、smuggled-key→strict reject、secret-in-argv→denied@screen,皆 substrate 0;allow rule `exec.**` 未改;non-strict mutation 翻 22 測)。exact-set→8〔含 exec.run,移出 forbidden;fs/terminal/shell/command/argv 仍 forbidden〕across 4 檔皆 bite。verify exit 0(1081);runGovernedToolCall/single-execution-path/EXEC4c/EXEC3a/pipeline byte-unchanged(唯一核改=argSchemaToJsonSchema array 支援);獨立 Opus4.8 review PASS(2 INFO:requiresApproval:false 為 documented 姿態;sandbox 零憑證 no-egress 是部署事實〔in-repo 對 Fake 證,真 sandbox containment 走 live〕)。
- [ ] (選)live:真 Hermes 自主呼叫新工具(含 exec.run)→ 真 exec(你親跑/授權代跑)。
- [ ] (選)live:真 Hermes 經 config.yaml/ACP 自主呼叫新工具 → 真 exec(你親跑/授權代跑)。

## (7) Rollback
- `git revert <merge-sha>`(新 manifest/binding 純加法)。移除工具 = 從 seedRegistry/seedBindings 拿掉 → 自動不再廣告。

## (8) Depends-on / blocks + ⚠️ 待你決定
- Depends-on:EXEC3a(`ExecToolBinding`/bindingWrappedExecEffect)、EXEC4a(MCP server 自動廣告/治理)、EXEC4c/HDI1(兩條 live 路徑)、`seedRegistry`/`seedBindings`。Blocks:無。DAG 無 cycle ☑。
- **待你決定**:① **範圍**:只做 HDI2a(read-only 安全集,建議先)vs 也做 HDI2b(bounded general exec,最大功用 + posture 抉擇)。② HDI2a 首批工具清單(上表 5 個?增減?)。③ 若做 HDI2b:exec.run 的 sideEffect/requiresApproval + sandbox 零憑證 no-egress 的部署確認。④ 是否要把新工具也納入 live(真 Hermes 自主呼叫新工具)。
- **誠實前提**:HDI2 是純加法(新 binding),不放寬任何治理;真邊界仍是 ephemeral 零憑證 no-egress sandbox;HDI2b 的「任意 argv」威力完全由 sandbox 封死界定。
