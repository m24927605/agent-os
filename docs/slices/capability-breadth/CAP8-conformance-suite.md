# SLICE-CAP8: registry-wide conformance suite（整併不變量;Approach 1 kernel 的後期 consolidation)

- **Phase**: capability breadth — Slice 8（consolidation:把逐工具手寫不變量斷言整併成 registry-wide property)
- **Branch**: slice/cap8-conformance-suite
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
能力面已有 15 工具、跨 exec/file/git/network 家族。CAP8 把「每工具手寫不變量斷言」整併成**一個參數化 `describe.each(registry)` conformance suite**——讓**任何未來新工具**自動受同一組不變量檢查(brainstorm Approach 1 唯一保留的好 kernel,作**後期 consolidation**而非前期 SDK 大重構)。

## (1) 範圍
1. **`assertToolConformant(manifest, binding)`**(reusable,vendor-neutral 或 hermes-adapter 測輔助):對一個 (manifest, binding) 證:
   - **schema-no-drift**:`argSchemaToJsonSchema(binding.argSchema)` 確定性可導(不 throw)+ 與 MCP server 廣告的 inputSchema 一致(byte-derive)。
   - **strict-args deny-by-default**:`binding.argSchema` 是 `.strict()` → `safeParse({ <unknownKey>: "x" })` **fail**(unknown key 拒)。
   - **effectful ⇒ projector**:`manifest.sideEffect ∈ {write, destructive}` → `binding.governanceProjector` **defined**(effectful 工具必有 AGT projection)。
   - **credential-blind(有 string-arg 的工具)**:對宣告了 string arg 的工具,secret-shaped value 在該 arg → args credential screen **deny**(secret 不達 substrate)。無 string-arg 工具(如 git.status)→ 此項 N/A。
2. **參數化 suite**:`describe.each(<bin 的 15 工具:manifest + binding>)` 跑 `assertToolConformant`。涵蓋全目錄。
3. **commit-before-effect = pipeline 級不變量**(runGovernedToolCall 恆 append-before-effect)——既有 closed-loop/pipeline 測已證,**不在 per-tool 整併**(註記:這是 pipeline property 非 per-tool;保留既有測)。
4. **刪冗餘逐工具手寫斷言**:exec-seed-tools.test.ts 中被 conformance suite registry-wide 覆蓋的逐工具斷言刪除(保留工具特定行為測;**不可丟覆蓋**)。

## (2) 不變量
- **registry-wide property**:15 工具全過 `assertToolConformant`;**未來新工具**(加進 seed)自動受檢。
- **non-vacuity(核心)**:合成一個**非-conformant 工具**——(a) effectful 但無 projector、(b) 非-`.strict()` argSchema、(c) argSchemaToJsonSchema 不可導的 argSchema——`assertToolConformant` **抓到**(throw/fail)。證 suite load-bearing(未來壞工具被擋)。
- **不丟覆蓋**:刪除的逐工具斷言,其不變量被 conformance suite 等價覆蓋(reviewer 核實)。
- **缺省 byte-identical**:純測整併 + 一個 helper;production 不動(15 工具行為不變)。無新依賴。

## (3) Test-first plan（RED 先行)
- `assertToolConformant` 對 15 工具全綠(它們本就 conformant)。
- non-vacuity(在測內,合成壞工具):
  - effectful manifest(sideEffect:"write")+ binding 無 governanceProjector → `assertToolConformant` 失敗(effectful⇒projector 翻)。
  - 非-`.strict()` argSchema(`z.object({x:z.string()})` 無 .strict)→ strict-deny 檢查失敗(unknown key 竟通過)。
  - argSchema 含 argSchemaToJsonSchema 不支援的 shape → no-drift 檢查失敗(導出 throw)。
  - string-arg 工具的 credential-blind:合成工具的 secret-shaped arg 不被 screen 擋(若移除 screen)→ 失敗。
- 參數化 suite:`describe.each` 對 15 工具各跑;mutation:把某真工具的 projector 拿掉(暫)→ 該工具 conformance 翻紅(證 suite 真的逐工具檢查)。
- 刪冗餘斷言後:被刪的不變量仍由 conformance suite 綠覆蓋(全測綠)。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(`assertToolConformant` + 參數化 conformance suite 涵蓋 15 工具〔no-drift/strict-deny/effectful⇒projector/credential-blind〕+ 刪冗餘逐工具斷言〔不丟覆蓋〕;non-vacuity〔合成非-conformant 工具被抓:無-projector/非-strict/不可導〕;production 不動 byte-identical;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純測 + helper;production 不動)。
- Depends-on:seedRegistry/seedBindings、argSchemaToJsonSchema、ExecToolBinding(argSchema/governanceProjector)、manifest(sideEffect)、args credential screen。Blocks:無(consolidation)。
- **誠實前提**:CAP8 是**測整併 + registry-wide property**(consolidation),不加能力、不動 production。它證**不變量成立**,非證 effectAdapter 的 domain 行為正確(一個寫錯 bytes 的 write_file 仍過 conformance)——per-capability 行為測仍各自存在。commit-before-effect 是 pipeline-level(既有測保),不在 per-tool 整併。
