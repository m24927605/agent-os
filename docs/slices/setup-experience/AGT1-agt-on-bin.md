# SLICE-AGT1: AGT advisory on the autonomous (bin) path — 誠實的 blocker + 可建範圍

- **Phase**: integrations（讓 AGT advisory 也 gate autonomous 路徑,如 SpendGuard 已做)
- **Branch**: slice/agt1-on-bin（待核准)
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT — ⚠️ 含一個需你拍板的設計 blocker(grounding 揭露)**

## (0) ⚠️ 誠實的 blocker(grounding 揭露,務必先讀)
SETUP1a 已讓 bin 折 advisory secondaries,但 **secondaries 無法從 env/config 接**(env 帶不了 code)。要把 AGT 接進 bin,grounding 揭露三個 sync/async + 跨語言事實:
1. `SecondaryPolicyAdapter.evaluate(req): PolicyDecision` 與 AGT 的 `AgtEvaluateFn = (ctx)=>AgtDecision` 都是 **SYNC**(src/policy/dedup.ts、src/policy/adapters/agt/adapter.ts)。
2. bin 的 `authorize: (tc)=>AuthorizeDecision` 也是 **SYNC**(pipeline 全鏈 sync)。
3. adapter 自陳 **「真 AGT 引擎是 Python,經 R9 SDK seam 接入」——R9 未建**。
→ **真 Python AGT 是跨語言 async,塞不進 sync 的 `AgtEvaluateFn`/authorize。** 乾淨接法需:**(R9) async 跨語言 bridge** +(可能)**把 authorize 改 async**(pipeline + 三面 + bin 的核心改動,大 blast radius)。**這不是現在能乾淨做的。**

## (1) 可建範圍(現在,不需 R9 / 不改核心 async)
1. **bin reason redact(該做,不論 AGT)**:SETUP1a 折了 secondaries,但**未** `redactSecrets(combined.reason)`。一旦任何 advisory secondary 被接,其 reason 流進 bin 的 commit-before-effect AuditEvent → WORM;不可信 secondary 的 reason 可能帶 secret。**bin 的 authorize 須 `redactSecrets(combined.reason)`**(鏡像 IT1a 三面已證 load-bearing 的修)。現 secondaries=[] 無洩漏,但這是接 AGT 前的必要前置。**cheap、correct、獨立有值。**
2. **(可選)config module-path plumbing**:`agent-os.config.json` 的 `agt: { adapterModule: "<path>" }` → bin 動態 `import()` 一個 export **SYNC `SecondaryPolicyAdapter`** 的 operator 模組 → 折入 secondaries。env/config-wireable(path 是字串)。⚠️ 限制:只接 **sync TS** advisory adapter;**真 Python AGT 仍需 R9**(operator 得自寫 sync bridge,有限)。⚠️ 安全:動態 import operator 碼進 governance bin——operator-trusted + advisory-only(any-deny-wins、只能更嚴);module-path 設了但 import 失敗/非法 → **startup fail-closed**(不靜默無 AGT 跑,鏡像 SpendGuard partial-config guard)。

## (2) ⚠️ 待你拍板(這刀的核心決定)
- **A(建議,最小且誠實)**:**只做 (1) bin reason redact**。它是接任何 secondary 的必要前置、cheap、correct;把「真 AGT 接入」誠實留給 **R9(async Python bridge)**——因為真 AGT 是 Python-async,現在硬接只會是半套。
- **B**:做 (1) redact + (2) config module-path plumbing(env/config-wireable,但只接 sync TS adapter;真 Python AGT 仍待 R9)。多一條注入路徑,但對「真 AGT」價值有限 + 多一個動態-import 安全面。
- **C**:做大改——**authorize 改 async** + R9 async bridge → 真接 Python AGT。**大 blast radius、應另立 phase,不在本刀。**

## (3) 不變量(沿用)
PDP sovereign / advisory any-deny-wins、只能更嚴 / fail-closed(module 載入失敗 → startup deny)/ credential-blind(**新增 bin reason redact**)/ 缺省 byte-identical(無 agt config → 同今日)/ zero-dep(動態 import 是 node 內建)。

## (4) Test-first（依選定範圍)
- (1) redact:bin 注入一個 reason 帶 sk- canary 的 secondary → 經 bin 後 committed AuditEvent.decisionReason **已 redact**(canary 不入 WORM);clean reason identity;mutation:移除 redact → canary 入 WORM 翻紅。(鏡像 IT1a developer 面那個 load-bearing 測。)
- (2)(若做)module-path:valid sync adapter module → 載入 + 折入(deny adapter → denied;allow adapter 不放寬 PDP deny);module 缺/import 失敗/非法 export → startup fail-closed(非零);credential-blind。

## (5) Rollback / Depends-on
- Rollback:`git revert`(bin authorize redact + 〔若做〕module-path loader 純加法)。
- Depends-on:SETUP1a(bin secondaries fold)、IT1a(`redactSecrets` reason 修樣式)、policy(`combineDecisions`)。**真 AGT 接入 depends-on R9(未建)。**
- **誠實前提**:本刀**不接真 Python AGT**(那需 R9 async bridge + 可能 async-authorize);只做接任何 secondary 的必要前置(reason redact)+(可選)sync-adapter 的 config 注入路徑。真 AGT = 未來 R9 phase。
