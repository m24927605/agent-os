# Slices: turnkey 整合（SpendGuard cost gate + AGT advisory policy)— 注入 + config 驅動

## 0. 動機（誠實的現況)
SpendGuard(`SpendGuardCostGate` + `createDecisionLedgerTransport`)與 AGT(`SecondaryPolicyAdapter` + `combineDecisions` advisory dedup + maker-checker TOCTOU 借鏡)的 **vendor-neutral 接縫/adapter 已建、已證**(SpendGuard 有對真 sidecar 的 gated live `e2e:live-spendguard`;AGT 是 advisory dedup 接縫)。**但都還沒 turnkey**:三面 composition root **寫死** `InMemoryCostGate`(personal/bootstrap.ts:155、enterprise:488)+ `combineDecisions(decision, [])`(空 secondaries;personal:225、enterprise:439)。本系列把它們做成「**設定即開**」:可注入 + env/config 驅動的 composition root。

## 1. Grounded 注入面（2026-06-25)
- `createPersonalShell(opts)`:`PersonalShellOpts {budget?, allowToolInvoke?, toolRegistry?}`(DVx 已加 `toolRegistry?`,樣式:`opts.toolRegistry ? authorizeToolInvoke(req, reg, allow) : evaluatePolicy(req, allow)`)。
- `createEnterpriseFleet`:**per-tenant** `costByTenant: Map<tenantId, CostGate>`(每租戶獨立 `InMemoryCostGate`)+ `combineDecisions(decision, [])`。**隔離必須保**。
- `createDeveloperKit`:同樣的 DVx 注入 pattern。
- `SpendGuardCostGate(transport: LedgerTransport)` implements `CostGate`;transport = `createDecisionLedgerTransport({udsPath, timeoutMs?, tenantIdAssertion?, budgetClaim?{budgetId,unitId}})`(**budgetClaim 缺 → reserve fail-CLOSED**;UDS 為非-secret 路徑)。
- `SecondaryPolicyAdapter {evaluate(req: PolicyRequest): PolicyDecision}`;`combineDecisions(pdpDecision, secondaries)`:**PDP 唯一 deny 權威、any-deny-wins、malformed/缺席=deny**。

## 2. 切片
| Slice | 範圍 | 狀態 |
|---|---|---|
| **IT1a**(注入面,純 in-repo,零姿態) | 三面加 **`costGate?`** + **`secondaries?: readonly SecondaryPolicyAdapter[]`** 注入(DVx 樣式):注入→用、缺→**byte-identical**(既有測不變);Enterprise 用 **per-tenant `costGateFor?(tenantId)`** 保隔離。**injected 只能更嚴**(cost 拒、secondaries advisory any-deny-wins);PDP sovereign。spec:`IT1-turnkey-injection-config.md` | ✅ **DONE**(三面注入 costGate?/secondaries?〔Enterprise per-tenant costGateFor?〕,缺省 byte-identical〔既有 e2e 未改+綠〕,injected 只能更嚴,per-tenant 隔離,無 vendor import;+ failClosedCostGate/write-side redactSecrets〔developer 證 load-bearing〕/NullCostGate fallback;verify 1101;獨立 Opus4.8 review PASS)|
| **IT1b**(config 驅動 composition root = 真 user init) | env/config helper:`SPENDGUARD_UDS_PATH`(+ budget topology)→ 建 `SpendGuardCostGate(createDecisionLedgerTransport(...))`;secondaries config → 掛 advisory adapter(AGT-ready 注入點);**malformed config → fail-closed(deny/throw at startup,絕不靜默退成無治理)**;傳入三面。使用者設 env → 即開。spec:同檔 | ✅ **DONE**(`integrationsFromEnv`/`costGateForFromEnv` in src/runtime/spendguard〔vendor 區〕讀 SPENDGUARD_UDS_PATH+topology→SpendGuardCostGate;fail-closed on partial〔silent-fallback mutation 翻 6 測〕;credential-blind;per-tenant 獨立;secondaries 透傳=AGT 注入點;no-vendor-in-core 綠;README turnkey 文件;verify 1118;獨立 Opus4.8 review PASS 零 findings)|

## 3. ⚠️ 誠實 scope
- **SpendGuard = 具體可 turnkey**(adapter+transport 已備;config 接 udsPath + budgetClaim)。但:`release()` RPC **未接**(R11 follow-up,reservation 不自動釋放);需**外部 sidecar 在跑**(docker compose demo)+ budgetClaim 設定(缺則 reserve fail-closed);transport error fail-CLOSED。
- **AGT = 接縫 + config 注入點,非 bundled 引擎**。本刀交付**可注入的 advisory secondaries + config**(你提供/指向一個 AGT 背書的 `SecondaryPolicyAdapter`);**repo 不附 AGT 引擎本身**(那是你的或另一刀)。advisory-only,永不 deny 權威。
- 不放寬治理:注入的 cost/secondaries 只能**更嚴**;PDP 仍 sovereign;缺省=byte-identical。

## 4. 交付順序
IT1a(注入面,純加法、零風險、既有測 byte-identical)→ IT1b(config 驅動 root)。各刀 doc-first + RED + verify 綠 + 獨立 Opus 4.8 review + merge;SpendGuard 真路徑由 `e2e:live-spendguard`(需 Docker + agentic-spendguard repo)gated 證。
