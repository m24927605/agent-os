# SLICE-DV4: Python plane credential-blind demo（shim → JSON fixture 邊界 → governed 管線）

- **Phase**: P4（Developer 垂直;收尾 agent-facing 端——credential-blind Python shim 接上 governed 核）
- **Branch**: slice/dv4-python-plane-credential-blind-demo
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；Python（demo + test）+ TS（boundary consume test）+ 一個 committed fixture;新增依賴 = 0
- **狀態**: **DONE**（merged;writer=Backend Architect/Opus4.8;獨立 Opus4.8 reviewer = PASS;byte-equivalent 契約 + 雙重 credential-blind + import-linter 經 mutation 證實;verify:py RAN;shim 核未動）

## (0) 動機 + 現況（grounded）
R9-S1 已建 credential-blind Python shim(`python/agentos_shim/shim.py`:`to_bundle_ref_tool_call(tool, bundle_refs)→{tool, args}`,args 只允許 `bundle://`,literal secret → `ValueError`;`_assert_bundle_ref_only`/`_looks_like_bundle_ref`)+ import-linter forbidden 契約(`python/.importlinter`)+ `test_credential_blind.py`。但**從未 demo 它接上 governed 管線**——agent 寫的 bundleRef-only proposal 是否真能跨邊界被 TS 治理核(`runGovernedToolCall`/`DeveloperKit.runTool`)接受、且 credential-blind 不變,沒有端到端證明。

## (1) ID + Title
SLICE-DV4 — 一個 **committed bundleRef-only proposal fixture**(跨語言邊界契約,鏡像 tool-manifest.example.json 的 byte-equivalent 樣式)+ (a) **Python 端**:`agentos_shim` demo helper 產出該 proposal 並 `json.dumps` → Python 測試證 shim 輸出 **byte-equivalent** 該 fixture + literal secret → ValueError;(b) **TS 端**:讀該 fixture JSON → 驗 bundleRef-only → 組 `GovernedCall` → `DeveloperKit.runTool` → **accepted(過 screen credential 守門 + registered tool authorize)→ executed + WORM**;(c) import-linter 確認 shim/demo credential-blind(無 os/socket/http/provider-client import)。**honest:fixture/JSON 邊界,非 live Python-runtime 整合(=R11)。**

## (2) Goal（一句話）
端到端證明:credential-blind Python agent shim 產的 **bundleRef-only** proposal 跨 JSON 邊界後,被 TS 治理管線接受並落 WORM,且全程不攜帶明文 secret(literal secret 在 Python 端 ValueError、在 TS 端 denied@screen,雙重 fail-closed)——把 Developer 的 agent-facing 端接上治理核。

## (3) In-scope / Out-of-scope
- In-scope:
  - **committed fixture**:`python/_fixtures/bundle_ref_proposal.json`(或共用位置)= 一個 canonical bundleRef-only proposal `{tool, args:{<k>:"bundle://..."}}`。
  - **Python**:`agentos_shim` 加薄 demo(或重用 `to_bundle_ref_tool_call`)產出該 proposal;Python 測試:`json.dumps(shim 輸出, sort_keys)` **byte-equivalent** fixture(shim 真產它)+ literal secret arg → `ValueError`(沿 R9-S1)+ 空 args 允許。
  - **TS**:測試讀 fixture JSON → 驗每個 arg value `bundle://` 前綴(boundary 守門,fail-closed:非-bundleRef → reject)→ 組 `GovernedCall{tool, args}` → `createDeveloperKit` `authorTool`(該 tool)+ `runTool` → **executed + WORM 多一筆**;另:把一個 literal-secret 注入 args 的變體 → **denied@screen**(TS 端 detectSecret 守門,defense-in-depth);bundleRef value 不被當 secret(通過)。
  - **import-linter**:forbidden 契約涵蓋 shim + demo(禁 `os`/`socket`/`http*`/`requests`/provider clients——credential-blind by construction;沿 R9-S1 強化)。
  - `pnpm run verify`(含 `verify:py`:ruff/pyright/pytest/import-linter)+ TS 測試 exit 0。
- Out-of-scope（明確誠實標記）:
  - **live Python-runtime agent 整合**(真 Hermes/Python agent 在進程內呼治理核)= **R11**;DV4 是 **fixture/JSON 邊界** demo,**不宣稱 runtime 整合完成**。
  - 真 Python↔TS RPC/process bridge;Python 端跑治理核(治理核是 TS,Python 只產 proposal)。
  - 多 proposal / 串流 = 後續。

## (4) Design delta + 依賴方向
- Python:純加 demo + test + fixture(不改 shim 的 credential-blind 核)。TS:純加 boundary-consume test(用既有 `createDeveloperKit`/`runTool`,不改治理核)。fixture 是兩端的 byte-equivalent 契約(漂移即測試紅,雙向)。
- 依賴:TS 測試經 developer barrel;Python 經 agentos_shim。無 vendor、無 cycle。
- **PUBLIC**:fixture 的 proposal schema(跨語言契約);Python demo helper(若新增)。

## (5) Test-first plan（RED 先行）
- Python(pytest):shim 產的 proposal `json.dumps(sort_keys=True)` == fixture(byte-equivalent);literal secret arg → ValueError;非-dict / 非-str value → ValueError(沿 R9-S1)。fixture/demo 不存在前紅。
- TS(vitest):讀 fixture → bundleRef-only 驗 → GovernedCall → runTool → executed + WORM;literal-secret 變體 → denied@screen;在 boundary-consume 實作前紅。
- import-linter:shim/demo import os/requests → lint-imports 失敗(契約 bite)。
- 首次 RED:fixture 缺 / Python demo test / TS boundary test 未建 → 失敗。

## (6) Definition of Done（實測）
- [x] RED:fixture 缺 → Python byte-equiv test `FileNotFoundError` + TS test `ENOENT`(impl 前紅)。
- [x] `pnpm run verify` **exit 0**(920 passed + 18 skipped;**`verify:py` RAN〔未 skip〕**:ruff All checks passed / pyright 0 errors / pytest 8 passed〔3 新 + 5 既有〕/ import-linter 1 kept 0 broken;TS boundary e2e 綠;DV1/DV2/DV3 + 既有不變;depcruise 135 modules clean;secret-scan clean;**ZERO tracked-file 改動**——shim/.importlinter/pyproject/bootstrap 未動)。
- [x] **byte-equivalent 邊界契約**:shim `to_bundle_ref_tool_call` 輸出 `json.dumps(sort_keys)` == committed fixture;reviewer mutation(fixture value/tool drift)→ **Python byte-equiv + TS deep-equal 雙向翻紅**。
- [x] **跨邊界 accepted**:fixture bundleRef-only proposal → 驗 bundleRef-only(boundary guard fail-closed)→ `GovernedCall` → `authorTool`(manifest dev:deploy)+ `runTool` → **executed + WORM 1 筆**(probe 證真 hash-chained receipt);mutation(boundary accept-any → 翻紅;screen-always-ok → executed 而非 denied 翻紅)。
- [x] **雙重 credential-blind**:Python literal secret(runtime-assembled)→ ValueError(specific to 非-bundleRef);TS literal-secret 變體 → boundary throw + denied@screen(effect 不跑、WORM 不變、canary 不出現);bundleRef value 通過。
- [x] import-linter 契約涵蓋 `agentos_shim`;reviewer mutation(shim import `_credential_blind_fixtures.env_secret_reader`)→ `lint-imports` exit 1 contract BROKEN。
- [x] **誠實標記**:fixture/JSON 邊界,**非 live Python-runtime 整合(R11)**;Python 不跑治理核(核是 TS,Python 只產 proposal);authorize 是真 registry-backed deny-by-default(reviewer probe:unregistered/out-of-ns tool → denied,非 bypass)。
- [x] **Adversarial review = PASS**(獨立 Opus 4.8;5 mutation〔fixture drift、bundleRef accept-any〔Python+TS〕、screen-always-ok、forbidden-import〕皆翻紅;8 攻擊面 HELD/N/A;1 MINOR informational〔detectSecret 對低熵非-sk secret 不抓,但 boundary guard bundleRef-only 抓 → defense-in-depth 成立,無需動作〕)。

## (7) Rollback
- `git revert <merge-sha>`(fixture + Python demo/test + TS boundary test + import-linter delta)。shim 核 + 治理核 + DeveloperKit 不受影響。

## (8) Depends-on / blocks
- Depends-on:R9-S1(credential-blind shim + import-linter)、DV1(createDeveloperKit/runTool/registry-backed authorize/screen)、`verify:py` 閘。
- Blocks:無(Developer agent-facing 端 demo 完成;live Python-runtime 整合 = R11)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:DV4 證 credential-blind shim 的 proposal 跨 fixture/JSON 邊界被治理核接受 + 雙重 credential-blind;live Python-runtime agent 整合(進程內)= R11,不在此刀。
