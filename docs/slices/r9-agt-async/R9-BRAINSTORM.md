# R9 PHASE — 真 Python-async AGT 接入(Codex brainstorm 結論,2 輪)

- **Phase**: governance integrations（把 REAL Python-async AGT advisory 接進每次 tool-call policy path)
- **狀態**: **BRAINSTORM DONE（2 輪 Codex)— 待你拍板是否開工 + 範圍**
- **方法**: 依全局 CLAUDE.md 的 Codex Brainstorming(Round 1 grounded proposal → Round 2 收緊 4 缺口)

## (1) 目的與範圍
AGT1-A 已做便宜前置(bin reason redact)。R9 要把**真實 AGT 引擎(Python、跨語言 async)**接進治理 path。**核心 blocker**:`SecondaryPolicyAdapter.evaluate` / `AgtEvaluateFn` / `authorize` 全 sync,但 AGT 是 async。範圍含:async-authorize seam + Python sidecar + AGT decision transport + governance projection + config/setup/doctor/e2e。**不含**:重做 HITL approval 狀態機(另開)。

## (2) 推薦方案
- **Bridge**:**gRPC-over-UDS Python sidecar**,鏡像 SpendGuard 的 `createDecisionLedgerTransport`(runtime vendor zone、lazy client、per-call deadline ~750ms〔`AGT_TIMEOUT_MS`,硬上限 2000ms〕、fail-closed)。Python 端預載 AGT engine、復用 async loop。
- **Async seam(blast radius 集中)**:`runGovernedToolCall` **本就 async**;只把 `authorize`/`SecondaryPolicyAdapter.evaluate`/`evaluateSecondaries` 改 `MaybePromise<T>`(pipeline `await deps.authorize`;sync closure/fakes 仍可用)。**`combineDecisions` 維持純 sync**。要改的 seam:pipeline + 三面 composition roots + bin + MCP deps 型別(+ 測試 await)。
- **Down-advisory 語義(關鍵)**:**configured-but-down AGT → DENY**(advisory-skip = operator 以為 AGT 生效時 fail-open);**unconfigured → 不註冊 secondary,byte-identical**。
- **AGT 看什麼(credential-blind vs 有用性)**:**方案 B — tool-declared governance projection**。每個 effectful tool 宣告最小 action-detail(`exec.run`:`argv0`、`argc`、`argvRedacted`〔bounded ~32/64 tokens〕、`usesShellInterpreter`、`destructiveFlags`、`pathClasses`、`networkHosts`〔userinfo stripped〕、`operationClass`)。在 `authorize` closure 內(screen 之後)建,經 schema validate + redact 才送 sidecar。**不送 env/stdin/file contents/raw args**。projection 重用 exec binding validation 防 drift。PDP 忽略此欄位,只有 AGT adapter 讀。**無 raw-args fallback**。
- **哪些 tool 問 AGT**:預設只 consult `sideEffect: "write"|"destructive"` 或 `requiresApproval` 的 tools(manifest 已有 `sideEffect`/`requiresApproval`)。`exec.run`(write)→ consult;`exec.echo/ls/cat/head/pwd/wc/grep`(read)→ skip。**latency**:30 calls 全問 ≈22.5s vs 只問 5 個 effectful ≈3.75s(對 autonomous loop 差很大)。`AGT_SCOPE=effectful`(預設)/`all`(企業 strict)。
- **`require_approval`**:R9 **flat deny**(reason 留 `agt_action=require_approval`/matchedRule);`AuthorizeDecision` 目前只 allow/deny,approval inbox 是提交前人審、非 policy 中途 pending/resume。真 HITL bridge = 後續 slice。

## (3) 架構概述
- 新 vendor-neutral `GovernanceProjection`(`PolicyRequest` optional advisory 欄位,PDP 忽略)。
- 新 `src/runtime/agt/decision-transport.ts`(lazy grpc-js `unix://AGT_UDS_PATH`、deadline、schema validate response;只有 `allowed===true && action==='allow'` → allow,其餘 deny)。
- 新 `python/agentos_agt_sidecar`(載真 AGT engine,`Evaluate` await async,回 normalized/redacted decision)。
- 雙層 redact(Python 端 + TS authorize 邊界〔AGT1-A 已在〕);WORM 留 audit reason 無 raw secret。
- Flow:`screen(先擋,不呼叫 AGT) → authorize{ PDP sync + await evaluateSecondaries(AGT over UDS) + combineDecisions + redactSecrets } → cost.reserve → commit-before-effect → effect`。

## (4) 切片建議(R9a → R9b → R9c)
- **R9a — async-authorize seam(核心,獨立有值)**:`authorize`/`evaluate`/`evaluateSecondaries` 改 `MaybePromise`;pipeline `await`;throw/reject → `denied@policy` 靜態 reason;`combineDecisions` 仍 sync;三面 + bin + MCP deps 型別 + 測更新。**不接 AGT,純解 sync blocker**(解鎖任何 async secondary)。
- **R9b — AGT transport + adapter + projection**:UDS transport(deadline/fail-closed)+ `exec.run` governance projection(credential-blind allowlist)+ AGT scope gate(effectful default)。fake transport 單測 allow/deny/malformed/timeout/down;mutation 移除 projector allowlist/redaction 翻紅。
- **R9c — config/setup/doctor + e2e**:`agent-os.config.json` strict `agt` 區塊(partial/blank timeout fail-closed);setup 寫 `AGT_*` env;doctor AGT socket PASS/FAIL/SKIP;三面/bin e2e(AGT allow 不放寬 PDP deny、AGT deny 擋 effect、configured-but-down deny、absent byte-identical、WORM redacted)+ gated `e2e:live-agt` 對真 sidecar。

## (5) 兩輪討論摘要
- **R1**:定方案(UDS sidecar)、async seam 集中、down→deny、slice 骨架。
- **R2**:收緊 4 缺口 → projection 方案 B(非 raw args、非 metadata-only)、scope=effectful default、require_approval→deny(R9)、async seam 要改的 production 檔清單。

## (6) ⚠️ 需人工判斷的 open questions
1. **是否現在開工 R9?** 這是 3-slice phase,且**真正接通需要一個真實的 Python AGT engine**(否則是「接好水管但沒有引擎」)。選項:(a) 只做 **R9a**(async-authorize seam,獨立有值、解鎖未來 async secondary,不需 AGT engine);(b) 全 R9(需你有真 AGT engine + Python sidecar 環境);(c) 暫緩到你有 AGT engine。
2. **AGT scope 預設**:`effectful`(建議)vs `all`。
3. **`exec.run` projection**:bounded `argvRedacted` + classified fields(建議,AGT 需 token order 判風險)vs 更 lossy。
4. **`require_approval`**:R9 flat deny(建議)+ 後續 approval bridge vs 一併做 HITL。
- 2-4 Codex 都給了建議預設,可採;**1 是真正的範圍決定**。
