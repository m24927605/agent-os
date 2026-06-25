# SLICE-CAP4a: pipeline approval stage（修 requiresApproval fail-open;fail-closed)

- **Phase**: capability breadth — Slice 4 之 a（pipeline 核心:把 requiresApproval 真正接進 runGovernedToolCall)
- **Branch**: slice/cap4a-approval-stage
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 已決定的姿態
brainstorm 揪出 fail-open:`requiresApproval` 每個 manifest 都宣告、destructive 被 schema 強制,**但 `runGovernedToolCall` 完全沒引用它**(stages = screen→policy→cost→commit,無 approval)。CAP4a 加一個 **approval stage**,把這個 fail-open 修成 **fail-closed**。**已決定(open q#1)**:Personal = 預授權 budget/allowlist 內 auto-approve;Enterprise = 非互動 maker-checker——但那是**各面的 approve 政策(CAP4b)**;CAP4a 只建**通用的 stage + seam + fail-closed 語義**(政策注入點)。

## (1) 範圍(pipeline 核心,surface-agnostic)
1. **`AuthorizeDecision` + optional `requiresApproval?`**(pipeline.ts:30):composition root 的 authorize closure 從 manifest(registry)填它(現 14 工具全 false)。
2. **`GovernedToolCallDeps` + `approve?`**(pipeline.ts):`readonly approve?: (toolCall: TC) => MaybePromise<ApprovalOutcome>`,`ApprovalOutcome = { status: "approved" | "denied"; reason: string }`。`GovernedStage` 加 `"approval"`。
3. **pipeline approval stage**(authorize-allow 後、cost-reserve 前):
   - `decision.requiresApproval !== true` → **跳過**(byte-identical,自主迴圈不變)。
   - `requiresApproval === true`:
     - `deps.approve` **缺** → `denied@approval`(**fail-closed**:宣告需 approval 卻無 approve seam → 拒,絕不放行)。
     - `await deps.approve(toolCall)` → `"approved"` 才續;`"denied"` 或 throw/reject → `denied@approval`(靜態 reason)。
   - approval 在 cost/commit/effect **之前**——拒則三者都不跑。
4. **本刀不接各面政策、不動 WIRED**:`"approval"` 仍未接進 `WIRED_PRIMITIVES`(CAP3)→ destructive 工具**仍不能註冊**(CAP4b 接 approve seam + 把 approval 接進 WIRED 才解鎖)。故 CAP4a 用**合成 requiresApproval 工具**(test 注入)證 stage,real destructive 工具留 CAP4b。

## (2) 不變量
- **fail-closed**:requiresApproval 工具 + 無 approve seam → `denied@approval`;approve throw/reject → `denied@approval`(沿用 R9a 的 reject→deny 樣式)。
- **PDP 仍唯一 DENY 權威**:approval 是 PDP-allow **之上**的 pre-effect 第二授權(任一拒即拒);不放寬 PDP deny(PDP deny → 根本到不了 approval stage)。
- **缺省 byte-identical**:14 工具 requiresApproval:false → stage 跳過 → 行為不變(全測續綠);`approve?` optional、`requiresApproval?` optional。
- **commit-before-effect 不變**:approval 在 commit 前;approved 才 append+effect。
- destructive 工具**仍不能註冊**(CAP3 gate,approval 未進 WIRED)——CAP4a 不解鎖,只備好 stage。

## (3) Test-first plan（RED 先行）
- 注入合成 authorize 回 `{effect:"allow", requiresApproval:true}` + `approve` 回 `"approved"` → 續到 effect;`approve` 回 `"denied"` → `denied@approval`,cost/commit/effect **0**。
- **fail-closed**:`requiresApproval:true` + **無 `approve` deps** → `denied@approval`,substrate 0。mutation:stage 對「無 approve」放行 → 翻紅。
- approve **reject/throw** → `denied@approval`(不洩 message)。
- `requiresApproval:false`(或未設)→ stage 跳過,與今日同(byte-identical);`approve` 即使有也不被呼叫。
- PDP deny → 停在 policy stage,approval 不執行(approval 不能救 PDP deny)。
- byte-identical:既有 pipeline/三面/bin/EXEC4c 測全綠(approve/requiresApproval optional 缺省)。

## (4) Definition of Done（待實測填）
- [ ] RED → verify exit 0(approval stage + `approve?` seam + `AuthorizeDecision.requiresApproval?` + `GovernedStage` "approval";fail-closed〔無 seam / denied / reject → denied@approval,effect 0〕;requiresApproval:false 跳過 byte-identical;PDP sovereign;mutation 證;depcruise/secret-scan clean;無新依賴);獨立 Opus 4.8 review PASS。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(optional 欄位 + 新 stage 純加;缺省 byte-identical)。
- Depends-on:pipeline(R9a async authorize)、manifest(requiresApproval)、CAP3(WIRED)。Blocks:**CAP4b**(Personal 預授權 budget approve seam + Enterprise maker-checker approve seam + 把 "approval" 接進 WIRED → 解鎖 destructive 工具)、Slice 6(git.push)。
- **誠實前提**:CAP4a 只修 **runtime fail-open**(pipeline 現在真的 enforce requiresApproval)+ 備好政策注入點;**各面 approve 政策(Personal budget / Enterprise maker-checker)+ 把 approval 接進 WIRED = CAP4b**。在 CAP4b 前無 real destructive 工具能註冊(CAP3 gate),故 CAP4a 以合成工具證 stage。
