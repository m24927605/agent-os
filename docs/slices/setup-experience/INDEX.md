# Slices: setup experience（讓 Hermes Desktop 使用者「設定即用」)

## 0. 設計判斷(為何不是 TUI)
現有 `agentos` CLI 是 **THIN、零第三方依賴**(Node process.argv/child_process/fs/net、subcommand switch、fail-closed)。設定本質是「一組端點 + 可選整合 + 檢查」,不是豐富互動流,且是一次性 operator 任務 → **宣告式 config + CLI(doctor/setup)優於 TUI**(可重現、可版控、可 CI、守 zero-dep)。TUI 被否決。

## 1. ⚠️ 必先補的真缺口(grounded)
IT1(SpendGuard/AGT turnkey)接的是**三面 surfaces**(`createPersonalShell` 等)。但使用者實際走的是 **Hermes 自主呼叫 → bin(`exec-mcp-server-bin`)→ `runGovernedToolCall`**;bin 的 `buildDeps` **寫死 `InMemoryCostGate` + 無 secondaries**(exec-mcp-server-bin.ts)→ **SpendGuard/AGT 還沒 gate 到 autonomous 路徑**。先補這個,否則 wizard「設了 SpendGuard 卻只 gate surfaces」= 假象。

## 2. 切片(本刀 = 骨;wizard 是糖,延後)
| Slice | 範圍 | 狀態 |
|---|---|---|
| **SETUP1a**(bin 從 config/env 接整合) | bin `buildDeps` 改用 `integrationsFromEnv(process.env)`:`costGate = failClosedCostGate(integ.costGate ?? new InMemoryCostGate(...))`(SPENDGUARD_* 在 bin env〔descriptor mcp_servers.env〕→ SpendGuard gate **autonomous 路徑**;缺→InMemory,byte-identical)+ authorize 折入 `combineDecisions(authorizeToolInvoke(...), evaluateSecondaries(integ.secondaries ?? [], req))`(讓 advisory 在 bin 路徑也生效,與三面一致;AGT 引擎-from-env〔endpoint adapter〕= follow-up,本刀只接 plumbing + SpendGuard 具體接通)。spec:`SETUP1-bin-config-and-doctor.md` | DRAFT |
| **SETUP1b**(`agentos doctor`) | 新 `doctor` subcommand(零依賴,node:net/fs/child_process):preflight PASS/FAIL/SKIP + 修正提示 + fail-closed exit。檢查:Hermes on PATH / bin built(dist)/ Hermes config.yaml 有 agentos-exec(`hermes mcp list`)/ OpenShell 可達 / kernel 可達 / SpendGuard sidecar 可達(若 SPENDGUARD_UDS_PATH 設,否則 SKIP)。spec:同檔 | DRAFT |
| **SETUP2**(`agentos setup` wizard + `agent-os.config.yaml`) | 宣告式 config + 驗證(fail-closed)+ 寫 Hermes config.yaml mcp_servers + readline 補問。**延後**(doctor + bin-wiring 是骨) | OPEN |

## 3. 不變量
fail-closed(partial SpendGuard config→throw;doctor 必要檢查失敗→非零 exit)/ bin 路徑治理 == 三面(同 combineDecisions 折法)/ injected 只能更嚴(cost 拒、secondaries advisory)/ 缺省 byte-identical(無 SPENDGUARD_*→bin 同今日 InMemory)/ zero-dep / credential-blind(config/env 只非-secret;doctor 不印值)。

## 4. 誠實前提
- SETUP1a 讓 **SpendGuard 真的 gate autonomous(bin)路徑**(具體);**AGT 引擎-from-env 需 endpoint adapter = follow-up**(bin 已接 secondaries fold plumbing,等 adapter)。
- doctor 是 preflight,不改任何治理。
- wizard(SETUP2)延後;真信任根(TR2)、sandbox 零憑證 provisioning 仍是部署事實。
