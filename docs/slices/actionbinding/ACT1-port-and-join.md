# SLICE-ACT1: ActionBinding port + FakeActionConnector + 端到端 governance join

- **Phase**: ActionBinding（non-argv app/API)— Slice 1（port + fake + 契約 + 過 REAL pipeline 的 join)
- **Branch**: slice/act1-port-and-join
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
capability-breadth 後的下一個能力面:**non-argv app/API**。ACT1 建 sibling `ActionBinding` port + Fake connector + 把 `gmail.send`(destructive)/`drive.read`(read)過 **REAL `runGovernedToolCall`** 端到端證 SEATBELT join——**pipeline/gates 零改,real MCP/OAuth/network 全無**(EXEC3a posture:fake connector,real pipeline+gates)。

## (1) 範圍（ACT1a+b+c)
1. **`ActionBinding` 介面 + `ActionConnector` port**(新模組,hermes adapter 區,sibling to exec-closed-loop.ts,**不碰 core/exec**):
   - `ActionBinding = { service: string; method: string; argSchema: z.ZodType<unknown> (.strict()); toParams(validated): Record<string,unknown>; toCredentialEnv?(validated): Record<string,string>; actionProjector(validated): GovernanceProjection }`。service/method **composer-fixed**(brain 不提)。
   - `ActionConnector = { invoke(context: unknown, descriptor: {service, method, params, env?}): MaybePromise<ActionResult> }`。
   - `FakeActionConnector`:記 descriptor、回 canned `ActionResult`(in-repo 可證 substrate)。
2. **`bindingWrappedActionEffect(connector, bindings)`**(= `bindingWrappedExecEffect` 結構雙生):(a) no-binding→fail-closed deny,connector **不呼叫**;(b) `argSchema.safeParse` fail→deny,connector 不呼叫;(c) 單一處組 `{service, method, params: toParams(v), env?: toCredentialEnv(v)}`;(d) credential-blind INPUT guard(`defaultExecSecretDetector`,已遞迴 nested)over params+env,literal secret→fail-closed deny;(e) delegate `connector.invoke`。
3. **parallel `buildActionProjectionForCall`**(不 widen exec 的 `buildProjectionForCall`):3 gate(scope → actionProjector → strict-validate),typed to ActionBinding。
4. **seed actions**(manifest+binding+projector triad,條件註冊):
   - `gmail.send`:`containment:"network-egress"`、`sideEffect:"destructive"`(superRefine ⇒ requiresApproval:true 強制)、strict `{to,subject,body}`、actionProjector → `networkHosts:["gmail.googleapis.com"]`+operationClass+destructiveFlags(**無 params**)、`toCredentialEnv` → placeholder(KEY `AGENTOS_GMAIL_OAUTH_KEY`,per-service 預設)。
   - `drive.read`:`containment:"network-egress"`、`sideEffect:"read"`(無 approval,仍 egress-gated)、strict `{fileId}`、actionProjector → networkHosts:["www.googleapis.com"](或 drive host)。
   - `seedActionRegistry`/`seedActionBindings`(parallel seedRegistry),條件註冊 gated on `wired.has("egress-allowlist")`(+`"approval"` for destructive)。assertRegisterable 對 gmail.send 缺 egress/approval wired → throw。
5. **端到端 join(ACT1c,核心)**:`gmail.send`/`drive.read` 過 **REAL `runGovernedToolCall`**(real screen/authorize-fold/approve/cost/commitgate)+ FakeActionConnector,證 6 性質(見 §3)。
6. **預設**(open questions,ACT3+ 可改):per-service KEY;沿用 bin 既有 budget approver(git.push posture);沿用既有 effectful AGT scope。

## (2) 不變量（全部沿用既有 gate,pipeline 零改)
- **deny-by-default / fail-closed**:no-binding / unregistered → deny,connector 不呼叫;assertRegisterable 對缺 primitive 拒註冊;authorize throw→deny。
- **credential-blind**:cred 只走 toCredentialEnv placeholder,絕不在 params;INPUT guard 遞迴擋 literal secret;**actionProjector 絕不含 params**;boundary 只 `boundarySummaryFromProjection`(無 params/token)。
- **no-shell(更強)**:`{service,method,params}` 無 command-string parse;service/method composer-fixed;params strict 結構化 → injection 類結構上不存在。
- **containment→egress**:gmail.send/drive.read network-egress → egress fold gate provider host(deny-all default;非-allowlist→denied@policy)。
- **destructive→approval**:gmail.send superRefine 強制 requiresApproval → approval stage fires(無 pre-auth→denied@approval,connector 不呼叫)。
- **commit-before-effect**:AuditEvent append + receipt **先於** connector.invoke;appender reject → connector 不呼叫(信永不寄)。
- **boundary**:gmail.send(network-egress,external)executed → boundary WORM(只 safe summary,無 to/subject/body/token)。
- **PDP sovereign**;**pipeline/gates 零 byte 改**;exec family 不碰;無新依賴(MCP connector 不在本刀)。

## (3) Test-first plan（RED 先行;FakeActionConnector,無 network/OAuth/MCP)
- **port/effect edge**:unbound tool name → `bindingWrappedActionEffect` deny,Fake.invoke **never called**;gmail.send + 多餘 key(bcc)→ strict deny,never called;`params.body` 含 literal `sk-…` → INPUT guard deny,never called;合法 → 組 descriptor 正確 + Fake.invoke 收到(env 只 placeholder)。
- **註冊**:gmail.send 在 wired{egress-allowlist,approval} 註冊;缺任一 → assertRegisterable throw。
- **buildActionProjectionForCall**:scope/projector/strict 3 gate;projector 產 networkHosts 非空、無 params。
- **端到端 join(核心,過 REAL runGovernedToolCall + Fake)**:
  1. **egress**:gmail.send binEgressAllow=[] → denied@policy(egress fold),Fake never called;allowlist gmail host → 過 fold。
  2. **CAP6 fail-closed**:network-egress manifest 但 projector 無 host → denied。
  3. **approval**:destructive + 無 pre-auth/deny approver → denied@approval,Fake never called;pre-auth(AGENTOS_APPROVE_PREAUTH 含 gmail.send)→ proceed。
  4. **commit-before-effect**:AuditEvent append+receipt **先於** Fake.invoke(onEffect probe 驗序);appender reject → Fake never called。
  5. **boundary**:executed gmail.send → effect.boundary-crossed,payload 含 host-only networkHosts+operationClass+destructiveFlags,**斷言不含 to/subject/body/token**。
  6. **credential-blind**:literal token 在 params → denied;Fake 只收 placeholder env。
  - drive.read:read,無 approval,仍 egress-gated;allowlisted host → 過 → Fake.invoke。
- mutation 證:bindingWrappedActionEffect 略過 INPUT guard → 含-secret 測翻;略過 no-binding deny → unbound 測翻。
- byte-identical:既有 16 exec 工具 + CAP/exec 測全不變綠(action family 純加,pipeline 零改)。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:新模組(hermes 區,**不碰 core/exec**)`action-closed-loop.ts`(ActionBinding + ActionConnector + FakeActionConnector + bindingWrappedActionEffect)+ `action-projection-for-call.ts`(buildActionProjectionForCall)+ `action-seed-tools.ts`(gmail.send/drive.read + seedActionRegistry/Bindings,條件註冊讓 assertRegisterable 對缺 primitive throw)+ index barrel(+26)。RED → verify **exit 0**(1559 passed + 29 skipped;action 34 測〔21+13〕;mutation:INPUT-guard-skip 翻 secret、no-binding-skip 翻 unbound)。獨立 Opus4.8 review **PASS**:**JOIN FAITHFULNESS**(join 用 REAL runGovernedToolCall + 真 gate 函式,`makeJoinDeps.authorize` 與 production bin `buildDeps.authorize` 結構相同,只換 action projection + 省 exec.run-specific decisions〔對 action 不可能觸發〕)、credential-blind(canary 零進 projection/intent/boundary、params 只到 connector、literal secret 擋)、6 SEATBELT 性質端到端、no-shell、**pipeline/exec diff EMPTY byte-identical**。2 MINOR(CAP6-no-host join 分支硬寫 inline〔e2e gate 由其他測+探針已證;可加 projector-stripping fixture〕;SLICE-P0-003 — 註:deps:check 確在 verify)。
- **ActionBinding family 確立**:non-argv app/API 的 governed port,fake-proven 過真 pipeline。**誠實**:真 send + OAuth/SecretResolver-at-egress + 真 MCP transport + 真 egress 抵達 = deploy/EXEC2-gated(ACT3);API SDK 可能 resolve projector 看不到的 host → substrate seal 必 PRIMARY,真 connector(ACT3)須拒未宣告 host。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(新模組 + seed actions + parallel projection helper 純加;pipeline/exec 零改)。
- Depends-on:runGovernedToolCall(family-agnostic)、manifest superRefine、capability-containment(network-egress→egress-allowlist、destructive→approval)、egress fold/CAP6 fail-closed、CAP7 boundarySummary、credential inject(placeholderForKey)、defaultExecSecretDetector(遞迴)、bin 既有 approver/egress wiring。Blocks:ACT2(更多 action)、ACT3(真 MCP/OAuth)、ACT4(advertise)、ACT5(browser)。
- **誠實前提**:ACT1 = governed PORT + fake + 契約 + join(EXEC3a posture:fake connector,real pipeline+gates,fake-proven)。**BLOCKED**:真 send + token 解析(OAuth + SecretResolver-at-egress = EXEC2-gated,同 net.fetch/git.push)+ 真 MCP transport + 真 egress 抵達。**比 net.fetch 更嚴**:API SDK 可能 resolve projector 看不到的 regional/redirect host → substrate seal 必 PRIMARY,真 connector(ACT3)須拒 descriptor 未宣告的 host。3 open questions(token 粒度/approval posture/AGT scope)用預設,ACT3+ 定。
