# SLICE-SETUP1: bin 從 config/env 接整合(SpendGuard gate autonomous 路徑)+ `agentos doctor`

- **Phase**: setup experience（讓整合真正 gate 使用者實際走的路徑 + 一鍵 preflight)
- **Branches**: slice/setup1a-bin-integrations、slice/setup1b-agentos-doctor
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: SETUP1a <= 1 day、SETUP1b <= 1 day（TS only;零新依賴)
- **狀態**: **DRAFT（待你核准開工)**

## (0) 動機 + ⚠️ 缺口
IT1 把 SpendGuard/AGT 接進三面 surfaces,但**使用者走的是 Hermes 自主 → bin(`exec-mcp-server-bin`)**,而 bin 的 `buildDeps` 寫死 `InMemoryCostGate` + 無 secondaries → **整合沒 gate 到 autonomous 路徑**。SETUP1a 補這個(讓 SpendGuard 真的 gate bin);SETUP1b 給 `agentos doctor`(設定前後一鍵驗證前置)。

## (1) SETUP1a — bin 從 env 接 integrationsFromEnv
- `exec-mcp-server-bin.ts` 的 `buildDeps`(REAL 路徑):
  - **costGate**:`const integ = integrationsFromEnv(process.env); const cost = failClosedCostGate(integ.costGate ?? new InMemoryCostGate(1_000_000));`。bin 由 Hermes 以 descriptor 的 `mcp_servers.env` spawn,故 `SPENDGUARD_UDS_PATH`+topology 在 bin 的 env → `integrationsFromEnv` 建 `SpendGuardCostGate` → **gate autonomous 路徑**;未設 → InMemory(**byte-identical**,EXEC4c subprocess 測不變)。`failClosedCostGate`(IT1a)使 SpendGuard throw → structured deny(不洩、不傳播)。
  - **authorize(折入 advisory secondaries,與三面一致)**:把 `authorize: (tc) => { const d = authorizeToolInvoke(req, registry, allowRules); return {effect:d.effect, reason:d.reason}; }` 改為折 `combineDecisions(<authorizeToolInvoke 的 PolicyDecision>, evaluateSecondaries(integ.secondaries ?? [], req))` → map 回 `{effect, reason}`。PDP 仍 sole deny 權威、any-deny-wins。**secondaries 缺省 [] → byte-identical**。
  - **FAKE 模式不變**:`AGENTOS_EXEC_MCP_FAKE=1` 仍 InMemory + 無 secondaries(integrationsFromEnv 在 FAKE 下不讀 SPENDGUARD_*,或 FAKE 短路)——EXEC4c-a subprocess 測 byte-identical。
- **誠實 scope**:本刀**具體接通 SpendGuard costGate**(env-driven)+ **secondaries fold plumbing**(讓 advisory 在 bin 路徑生效)。**AGT 引擎-from-env(一個呼叫 AGT endpoint 的 `AgtSecondaryPolicy` evaluate adapter)= follow-up**(env 帶不了 code;需 AGT-as-endpoint)。
- **(選)** bin 的 MCP tools/call result 可順帶 surface settlement(pipeline settlement fix 後 executed outcome 帶 `settlement`):若 settlement denied/overrun,在 isError:false 的 content 註記(讓 Hermes 知預算 overrun)。本刀可做或留 follow-up。

## (2) SETUP1b — `agentos doctor`(零依賴 preflight)
- CLI 加 `case "doctor": return doctorCommand(rest, env);`(沿用 thin switch + fail-closed default)。
- `doctorCommand`(node:net/fs/child_process,零新依賴)逐項檢查,印 `PASS/FAIL/SKIP <name> — <hint>`,**任一必要項 FAIL → 回非零 exit**(fail-closed,使用者跑 Hermes 前就知缺什麼):
  1. **Hermes on PATH**(`command -v hermes`)— 必要;hint:裝 Hermes。
  2. **bin built**(`dist/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.js` 存在)— 必要;hint:`pnpm run build`。
  3. **registered**(`hermes mcp list` 含 `agentos-exec`)— 必要;hint:`hermes mcp add …` 或 `install-hermes-desktop.sh`。
  4. **OpenShell 可達**(TCP connect `AGENTOS_OPENSHELL_ENDPOINT` ?? `127.0.0.1:17670`)— 必要;hint:起 OpenShell gateway。
  5. **kernel 可達**(TCP connect `AGENTOS_KERNEL_INGEST_ENDPOINT` ?? `127.0.0.1:50051`)— 必要(commit-before-effect);hint:起 partitioned kernel(`--partitions tenant-bin`)。
  6. **SpendGuard sidecar**(若 `SPENDGUARD_UDS_PATH` 設:UDS 存在/可連)— **conditional**(未設→SKIP「SpendGuard off→InMemory budget」)。
- **credential-blind**:doctor 只檢查可達性 + 印 host:port/路徑/key 名,**絕不印任何值/金鑰、不讀 ~/.hermes 內容**(用 `hermes mcp list` 這種 read-only 命令,非讀 config 檔)。

## (3) 不變量
fail-closed(partial SpendGuard config→throw〔IT1b〕;doctor 必要項 FAIL→非零)/ **bin 路徑治理 == 三面**(同 combineDecisions+evaluateSecondaries 折法;PDP sovereign;injected 只能更嚴)/ **缺省 byte-identical**(無 SPENDGUARD_*、無 secondaries → bin 同今日;EXEC4c subprocess 測不變)/ zero-dep(node 內建)/ credential-blind(env/config 只非-secret;doctor 不印值)。

## (4) Test-first plan（RED 先行)
- SETUP1a(verify 內,Fake transport):bin REAL deps 注入 Fake SpendGuard env → costGate 是 SpendGuard(非 InMemory);always-deny SpendGuard costGate → tools/call denied@cost(substrate 0);注入 always-deny secondary → denied(advisory);**無 SPENDGUARD_*/secondaries → byte-identical**(EXEC4c-a subprocess FAKE 測續綠;buildDeps 預設路徑同今日)。mutation:bin 忽略 integ.costGate → SpendGuard-deny 測翻紅。
- SETUP1b(verify 內):`doctorCommand` 對 Fake env(TCP 連到測試起的 listener / 不存在的 port)→ PASS/FAIL 正確;必要項 FAIL → 非零 exit;SpendGuard 未設 → SKIP;**不印任何值**(spy console,斷言無 secret-shaped 輸出)。mutation:必要項 FAIL 卻回 0 → 測翻紅。
- live(選):起 OpenShell+kernel+(SpendGuard sidecar)→ `agentos doctor` 全 PASS;Hermes 自主呼叫經 SpendGuard-gated bin。

## (5) Definition of Done（待實測填)
- [x] **SETUP1a DONE（merged)**:bin `buildDeps` 改 `failClosedCostGate(opts?.costGate ?? integ.costGate ?? new InMemoryCostGate(1_000_000))`(`integ=integrationsFromEnv(process.env)`)→ **SPENDGUARD_* 在 bin env → SpendGuard gate autonomous 路徑**;authorize 折 `combineDecisions(authorizeToolInvoke→PolicyDecision, evaluateSecondaries(integ.secondaries ?? [], req))`(bin 治理 == 三面)。`BuildBinOpts` 加 costGate?/secondaries? 測縫;FAKE 跳過 integrationsFromEnv → byte-identical。RED → verify **exit 0**(1131 passed + 26 skipped;新 setup1a 6 測;**EXEC4c-a/b subprocess 13 測 byte-identical 綠**;drop-wiring mutation 翻 deny-cost+fail-closed、ignore-secondaries 翻 deny-secondary〔no-relax 維持綠=PDP sovereign〕;PolicyRequest 7 欄前後一致 + safeParse fail-closed + structural cast 純型別不致不安全 allow;configured-but-down SpendGuard→雙重 fail-closed deny@cost;depcruise no-vendor-in-core 綠;secret-scan clean;EXEC4a/pipeline/三面/IT1b byte-unchanged)。獨立 Opus4.8 review PASS(8 攻擊面 HELD/N/A;1 MINOR:combineDecisions(pdp,[]) 重包 reason 字串〔effect/stage 一致、consumer 看 stage〕,與三面格式一致,非缺陷)。
  - **⚠️ 追蹤(AGT-on-bin follow-up)**:secondaries 接進 bin 後須像三面(IT1a)一樣 `redactSecrets(combined.reason)`——bin reason 入 WORM,不可信 secondary reason 可能帶 secret。現 secondaries=[] 無洩漏;AGT-endpoint adapter slice 必補此 redact + 測。
- [x] **SETUP1b DONE（merged)**:`agentos doctor` subcommand(零依賴 node:child_process/fs/net;injectable `DoctorProbes` 縫供測)——6 項 preflight(Hermes on PATH / bin built / registered〔`hermes mcp list` read-only〕/ OpenShell 可達 / kernel 可達 = 必要;SpendGuard sidecar = conditional,未設 SKIP)印 `STATUS name — hint`,**fail-closed exit**(任一必要項 FAIL→非零;SKIP 不致敗)。**credential-blind**:只印 STATUS/name/host:port/key-名/static hint,**不印 env 值、不讀 ~/.hermes**;`splitEndpoint` 丟 `user:pass@` userinfo + `scheme://` → PASS 印**重解析 host:port**(非 raw endpoint)。RED → verify **exit 0**(1144 passed + 26 skipped;13 doctor 測;tally-hardcoded-0 mutation 翻 6、echo-env-value 翻 credential-blind、raw-endpoint 翻 embedded-creds 測;manifest/verify byte-unchanged;**零新依賴**〔package.json/lock 空 diff〕;depcruise/secret-scan clean;無 orphan listener)。獨立 Opus4.8 review PASS(8 攻擊面 HELD/N/A;1 MINOR〔endpoint 值 echo〕已採納修為 host:port-only + embedded-creds 測)。doctor 是 **preflight——不改治理、不起服務、不寫 config**(那是 SETUP2 wizard,延後)。
- [ ] (選)文件:README 設定段補「跑 `agentos doctor` 驗證前置」+「SpendGuard env 設在 mcp_servers.env 即 gate autonomous 路徑」(可隨 SETUP2 一起,或現補)。

## (6) Rollback
- `git revert`(bin buildDeps 改 + doctor subcommand 純加法)。缺省 byte-identical,revert 無副作用。

## (7) Depends-on / blocks + ⚠️ 待你決定
- Depends-on:IT1b(`integrationsFromEnv`)、IT1a(`failClosedCostGate`/注入)、EXEC4c(bin)、CLI(thin switch)、policy(`combineDecisions`/`evaluateSecondaries`)。Blocks:SETUP2 wizard。
- **待你決定**:① bin 的 AGT 引擎-from-env:本刀只接 SpendGuard + secondaries plumbing,**AGT-endpoint adapter 留 follow-up**(建議)vs 一併做。② doctor 哪些是「必要」vs SKIP(上面的分法?)。③ bin 是否順帶把 settlement overrun/deny surface 給 Hermes(選)。④ SETUP2 wizard 何時開。
- **誠實前提**:SETUP1a 讓 SpendGuard 真 gate autonomous 路徑(AGT 引擎-from-env 是 follow-up);doctor 是 preflight 不改治理;wizard 延後;真信任根/ sandbox provisioning 仍部署事實。
