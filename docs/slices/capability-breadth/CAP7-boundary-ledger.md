# SLICE-CAP7: external-effect boundary ledger（記錄不可逆外部事實;audit,非 gate)

- **Phase**: capability breadth — Slice 7（補「intent 已記」vs「不可逆外部事實已發生」之間的 WORM 記錄)
- **Branch**: slice/cap7-boundary-ledger
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
commit-before-effect 在 effect **之前**append **INTENT** event(「即將跑」)。但對**打穿 seal 的外部 effect**(network-egress / host-fs-write),「intent 已記」≠「不可逆外部事實已發生」。CAP7 在 effect **跑完後**對外部 effect append 一個**有別於 intent 的 boundary WORM event**(「真的跑了/越界了」)——閉合這個 gap。**這是 audit/assurance 記錄,不是第二 deny 權威**(PDP 仍唯一 deny);**記 projection/neutral 欄位,絕不記 raw args/env**。

## (1) 範圍
1. **`AuthorizeDecision` + `external?` + `projection?`**(pipeline.ts):`readonly external?: boolean`(composition root 從 manifest.containment 設:`network-egress`/`host-fs-write`→true;`in-sandbox`→false/undefined)+ `readonly projection?: unknown`(已 redact 的 GovernanceProjection,給 boundary 記錄;opaque to pipeline)。
2. **bin closure 設 external + projection**(exec-mcp-server-bin.ts):closure 已讀 `registry.lookup(tc.tool)?.containment` + 建 projection → 在回傳的 AuthorizeDecision 加 `external: containment ∈ {network-egress, host-fs-write}` + `projection: <redacted projection>`。現 15 工具:net.fetch external=true,其餘 false → 行為不變。
3. **pipeline boundary append**(commitBeforeEffect 後、effect 已跑、outcome executed 時):若 `decision.external === true` → `deps.appender.append(createAuditEvent({ action:"effect.boundary-crossed", ...neutral context, resource: tool, result, projection }))`。`GovernedStage`/outcome 不變(這不是 deny path)。
   - denied(任何 stage)/ aborted(commit abort)/ **in-sandbox(external 非 true)**→ **無 boundary event**(effect 沒越界)。
   - **boundary-append 失敗**(post-effect)→ **surface**(outcome 仍 executed——effect 已不可逆;記一個 boundary-append-failed 標記,鏡像 settlement 失敗的處理),**不**因 audit 失敗假裝 effect 沒跑。
4. **credential-blind**:boundary event 只記 neutral 欄位(action/resource/tenant/actor/ids)+ result + **redacted projection**,**絕不 raw args/env/stdin**。

## (2) 不變量
- **boundary event 只在 external effect 真跑後出現**:executed + external → 1 個 boundary event;denied/aborted/in-sandbox → 0。**永不 boundary-without-effect**(沒跑就沒 boundary)。
- **intent + boundary 配對**:一個 external executed 呼叫 → WORM 有 INTENT(commit-before)**且** boundary(post-effect)。
- **audit-only,PDP sovereign**:boundary 是 forward WORM 記錄,**不 gate、不改 deny/allow**(PDP 仍唯一 deny;不是第二 deny path)。
- **credential-blind**:projection 已 redact;無 raw args/env。
- **缺省 byte-identical**:`external?`/`projection?` optional;in-sandbox 工具(14 個)external≠true → 無 boundary、行為不變。
- **post-effect fail-safe**:boundary-append 失敗 → executed 不變(effect 不可逆)+ surface;不 fake「沒跑」。

## (3) Test-first plan（RED 先行)
- pipeline:注入 `{effect:"allow", external:true}` + executed → effect 後 appender 收到 **2 個 event**(intent + boundary,boundary action="effect.boundary-crossed");`external:false`/未設 → 只 1 個(intent),**無 boundary**。
- **denied/aborted 無 boundary**:authorize deny / approval deny / commit abort → effect 不跑 → **0 boundary event**(只 intent 或無)。mutation:external 工具 denied 卻 append boundary → 翻紅(boundary-without-effect)。
- **boundary-append 失敗**:appender 第二次 append reject → outcome 仍 executed + surface boundary-append-failed;effect 結果不變(不假「沒跑」)。
- **credential-blind**:boundary event payload 只 neutral + redacted projection;注入帶 canary 的 args → boundary event 不含 canary(只 redacted projection)。
- **bin e2e**:net.fetch(external,allowlisted host,executed)→ intent + boundary;exec.echo(in-sandbox,executed)→ 只 intent;net.fetch denied(非-allowlist)→ 無 boundary。mutation:closure 不設 external → net.fetch 無 boundary → 翻紅。
- byte-identical:14 in-sandbox 工具 + 既有 pipeline/CAP1-6 測不變綠。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(`AuthorizeDecision.external?`/`projection?` + bin closure 設 + pipeline post-effect boundary append;**只 external+executed 出 boundary**〔denied/aborted/in-sandbox→0〕;intent+boundary 配對;audit-only PDP-sovereign;boundary-append 失敗 surface〔executed 不變〕;credential-blind〔redacted projection,無 raw args〕;**byte-identical**〔in-sandbox 不變〕;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(optional 欄位 + post-effect append 純加;in-sandbox byte-identical)。
- Depends-on:pipeline(commitBeforeEffect/appender)、CAP3 containment、CAP6 net.fetch(external 工具 exercise 它)、audit createAuditEvent、R9b-1 projection。Blocks:無。
- **誠實前提**:in-repo,boundary event 記錄「external-classed effect **執行了**」(post-effect,比 intent 強的記錄);**真「bytes 越界到世界」= substrate/deploy**(net.fetch 真網路 = deploy/EXEC2-gated,CAP6 誠實前提)——CAP7 記的是「effect 執行 + 其 external 分類」,不是「封包真的離開」(那是 deploy 觀測)。audit-only:不 gate、PDP 仍唯一 deny。
