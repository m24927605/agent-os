# SLICE-R9a: async-authorize seam（解 sync blocker;不接 AGT)

- **Phase**: R9（真 AGT 接入)— 第 1 刀（核心 refactor,獨立有值)
- **Branch**: slice/r9a-async-authorize
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
R9 要把 async AGT 接進 policy path,但 `authorize`/`SecondaryPolicyAdapter.evaluate`/`evaluateSecondaries` 全 sync。R9a **只解這個 sync blocker**(改 `MaybePromise`),**不接 AGT**——獨立有值(解鎖任何 async secondary),且把最高風險的核心型別改動與 AGT transport 隔離。`runGovernedToolCall` 本就 async,故 blast radius 集中。

## (1) 範圍(grounded;精確 seam)
1. **新型別** `MaybePromise<T> = T | Promise<T>`(放 policy 或 shared barrel;若已存在則重用)。
2. **`src/orchestration/pipeline.ts`**:
   - `AuthorizeDecision`(:30)**不變**。
   - `authorize`(:37):`(toolCall: TC) => AuthorizeDecision` → `(toolCall: TC) => MaybePromise<AuthorizeDecision>`。
   - :82:`const decision = deps.authorize(toolCall)` → `const decision = await deps.authorize(toolCall)`。
   - **fail-closed**:authorize **throw 或 promise reject** → `denied@policy` 靜態 reason(不洩 error.message)。用 `try { decision = await deps.authorize(...) } catch { decision = {effect:"deny", reason:<static>} }`(或既有等價)。
3. **`src/policy/dedup.ts`**:
   - `SecondaryPolicyAdapter.evaluate(req): PolicyDecision` → `MaybePromise<PolicyDecision>`。
   - `evaluateSecondaries`:`adapters.map(...)` 改 `await Promise.all(adapters.map(async (a) => { try { return await a.evaluate(req) } catch { synthetic deny } }))` → 回 `Promise<PolicyDecision[]>`。**throw 或 reject 都 → synthetic deny**(維持現語義)。
   - **`combineDecisions` 維持純 sync**(吃已 resolve 的陣列)。
4. **4 個 authorize closures** 折 `combineDecisions(pdp, await evaluateSecondaries(...))` → 變 async closure(回 `Promise<AuthorizeDecision>`):`src/personal/bootstrap.ts:240`、`src/developer/bootstrap.ts:271`、`src/enterprise/bootstrap.ts:453`、`src/runtime/brain/adapters/hermes/mcp/exec-mcp-server-bin.ts:268`。redactSecrets 仍在(AGT1-A)。
5. **`src/runtime/brain/adapters/hermes/mcp/exec-mcp-server.ts`**:`ExecMcpServerDeps.authorize`(:223)型別 → `MaybePromise<AuthorizeDecision>`;:348 passthrough `authorize: deps.authorize` 不變(流入 runGovernedToolCall,後者已 await)——**無需新 await**。
6. **測試**:所有 `deps.authorize(...)` 呼叫端 `await`;sync fakes/closures 仍可用(MaybePromise)。

## (2) ⚠️ OUT OF SCOPE（不碰)
- **`src/orchestration/restore.ts`**:`RestoreDeps.authorize(actor, snapshot): RestoreAuthorization` 是**不同型別/不同 path**(resume,非 governed tool-call)。**維持 sync,不在 R9a**。
- **不接 AGT**、不建 transport、不改 config(R9b/c)。

## (3) 不變量
- **缺省 byte-identical**:既有 sync authorize/sync secondaries → 經 `await` 在已 resolve 值上,行為不變(三面 + bin + EXEC4c + SETUP1a + AGT1-A 測全綠不改語義)。
- **fail-closed**:authorize throw/reject → `denied@policy` 靜態 reason;secondary throw/reject → synthetic deny。**deny-by-default / PDP sovereign / any-deny-wins 不變**。
- **`combineDecisions` 純 sync**(不引入 async)。
- credential-blind(reason redact 不動)、commit-before-effect/cost/screen 不動。

## (4) Test-first plan（RED 先行)
- pipeline:`await deps.authorize`;注入 **async authorize**(回 Promise)→ 正常 allow/deny;注入 **reject 的 authorize** → `denied@policy` 靜態 reason(不洩 message)、effect/cost/commit 不跑。mutation:pipeline 不 await(用 Promise 當 decision)→ 測翻紅(`{}` truthy 之類)。
- dedup:**async secondary** allow/deny 正常;**reject 的 secondary** → synthetic deny;順序保留;`combineDecisions` 仍 sync(型別 + 行為)。mutation:evaluateSecondaries 不 await → 翻紅。
- 三面 + bin:async authorize closure 回 Promise,經 runGovernedToolCall await → 與今日同結果(sync secondary `[]` → byte-identical;注入 async deny secondary → denied)。
- 既有全測(EXEC4c/SETUP1a/AGT1-A/三面)**不改語義**綠。

## (5) Definition of Done（待實測填)
- [ ] RED → verify exit 0(async authorize/secondary;reject→fail-closed;combineDecisions sync;**缺省 byte-identical**;restore 未碰;mutation 證;depcruise/secret-scan clean);獨立 Opus 4.8 review PASS。

## (6) Rollback / Depends-on
- Rollback:`git revert`(型別 widening + await 加法;sync 仍相容,低風險)。
- Depends-on:policy/pipeline 現狀、AGT1-A(reason redact)。Blocks:R9b(AGT transport 需 async evaluate)。
- **誠實前提**:R9a 不接 AGT,只解 sync blocker;真 AGT = R9b/c(需真 Python engine + sidecar)。
