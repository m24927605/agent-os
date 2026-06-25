# SLICE-R9b-2a: AGT proto + UDS decision transport + endpoint-backed async secondary

- **Phase**: R9 — 第 2 刀之 2a（transport + adapter;fake-transport 測,inert)
- **Branch**: slice/r9b2a-agt-transport
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
R9a 讓 evaluate 可 async;R9b-1 有了 credential-blind projection。R9b-2a 建**呼叫真 AGT sidecar 的 async 通道**:AGT proto(我們自訂的 sidecar Evaluate 契約)+ UDS grpc-js transport(鏡像 SpendGuard)+ endpoint-backed `SecondaryPolicyAdapter`(async evaluate,fail-closed,configured-down→deny)。**fake-transport 測**(無真 Python sidecar);**inert**(不註冊進任何 surface/closure——那是 R9b-2b)。

## (1) 範圍(鏡像 SpendGuard transport 樣式;`@grpc/grpc-js` 已是 dep,無新依賴)
1. **AGT proto(我們的 sidecar 契約)**:`src/runtime/agt/proto/agt_decision.subset.proto` —— `Evaluate(AgtEvaluateRequest) -> AgtEvaluateResponse`。request 帶 neutral 治理欄位(requestId/tenantId/projectId/taskId/actorId/action/resource)+ **GovernanceProjection(R9b-1)**;response `{ allowed: bool, action: string, matched_rule: string, reason: string }`。**注意**:這是**我們自訂的契約**(operator 的 Python sidecar 實作它),非 vendored 第三方 proto subset。
2. **codegen 比照 SpendGuard**:`agt:proto:gen`(types-only stub,onlyTypes=true,零 runtime import → `src/runtime/agt/_generated/agt_decision.ts`)+ sha256 pin manifest + `agt:proto:check`(drift gate)+ **加進 `verify`**。
3. **`src/runtime/agt/decision-transport.ts`** `createAgtDecisionTransport({ udsPath, deadlineMs })`:lazy grpc-js `unix://udsPath` channel(構造不連線),per-call deadline(預設 750ms,硬上限 2000ms,可 `AGT_TIMEOUT_MS`);**fail-closed**:unreachable/timeout/malformed response/protocol mismatch → throw(或回 deny-shaped)。grpc 限定本區(no-vendor-in-core)。
4. **PolicyRequest 加 optional 欄位**:`governanceProjection?: GovernanceProjection`(PDP **忽略**;只有 AGT adapter 讀;預設 undefined → 今日 byte-identical)。
5. **`src/runtime/agt/` `createAgtEndpointSecondary(transport, opts?)`** → 回一個 **async `SecondaryPolicyAdapter`**:`evaluate(req)` 把 req 的 neutral 欄位 + `req.governanceProjection` 映成 proto request → `await transport.evaluate(...)` → 映 `AgtDecision` → `PolicyDecision`:
   - `allowed===true && action==='allow'` → **allow**;`deny`/`warn`/`log`/`require_approval`/unknown/malformed → **deny**(reason 帶 `agt_action=...`/matched_rule,**redactSecrets**)。
   - transport throw/timeout/down → adapter **throw** → `evaluateSecondaries` synthetic deny(**configured-down→deny**,符合 fail-closed)。
   - **credential-blind**:送給 transport 的 request **只含 neutral 欄位 + R9b-1 projection**(本就 best-effort redacted),**絕不送 raw args/env/stdin**。

## (2) 不變量
- **fail-closed**:transport unreachable/timeout/malformed → deny(configured-down→deny);response schema validate,只有明確 allow 才 allow。
- **advisory-only**:回 `PolicyDecision`,經 `combineDecisions` 仍 PDP-sovereign、any-deny-wins(adapter 不能 grant)。
- **credential-blind**:request 只送 neutral + projection;reason redactSecrets。
- **缺省 byte-identical**:PolicyRequest 新欄位 optional 預設 undefined;adapter inert(未註冊)→ 全測不變。
- **zero new dep**(grpc-js 已有);proto types-only stub 零 runtime import;grpc 限 `src/runtime/agt/`(no-vendor-in-core 綠)。

## (3) Test-first plan（RED 先行;fake transport,無真 sidecar)
- adapter 映射(注入 fake transport):allow→allow;deny/warn/log/require_approval/unknown/malformed→deny;reason 帶 agt_action(redacted)。
- **fail-closed**:fake transport reject(unreachable)/ timeout / malformed → adapter throw → 經 `evaluateSecondaries` synthetic deny(寫一個小整合測:`combineDecisions(allowPdp, await evaluateSecondaries([adapter], req))` → deny)。mutation:adapter 把 down 當 allow → 翻紅。
- **advisory-only**:allow adapter + PDP deny → 仍 deny(PDP sovereign)。
- **credential-blind**:req 帶含 canary 的 projection / 嘗試塞 raw args → 送給 fake transport 的 payload **只有 neutral + projection,無 raw args**;reason 含 canary → redacted。mutation:送 raw args → 翻紅。
- transport 單元(fake grpc server / injected channel):deadline 生效、malformed response→reject、構造不連線(lazy)。
- proto drift:`agt:proto:check` 綠;改 proto 不 re-pin → check 紅(drift gate 生效)。
- PolicyRequest:有/無 governanceProjection 都 parse(optional);PDP 不讀它(decision 不受影響)。

## (4) Definition of Done（實測)
- [x] **DONE（merged)**:AGT proto(我們的 sidecar Evaluate 契約)+ types-only stub(零 runtime import)+ sha256 pin + `agt:proto:gen/check`(drift gate 進 verify);`createAgtDecisionTransport`(lazy grpc-js UDS,deadline 750ms/cap 2000ms/`AGT_TIMEOUT_MS`,fail-closed;**手寫 proto3 wire codec**)+ `createAgtEndpointSecondary`(async,映射 allow/else-deny + reason redact;down/timeout/malformed → throw → evaluateSecondaries synthetic deny);`PolicyRequest.governanceProjection` optional(PDP 忽略)。RED → verify **exit 0**(1232 passed + 26 skipped;33 新測;down-as-allow mutation 翻 fail-closed、attach-raw-args 翻 credential-blind;`agt:proto:check` drift-bite;depcruise no-vendor-in-core 綠+bite〔grpc 限 runtime/agt〕;secret-scan clean;**無新依賴**)。獨立 Opus4.8 review PASS:**手寫 codec round-trip 正確 + malformed 全 fail-closed(無 buffer 能產 allow;junk allowed=true 因 action="" 被 exact-match 擋成 deny)**、fail-closed down→deny、credential-blind(toAgtRequest 固定 7-欄 allowlist 非 spread)、advisory-only、lazy、deadline-cap、INERT、byte-identical。2 INFO(non-canonical varint allowed=true 為 proto3-correct 且 action gate 擋住;label reserved)無需處理。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(新 proto/transport/adapter + PolicyRequest optional 欄位純加法;adapter inert,revert 無副作用)。
- Depends-on:R9a(async evaluate)、R9b-1(GovernanceProjection)、SpendGuard transport 樣式、`@grpc/grpc-js`。Blocks:R9b-2b(接線 + scope + register)。
- **誠實前提**:R9b-2a 是 transport+adapter,**fake-transport 測**;**真 AGT live 需 operator 的 Python sidecar**(R9c 的 gated `e2e:live-agt`,在你提供 engine 前 BLOCKED)。adapter **inert**(未註冊;R9b-2b 才接進 surfaces/closures + scope gate)。
