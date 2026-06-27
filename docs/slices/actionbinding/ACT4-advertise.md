# SLICE-ACT4: 把 action 工具 advertise 給 brain（Hermes 提議 → agent-os 受治理執行;deny-by-default)

- **Phase**: ActionBinding — Slice 4（終局:brain 出意圖、governed pipeline 執行;暴露 action 給不可信 brain = 明確 opt-in)
- **Branch**: slice/act4-advertise
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 姿態
目前 bin 的 MCP server 只 advertise + dispatch exec 工具。ACT4 讓 **Hermes 能透過 MCP 提議 action 工具(gmail.send…),且該提議走完整 governed pipeline**(runGovernedToolCall:screen→authorize〔egress+approval+external〕→commit-before-effect→effect→boundary)。**⚠️ 把「寄信/刪檔」暴露給不可信 brain 是重大安全姿態 → DENY-BY-DEFAULT**:`AGENTOS_ADVERTISE_ACTIONS` 必須明確開(精確 `true`/`1`),**預設 off → byte-identical**(brain 只見 16 exec 工具,action tools/call → unknown/deny)。

## (1) 範圍
1. **`deps.effect` 改 DISPATCHER**(bin):`(toolCall) => actionBindings.has(tc.tool) ? bindingWrappedActionEffect(guardedConnector, actionBindings)(tc) : bindingWrappedExecEffect(...)(tc)`。仍是**單一 execution edge = runGovernedToolCall → 此 dispatcher**(不繞過任何 gate)。
2. **MCP server advertise 雙家族**:tools/list = exec bindings keys + **action 描述(name + inputSchema 由 action argSchema 導)**。server 加 optional `actionDescriptors`(或同等)讓 bin 在 advertise-on 時注入。inputSchema 一律經 `argSchemaToJsonSchema`(no-drift)。
3. **authorize 認得 action**:bin 的 registry 在 advertise-on 時併入 action manifests(authorize 的 `registry.lookup` 取 containment/requiresApproval → egress fold/approval/external/boundary 照常套用)+ allow-rule 加 `gmail.**`/`drive.**`/`calendar.**`(OR-combined,平行 exec.**/git.**/net.**)。
4. **`AGENTOS_ADVERTISE_ACTIONS` gate(deny-by-default)**:`actionAdvertiseFromEnv`(精確 true/1;鏡像 actionLiveFromEnv)。off → 不併 action manifests/bindings/descriptors/allow-rule → byte-identical(action tools/call → 未授權/unknown → deny)。on → 上述全接。
5. **connector 可注入**:bin buildDeps 接 optional action connector;**verify/測 = FakeActionConnector**(無網路);**operator live = 真 ACT3-live connector**(createGuardedActionConnector(createGoogleActionConnector(createHttpActionTransport(env)),{live,testAccounts,resolveAccount}))。guard(ACT3a-guard)+ live-flag(AGENTOS_ACTION_LIVE)仍各自把關。
6. 不改 pipeline / exec 家族 / action 家族既有邏輯(只接線 + gate)。

## (2) 不變量
- **deny-by-default 姿態**:`AGENTOS_ADVERTISE_ACTIONS` 未設 → action 完全不暴露給 brain(不 advertise、不 dispatch、不授權)→ **byte-identical**(16 exec 工具)。
- **單一 execution edge**:action 提議也只經 runGovernedToolCall + dispatcher;**無旁路**(egress/approval/commit-before-effect/boundary/credential-blind 全套用)。brain 改不了 service/method/host(composer-fixed)、params strict。
- **credential-blind**:brain 提議 action,仍**永不見 token**(connector 在 egress 解析);WORM/projection/trace 只見 placeholder。
- **多層把關疊加**:advertise-on 才暴露;live-on 才真送;guard 才驗帳號 ∈ allowlist;egress 才允許 host;approval 才放行 destructive——**任一不過即停**。
- byte-identical(off);無新依賴(connector 注入,無新 dep)。

## (3) Test-first plan（RED 先行;FakeActionConnector,無網路)
- **advertise off(預設)**:tools/list = 16 exec(無 gmail.send 等);`gmail.send` 的 tools/call → deny(未授權/unknown,effect 0)。**byte-identical**(既有 bin 測不變)。
- **advertise on + fake connector**:tools/list 含 gmail.send/drive.read…(inputSchema 正確);`gmail.send` tools/call → 走 runGovernedToolCall → authorize(egress fold:gmail host?)→ approval(destructive→pre-auth?)→ commit-before-effect → dispatcher→action effect→fake connector;denied@policy(非-allowlist host)/ denied@approval(無 pre-auth)/ guard deny(帳號)→ effect 0,fake never called。
- **dispatch 正確**:exec 工具 → exec effect;action 工具 → action effect(fake)。mutation:dispatcher 不分家族(全走 exec)→ action call 翻紅。
- **credential-blind**:brain-proposed gmail.send(canary token in env)→ fake connector 收 descriptor、canary 不入 WORM/tools/call 回應/trace。
- byte-identical:既有 exec/CAP/ACT1-3 全測續綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(deps.effect dispatcher + tools/list 雙家族 + registry/allow-rule 併入 + `AGENTOS_ADVERTISE_ACTIONS` deny-by-default gate + 注入式 connector;off→byte-identical〔16 exec、action deny〕;on+fake→action advertised + 提議走完整 governed pipeline〔egress/approval/commit-before-effect/boundary/credential-blind〕;dispatch 正確;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(dispatcher + advertise gate + 注入;off byte-identical)。
- Depends-on:exec-mcp-server(single edge/tools-list)、ACT1-3(port/guard/connector/transport)、CAP egress/approval/boundary、seedActionRegistry/Bindings。Blocks:無(ActionBinding in-repo 終局)。
- **誠實前提**:ACT4 讓 bin **能**把 action 暴露給 brain 並受治理(deny-by-default off);**verify 用 fake connector**(無網路)。真 live 執行 = AGENTOS_ADVERTISE_ACTIONS on + AGENTOS_ACTION_LIVE on + 真 connector + 有效 token(ACT3-live,operator)。把 action 暴露給**真正自主的 Hermes** 是 posture 決策:預設關;開了之後,brain 提議的每個 action 都被 deny-by-default 政策 + WORM + credential-blind + 帳號 allowlist 層層把關——這正是「讓 brain 能做、又能放心讓它在沒人盯時做」。
