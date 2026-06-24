# SLICE-IT1: turnkey SpendGuard / AGT — 三面注入 + config 驅動 composition root

- **Phase**: integrations turnkey（讓已建的 SpendGuard/AGT 接縫「設定即開」)
- **Branches**: slice/it1a-integration-injection（注入面)、slice/it1b-config-root（config 驅動)
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: IT1a <= 1 day（純注入,DVx 樣式)；IT1b <= 1 day（config helper)
- **狀態**: **DRAFT（待你核准開工 + 定 open decisions)**

## (0) 動機
SpendGuard(`SpendGuardCostGate`)與 AGT(advisory `SecondaryPolicyAdapter` + `combineDecisions`)**已建、已證**,但三面 composition root **寫死 `InMemoryCostGate` + 空 secondaries** → 沒 turnkey。本刀:① 三面可注入 `costGate?`/`secondaries?`(DVx 樣式,缺→byte-identical);② env/config 驅動 root,讓使用者設 env(`SPENDGUARD_UDS_PATH` 等)即接上真 SpendGuard + advisory。**不放寬治理**——注入只能更嚴,PDP 仍 sovereign。

## (1) IT1a — 注入面（純 in-repo,零姿態,DVx 樣式)
- `createPersonalShell(opts)` + `PersonalShellOpts` 加:
  - `readonly costGate?: CostGate;` → `const cost = opts.costGate ?? new InMemoryCostGate(budget);`(缺→現狀 byte-identical)。
  - `readonly secondaries?: readonly SecondaryPolicyAdapter[];` → `combineDecisions(decision, opts.secondaries ?? [])`(缺→`[]` byte-identical)。
- `createDeveloperKit`:同上(`costGate?` + `secondaries?`)。
- `createEnterpriseFleet`:**per-tenant 保隔離** —— 加 `readonly costGateFor?: (tenantId: string) => CostGate;`(缺→`new InMemoryCostGate(budget)` per tenant,現狀)+ `readonly secondaries?: …`(per-tenant 共用 advisory,或 `secondariesFor?(tenantId)`,見 open decision)。**A 租戶的 SpendGuard gate 絕不影響 B**。
- **不變量(IT1a)**:注入的 `costGate` 只能**拒更多**(它是 CostGate,reserve 可 deny;絕不放寬);`secondaries` 是 **advisory**(`combineDecisions` any-deny-wins、PDP sovereign、malformed/缺=deny);**缺省 → 既有路徑 byte-identical**(所有現有測不變)。
- RED-first;non-vacuity:注入一個 always-deny `costGate` → 該 call denied@cost;注入一個 always-deny secondary → denied(advisory deny wins);注入 always-allow secondary → 仍受 PDP + any-deny 約束(不放寬);缺省 → byte-identical(diff 既有測 0)。

## (2) IT1b — config 驅動 composition root（真 user init)
- 一個 helper(如 `composeIntegrationsFromEnv(env): { costGate?, secondaries? }` 或 per-surface `personalIntegrationsFromEnv()`):
  - **SpendGuard**:讀 `SPENDGUARD_UDS_PATH`(+ budget topology config:`SPENDGUARD_BUDGET_ID`/`SPENDGUARD_UNIT_ID`,+ 可選 `SPENDGUARD_TENANT_ASSERTION`)→ `new SpendGuardCostGate(createDecisionLedgerTransport({udsPath, budgetClaim:{budgetId,unitId}, tenantIdAssertion?}))`;`SPENDGUARD_UDS_PATH` 未設 → 回 `undefined`(三面 fallback InMemoryCostGate)。
  - **AGT advisory**:讀一個 config flag/指向 → 掛使用者提供的 `SecondaryPolicyAdapter`(**repo 不附 AGT 引擎**;這是注入點)。未設 → `[]`。
  - **fail-closed**:config 部分設定(如 UDS 設了但缺 budgetId)→ **throw at startup / deny**(絕不靜默退成 InMemory 或無治理——避免「以為接了 SpendGuard 其實沒接」)。
  - **credential-blind**:config 只含**非-secret**(udsPath、budgetId、unitId、tenant assertion);**絕不**讀/存任何金鑰。
- 把結果傳進 `createPersonalShell({costGate, secondaries})` 等。使用者**設 env → 即開**。
- RED-first;non-vacuity:env 設 `SPENDGUARD_UDS_PATH` → helper 回一個 `SpendGuardCostGate`(型別/行為);缺 budgetId → throw(fail-closed,mutation:改成靜默 fallback → 測翻紅);無 env → `{}`(byte-identical);config 無金鑰(secret-scan + 斷言)。
- **真路徑**:`pnpm run e2e:live-spendguard`(Docker + agentic-spendguard repo)已證 `SpendGuardCostGate` + transport 對真 sidecar;IT1b 讓它 config 驅動。

## (3) 不變量（沿用 + NEW）
沿用:deny-by-default / PDP-sovereign / credential-blind / commit-before-effect / 共享 WORM / **cross-tenant 隔離**(Enterprise per-tenant gate)。NEW:**注入只能更嚴(cost 拒、secondaries advisory any-deny-wins,永不放寬)**;**缺省 byte-identical**(既有測不變);**config fail-closed**(部分/malformed → throw/deny,不靜默退治理);**config 無 secret**。

## (4) Test-first plan（RED 先行)
- IT1a(verify 內,Fake):注入 always-deny costGate → denied@cost;注入 always-deny / always-allow secondary → combineDecisions 行為(any-deny-wins、PDP sovereign);缺省 → 既有 e2e byte-identical;Enterprise per-tenant 注入隔離(A deny 不影響 B)。
- IT1b(verify 內):env→adapter 構造(用 Fake transport 避免真 UDS);malformed→throw;無 env→{};無 secret。
- live(選):`e2e:live-spendguard` 證真 sidecar 路徑(已存在)。

## (5) Definition of Done（實測)
- [x] **IT1a DONE（merged)**:三面注入 `costGate?`/`secondaries?`(Personal/Developer)+ per-tenant `costGateFor?`/shared `secondaries?`(Enterprise),DVx 樣式。RED → `pnpm run verify` **exit 0**(1101 passed + 26 skipped;新 integration-injection e2e×3 + `fail-closed.test.ts`;**缺省 byte-identical**——既有 personal/enterprise/developer e2e **未改且綠**,default-gate mutation 翻既有+新測;depcruise 153 modules clean〔reviewer deep-import 親證 bite〕+ **no-vendor grep 空**〔surfaces 只 import cost/policy barrels〕;secret-scan clean;cross-tenant 11/11)。**injected 只能更嚴**(deny-cost/deny-secondary mutation 翻、allow-secondary 無法放寬 PDP deny);**per-tenant 隔離**(shared-gate mutation 翻、faulting factory 只拒 A、B 照常 provision);`pipeline.ts`/`dedup.ts`/`cost/port.ts` byte-unchanged。**額外安全強化(writer 自查 adversarial gate 發現,reviewer 證實)**:`failClosedCostGate`(注入 gate throw→structured deny、不洩 error 訊息、對非-throw gate 透明)、**write-side `redactSecrets(combined.reason)`**(不可信 secondary 的 reason 流進 committed AuditEvent——**developer 面證實 load-bearing:無它 canary 洩進 WORM**;clean reason identity)、fail-closed provisioning(costGateFor throw→該租戶 NullCostGate)。獨立 Opus4.8 review PASS(8 攻擊面 HELD/N/A;1 MINOR:personal 面 write-side redact 為 defense-in-depth〔timeline 亦 read-redact〕,測試註解略 over-claim,非缺陷)。
- [ ] IT1b:RED → verify 綠(env→adapter、malformed→fail-closed〔mutation:靜默 fallback 翻紅〕、無 env→{}、無 secret);獨立 Opus 4.8 review PASS。
- [ ] 文件:README/AGENTS 更新「如何接 SpendGuard/AGT」= 設這些 env + (AGT)提供 SecondaryPolicyAdapter;誠實標明 SpendGuard 需外部 sidecar + budgetClaim + release 未接,AGT 引擎自備。

## (6) Rollback
- `git revert <merge-sha>`(注入 optional + config helper 純加法)。缺省路徑不受影響(byte-identical)。

## (7) Depends-on / blocks + ⚠️ 待你決定
- Depends-on:SpendGuard adapter/transport(已建)、AGT dedup 接縫(已建)、三面 composition root、DVx 注入樣式。Blocks:無。
- **待你決定**:① **AGT 引擎**:supply-your-own `SecondaryPolicyAdapter`(本刀只做注入點,建議)vs 之後另開一刀做 bundled AGT-derived adapter。② **config 形式**:env vars(建議,簡單)vs config 檔。③ **Enterprise secondaries**:全租戶共用 vs `secondariesFor?(tenantId)` per-tenant。④ SpendGuard budget topology(budgetId/unitId)由誰供(部署設定)。⑤ 是否一併接 `release()`(R11,reservation 釋放)還是維持 deny-by-default 未接。
- **誠實前提**:SpendGuard 具體可 turnkey(需外部 sidecar + budgetClaim;release 未接);AGT = 注入點 + config(引擎自備);注入只能更嚴,PDP sovereign;缺省 byte-identical。
