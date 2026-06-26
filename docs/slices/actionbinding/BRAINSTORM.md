# ActionBinding（non-argv app/API)— Brainstorm 結論

判定面板(judge-panel Workflow,3 取向 → 2 獨立評審 → 綜合,6 agents)。問題:**如何把 non-argv app/API 動作(Gmail/Calendar/Drive,瀏覽器)建成一個 governed binding family,平行 ExecToolBinding,保住全部 SEATBELT 不變量?**

## 勝出:sibling `ActionBinding` port（非 ExecToolBinding 一般化)
- 兩評審皆選 sibling(34/36)>generalize-exec(29/32)。**否決一般化**:會 mutate `exec-closed-loop.ts`(全產品最高風險的 argv-purity seam),為一個不需要此重構的能力增加 load-bearing 保證的 blast radius。
- sibling port + Approach 3 的安全 graft(projector 只發安全衍生欄位、composer 固定 service+method+host、deploy 邊界具體列舉)。

## 設計（核心)
- **`ActionBinding`**(新模組,hermes adapter 區,**不碰 core/exec**):
  - `service` + `method`:**composer-fixed**(argvPrefix 的類比;brain 只提 registered tool name + declared params,絕不提 service/method/endpoint → 無 retarget 面)。
  - `argSchema: z.ZodType` 必 `.strict()`(同「無 smuggled 第二通道」守則)。
  - `toParams(validated)`:純 builder,在**單一處**從 validated params 組結構化 body。**無 command-string parse → shell/argv-injection 類結構上不存在**(比 argv 更強的 no-shell)。
  - `toCredentialEnv?(validated)`:只發 `placeholderForKey(KEY)`(openshell:resolve:env:<KEY>),**絕非 literal token**;沿用 net.fetch 的 SAFE_ENV_KEY/FORBIDDEN_AUTH_KEYS。
  - `actionProjector(validated)`:**REQUIRED**;只發安全衍生欄位 `operationClass`(service.method 桶)/`networkHosts:[composer-fixed provider host]`/`destructiveFlags`,**絕不含 params**(比 argvRedacted 更緊——連 local AGT 都看不到 param 內容)。
- **`bindingWrappedActionEffect(connector, bindings)`** = `bindingWrappedExecEffect` 的結構雙生:no-binding→fail-closed deny(connector 不呼叫)、strict safeParse fail→deny、單一處組 descriptor、credential-blind INPUT guard(`defaultExecSecretDetector` 已遞迴 nested)over params+env、delegate to `ActionConnector`。
- **`ActionConnector` port**(≥2 impl):`FakeActionConnector`(記 descriptor、回 canned —— in-repo 可證 substrate)+ 真 MCP/OAuth connector(deploy-gated)。
- **pipeline 零改**:`runGovernedToolCall` family-agnostic(只讀 screen/authorize/approve/cost/appender/effect + AuthorizeDecision.{requiresApproval,external,projection})。API action 宣告 `containment:"network-egress"` + `sideEffect:destructive|write|read` → **重用** egress fold(gate provider host)+ approval(destructive⇒requiresApproval superRefine)+ commit-before-effect + boundary ledger。
- **parallel `buildActionProjectionForCall`**(不 widen exec 的 `buildProjectionForCall`——它 typed to ExecToolBinding;保 exec 不碰、兩 family 低耦合)。

## Slice plan
- **ACT1 [NOW]**(a+b+c 一個 arc)= port + FakeActionConnector + `bindingWrappedActionEffect` + parallel `buildActionProjectionForCall` + `gmail.send`(destructive)+`drive.read`(read)manifests/bindings/條件註冊 + **端到端 join 過 REAL runGovernedToolCall** 證 6 性質(egress deny / CAP6 fail-closed / approval / commit-before-effect / boundary 無 params / credential-blind)。NO real MCP/OAuth/network。
- **ACT2 [NOW]**:純加 action set(calendar.create/list、drive.delete、gmail.search)。
- **ACT3a/b/c [DEPLOY-GATED]**:真 MCP connector(mcp__claude_ai_Gmail/Calendar/Drive)/ OAuth + SecretResolver-at-egress placeholder 解析(= 同 net.fetch/git.push 的 EXEC2-gated)/ substrate-PRIMARY egress 到 googleapis.com + OAuth-scope-to-method。
- **ACT4 [DEPLOY-GATED]**:advertise action tools 給真 Hermes brain(posture 決策)。
- **ACT5 [DEPLOY-GATED]**:browser sub-family(stateful per-step UI;distinct sub-port)。

## ⚠️ Open questions（產品/安全決策;ACT1 用預設,ACT3+ 再定)
1. **OAuth token 粒度**:單一 Google token vs per-service。ACT1 預設 per-service KEY。
2. **不可逆 API approval posture**:每個 destructive API 互動 maker-checker,還是 Personal 預授權 budget auto-approve(git.push posture)?ACT1 沿用既有 bin approver;destructive⇒requiresApproval 強制不變;「能否全自主寄信」留 ACT4。
3. **action family 的 AGT default scope**:reads 是否諮詢 AGT?ACT1 沿用既有 effectful scope。

## ⚠️ 誠實邊界（reviewer/synth 核實)
- in-repo 可證(ACT1,EXEC3a posture):governed PORT + egress fold + deny-by-default + credential placeholder + commit-before-effect + boundary record(fake connector,real pipeline+gates)。
- **BLOCKED**(deploy/OAuth/EXEC2/MCP-auth):真 send + token 解析 + 真 egress 抵達。
- **比 net.fetch 更嚴的誠實點**:API SDK 可能 silently resolve 一個 projector 看不到的 regional/redirect host(net.fetch 的 isAllowedFetchUrl 釘死 projected==connect host,API 不一定)→ **substrate seal 必為 PRIMARY**,真 connector 須拒 descriptor 未宣告的 host。
