# SLICE-CAP4b: approve 政策 + 接 "approval" 進 WIRED（解鎖 destructive 工具)

- **Phase**: capability breadth — Slice 4 之 b（把 CAP4a 的 approval stage 接上各面政策 + WIRED,讓 destructive 工具可註冊+受 approval gate)
- **Branch**: slice/cap4b-approve-policies
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機 + 已決定姿態
CAP4a 建了 approval stage(fail-closed),但無 approve seam、`"approval"` 未進 WIRED → destructive 工具仍不能註冊(CAP3 gate)。CAP4b 補:**approve 政策**(open-q#1 已決:**Personal = 預授權 budget/allowlist 內 auto-approve**;Enterprise = 非互動 maker-checker)+ 把 `"approval"` 接進注入了 approve seam 的 composition 的 WIRED。聚焦**自主路徑(bin)**(使用者實際走的);三面 approver factory 備好。**仍無 real destructive 工具**(git.push 在 Slice 6,需 egress S5)→ 以**合成 destructive 工具**端到端證。

## (1) 範圍
1. **`ToolRegistry` + `wired?` param**(src/tools/registry.ts):`constructor(seed?, wired: ReadonlySet<Primitive> = WIRED_PRIMITIVES)`(存 instance wired);`assertRegisterable(manifest, this.#wired)`。composition 傳 `new Set(["approval"])` 才能註冊 destructive 工具。缺省(不傳)= 空 = 同今日(byte-identical)。
2. **approver factories**:
   - **`createBudgetApprover(isPreAuthorized: (toolCall)=>boolean): ApproveSeam`**(vendor-neutral,Personal 姿態):pre-authorized → `{status:"approved"}`;否則 `{status:"denied", reason:<靜態>}`。`isPreAuthorized` 由 config 注入(預授權 allowlist/budget;**unconfigured → deny-all**,fail-closed)。
   - **`createMakerCheckerApprover(...)`**(Enterprise 姿態,enterprise 區):包既有 `enforceMakerChecker(ctx,action,cap)` → ApproveSeam(deny → `{status:"denied"}`)。
   - ApproveSeam = `(toolCall)=>MaybePromise<ApprovalOutcome>`(CAP4a 型別)。**靜態 reason 不轉發 untrusted approver `.reason`**(CAP4a reviewer 的 MINOR)。
3. **bin closure 設 `requiresApproval`**(exec-mcp-server-bin.ts):closure 已有 `registry`;在回傳的 `AuthorizeDecision` 加 `requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false`(餵 CAP4a 的 stage)。現 14 工具全 false → stage 跳過(byte-identical)。
4. **bin 注入 budget approver + wired "approval"**:bin deps `approve = createBudgetApprover(preAuthFromEnv)`;bin registry 以 `wired ⊇ {"approval"}` 建(因注入了 approve seam——耦合:有 approve seam ⟺ 該 registry wired 含 "approval")。pre-auth allowlist 由 env/config(類 SpendGuard;**unconfigured → deny-all**)。
5. **本刀不加 real destructive 工具**(git.push = Slice 6,需 egress S5);以合成 destructive seed 工具(sideEffect destructive、requiresApproval true、containment in-sandbox)端到端證。三面(Personal/Enterprise)的 approve 接線 = 薄延伸/註記(bin 是自主路徑,先證它)。

## (2) 不變量
- **fail-closed**:destructive 工具 + unconfigured pre-auth(deny-all)→ `denied@approval`;approve reject/throw → denied@approval(CAP4a)。**有 approve seam 才把 "approval" 接進該 registry wired**(否則 destructive 工具註冊期就被 CAP3 gate 擋)。
- **PDP 仍唯一 DENY**:approver 只在 PDP-allow 之上 gate(CAP4a)。
- **缺省 byte-identical**:14 工具 requiresApproval false → stage 跳過;`wired` 不傳 = 空 = 今日;approver 未注入的 composition 不變。
- **credential-blind**:approver **不轉發 untrusted `.reason`**(靜態);pre-auth allowlist 是 config(非-secret)。
- 無新依賴。

## (3) Test-first plan（RED 先行;Fake substrate）
- `createBudgetApprover`:isPreAuthorized true → approved;false → denied;**unconfigured(deny-all 述語)→ denied**。
- `createMakerCheckerApprover`:enforceMakerChecker allow → approved;deny → denied。
- **registry wired param**:`new ToolRegistry([<destructive 合成>], new Set(["approval"]))` → 註冊成功;`new ToolRegistry([<destructive>])`(default 空)→ CAP3 gate refuse(throw)。mutation:wired 忽略 → default-空測翻紅。
- **bin 端到端(核心)**:合成 destructive seed 工具 + bin(wired "approval" + budget approver):pre-authorized → approval stage approved → effect 跑;非 pre-authorized → `denied@approval` → cost/commit/effect 0。bin 14 既有工具(requiresApproval false)→ stage 跳過、行為不變。
- **requiresApproval 來自 manifest**:closure 對 destructive 工具設 requiresApproval true、對 read/write 設 false(從 registry.lookup)。mutation:closure 不設(恆 false)→ destructive 合成測的 approval-gate 失效 → 翻紅(本該 gate 卻沒)。
- byte-identical:既有 bin/三面/EXEC4c/CAP1-3 測不變綠。

## (4) Definition of Done（實測）
- [x] **DONE（merged)**:`ToolRegistry` + optional `wired`(default WIRED_PRIMITIVES;ctor+register 都 `assertRegisterable(m, this.#wired)`)+ `createBudgetApprover(isPreAuthorized)`(orchestration,vendor-neutral)+ `createMakerCheckerApprover`(enterprise,包 enforceMakerChecker)+ bin closure `requiresApproval: registry.lookup(tc.tool)?.requiresApproval ?? false` + bin wired `{"approval"}` + `approve = createBudgetApprover(preAuthFromEnv(AGENTOS_APPROVE_PREAUTH;unconfigured=deny-all))`。RED → verify **exit 0**(1363 passed + 29 skipped;4 新測檔;**closure-不設-requiresApproval mutation 翻〔fail-open 復現〕、ignore-wired 翻、budget-ignore-predicate 翻 4、maker-checker-ignore 翻 3**;bin 端到端〔pre-auth→approved→effect 1;非/deny-all→denied@approval→effect 0〕;unconfigured=deny-all〔unset/empty/whitespace/malformed/null 全 deny〕;PDP-sovereign;14 工具 byte-identical;approver **三層靜態 reason**〔canary 不洩〕;depcruise no-vendor-in-core 綠+bite;secret-scan clean;無新依賴)。獨立 Opus4.8 review PASS。2 informational(depcruise-in-verify tracking〔SLICE-P0-003〕;tool-name pre-auth coarseness 已誠實標為 v1)。
- **approval 端到端接通(自主/bin 路徑)**:requiresApproval fail-open 全修。real destructive=git.push 待 Slice 5(egress)+6;三面 approve 接線 = factory 備好 + 薄接(bin 是自主路徑重點)。Personal=預授權 budget(unconfigured deny-all);Enterprise=maker-checker。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(wired param optional + approver factory 純加 + bin 接線;缺省 byte-identical)。
- Depends-on:CAP4a(approval stage/seam/requiresApproval?)、CAP3(WIRED/assertRegisterable)、enforceMakerChecker(enterprise)、manifest。Blocks:Slice 5(egress)/6(git.push:第一個 real destructive+network 工具,屆時 containment network-egress + 需 egress〔S5〕+ approval〔本刀〕都 wired 才註冊)。
- **誠實前提**:CAP4b 把 approval **端到端接通**(bin 自主路徑),但**仍以合成 destructive 工具證**(real destructive=git.push 待 S5/6)。Personal 姿態 = 預授權 budget auto-approve(unconfigured deny-all);Enterprise = maker-checker。三面(SDK surfaces)的 approve 接線先備 factory、薄接(bin 是自主路徑重點)。approver 不轉發 untrusted reason(守 CAP4a MINOR)。
