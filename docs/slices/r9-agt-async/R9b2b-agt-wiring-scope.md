# SLICE-R9b-2b: AGT 接線 — projection 建構 + scope gate + config 驅動註冊

- **Phase**: R9 — 第 2 刀之 2b（integration capstone:讓 AGT 真的在 autonomous 路徑參與)
- **Branch**: slice/r9b2b-agt-wiring
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 可行性(grounded)
R9b-2a 的 AGT secondary 是 inert。R9b-2b 接線:在 authorize closure 為 in-scope(effectful)tool 建 R9b-1 projection → 附到 PolicyRequest → AGT secondary 消費;並用 `integrationsFromEnv` config 驅動註冊 AGT secondary。**可行性確認**:`BoundExecCall = { tool; context; args? }`——`tc.args`(brain 宣告的 args)**在 authorize 階段就在**(screen 已先擋 secret;effect 才用 `argSchema` 驗證 → argv)。closure 可取 `tc.args` → 用 binding 的 `argSchema` 驗證 → 建 projection。

## (1) 範圍(精確接點)
1. **projector 宣告(tool-declared)**:`ExecToolBinding`(exec-closed-loop.ts)加 optional `governanceProjector?: (validatedArgs: unknown) => GovernanceProjection`。`exec.run` binding 宣告 `buildExecRunProjection`(R9b-1);**讀取型 tool(echo/ls/cat/...)不宣告**。
2. **shared scope/projection helper**(vendor-neutral,如 `src/runtime/brain/adapters/hermes/governance-projection-for-call.ts` 或 policy 區):`buildProjectionForCall(tc, bindings, manifest/registry, scope): GovernanceProjection | undefined` ——
   - 查 tool 的 manifest `sideEffect` + binding;**in-scope** 判定:`AGT_SCOPE=effectful`(預設)→ `sideEffect ∈ {write,destructive}` 或 `requiresApproval`;`AGT_SCOPE=all` → 也含 read。
   - in-scope **且** tool 有 `governanceProjector` **且** `argSchema.safeParse(tc.args)` 成功 → `projector(validated)`;否則 `undefined`(out-of-scope / 無 projector / 驗證失敗〔effect 反正會 deny〕)。
3. **4 個 authorize closures 接**(personal/developer/enterprise/bin):呼叫 helper → 結果附到 `req.governanceProjection`(present 才附;absent → 不附 → 今日 byte-identical)。其餘(PDP/fold/redact)不變。
4. **AGT secondary scope-skip**(endpoint-secondary.ts,R9b-2a):`evaluate(req)` 若 `req.governanceProjection` **absent** → 回 **allow(advisory abstain,不呼叫 transport)**;present 才呼叫 transport。→ 讀取型/out-of-scope tool **永不觸發 AGT**(latency:只 effectful 問 AGT)。**安全**:AGT advisory,abstain = 無 advisory 意見、PDP 仍治理(非 fail-open)。
5. **config 驅動註冊**(`integrationsFromEnv`,config-root):`AGT_UDS_PATH`(+ `AGT_SCOPE`、`AGT_TIMEOUT_MS`)設 → 建 `createAgtDecisionTransport` + `createAgtEndpointSecondary` → **merge 進 `secondaries`**(與既有 pass-through 並存)。partial config → fail-closed(報錯,沿用 IT1b 語義)。未設 → 不加 → byte-identical。

## (2) 不變量
- **AGT 未配置 → byte-identical**(無 AGT secondary、無 projection;今日全測不變)。
- **配置但 out-of-scope(讀取型)→ AGT abstain**(無 projection → secondary 回 allow,不呼叫 transport;effectively byte-identical 行為 + 無 latency)。
- **配置 + effectful(exec.run)→ AGT 參與**:projection(R9b-1 best-effort credential-blind)建自**驗證後**的 args;AGT advisory,**PDP sovereign / any-deny-wins**(allow 不放寬 PDP deny);**configured-down → deny**(R9b-2a fail-closed)。
- **credential-blind**:projection 來自 binding-validated args(screen 已先擋 secret)+ R9b-1 best-effort redact;送 transport 只有 neutral + projection(R9b-2a)。
- fail-closed(partial AGT config → 啟動報錯;AGT down → deny〔僅 in-scope〕)。
- depcruise:helper/closures vendor-neutral;grpc 仍限 runtime/agt;`integrationsFromEnv` import runtime/agt(runtime 區,合法)。

## (3) Test-first plan（RED 先行;fake transport/secondary）
- helper:exec.run(write,有 projector,args 合法)→ projection;exec.echo(read,scope=effectful)→ undefined;exec.run scope=all → 也建;args 驗證失敗 → undefined。mutation:helper 對 read tool 也建 projection → 翻紅(scope 失效)。
- closure(4 面或共用測):attach projection → AGT secondary 收到;exec.run + fake AGT deny → denied;exec.echo → AGT secondary abstain(allow,fake transport **未被呼叫**〔spy 計數 0〕);AGT allow + PDP deny → deny。mutation:secondary 無 projection 仍呼叫 transport → 翻紅(latency/scope 破)。
- integrationsFromEnv:`AGT_UDS_PATH` 設 → secondaries 含 AGT secondary;partial(設 scope 但無 uds?或無效)→ fail-closed;未設 → 無 AGT、byte-identical。mutation:partial 靜默通過 → 翻紅。
- **byte-identical**:AGT 未配置 → 三面 + bin + EXEC4c + SETUP1a 全測不變綠。
- credential-blind:in-scope call 帶 canary args → 送 transport 的只有 neutral+redacted projection,無 raw args。

## (4) Definition of Done（實測)
- [x] **DONE（merged)**:`ExecToolBinding.governanceProjector?`(exec.run 宣告 `buildExecRunProjection`;讀取型無)+ `buildProjectionForCall`(3-gate:scope〔effectful 預設/all〕→ projector → `argSchema.safeParse(tc.args)`)+ 4 closures 接(present 才附 `req.governanceProjection`)+ AGT secondary scope-skip(無 projection → allow abstain,**不呼叫 transport**)+ `integrationsFromEnv` AGT 註冊(`AGT_UDS_PATH`+`AGT_SCOPE`/`AGT_TIMEOUT_MS`,fail-closed,merge `extra.secondaries`)。RED → verify **exit 0**(1258 passed + 26 skipped;4 新測檔 44 測;**always-append mutation 翻 7〔byte-identical〕、drop-skip 兩層翻 count-0、isInScope→true 翻 read、drop-attach 翻 3、invalid-config 翻 fail-closed**;depcruise no-vendor-in-core 綠+bite;secret-scan clean;無新依賴)。獨立 Opus4.8 review PASS:AGT-未配置 byte-identical(`===` verbatim)、scope gate 跳 transport、effectful participates + PDP-sovereign + down→deny、credential-blind 端到端、surface degrade 誠實(靜態 no-op + 每處明示 + cast 安全)。**1 MINOR**(三面 parity scaffolding〔`bindings:undefined`→恆 undefined,只有 bin 真建 projection〕已誠實註解、選擇性未來清理,無需動作)。
- **誠實**:**AGT 實際 gate 的是 bin(autonomous)路徑**(三面 SDK surfaces 因不走 exec bindings → degrade no-op)。這正是使用者實際走的路徑。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(binding optional 欄位 + helper + closure 接點 + secondary skip + config AGT 純加法;未配置 byte-identical)。
- Depends-on:R9a(async)、R9b-1(projection)、R9b-2a(transport/adapter/PolicyRequest 欄位)、IT1b(integrationsFromEnv)、manifest sideEffect。Blocks:R9c(config.json agt 區塊 + setup + doctor + gated e2e:live-agt)。
- **誠實前提**:R9b-2b 讓 AGT **在 autonomous 路徑真的參與**(fake-transport 測證行為);**真 AGT live 仍需 operator 的 Python sidecar**(R9c gated `e2e:live-agt`,在你提供 engine 前 BLOCKED)。SETUP2 的 `agt` config 區塊 + doctor check 留 R9c。
