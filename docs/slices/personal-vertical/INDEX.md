# Personal 垂直切片 — 把已建模組組裝成「人能操作的可跑系統」(INDEX)

> 2026-06-22。目標:把 R7 Personal surface 的元件(已各自建好且有 RED 測試)+ P2-I governed pipeline +
> commit-before-effect + CostGate + effect + WORM,**組裝成一條可執行主幹**:`文字意圖 → 澄清 → 白話計畫 →
> 核可 → 治理管線(screen→PDP→cost→commit-before-effect→effect)→ 時間軸`。這是「它真的會跑」的里程碑。
> grounded 研究見 task w6cuc49qq。方法論:[`looping-engineering.md`](../../standards/looping-engineering.md)。

## 0. 唯一缺口 = composition root
所有模組已建(`src/personal/{intent,plan,approval,timeline,voice}` + `src/orchestration` P2-I + commitgate + cost +
substrate fake/openshell + audit/ingest live appender),但**全 repo 無任何 src 檔 `new ApprovalInbox` 或把
`runGovernedToolCall` 接進去**。本垂直切片補上這個 composition root + 端到端證明。

## 1. 端到端呼叫鏈(grounded,file:line)
1. `receiveText(text, ctx, deps?)` → redactSecrets + parseAgentContext + deterministic parse → `ReceiveOutcome{intent|needs-clarification|denied}` — `src/personal/intent/gateway.ts:51`
2. needs-clarification → `startClarify`/`answerClarify`(≤`CLARIFY_MAX_QUESTIONS=3`,超過→denied)— `src/personal/intent/clarify.ts:84/94/25`
3. `StructuredIntent{action,targets[],context,rawText}` — `src/personal/intent/schema.ts:24`
4. `renderPlanPreview(intent)` → `PlanPreview{title,steps[],affectedResources[],summary}`(每出口 redact)— `src/personal/plan/preview.ts:56`
5. 組裝 `GovernedCall{tool,context}`(由 intent.action/targets 推導;需新增 `buildToolCall` helper)— pipeline.ts:24
6. `inbox.submit(preview, call)`(`MAX_PENDING=3`)→ `{pending,id}|{denied}` — `src/personal/approval/inbox.ts:80`
7. `inbox.approve(id)`(唯一 effect 入口;先 delete 防 replay)→ 注入的 `run(call)` — `inbox.ts:96`
8. `run = (tc) => runGovernedToolCall(deps, tc)` — `src/orchestration/pipeline.ts:53`(deps 由 root partial-apply 注入 inbox 建構子)
9. 五道閘:`screen → authorize(PDP) → cost.reserve → commitBeforeEffect(appender→effect) → cost.commit`;任一 deny 短路 `{denied,stage}`
10. `buildTaskTimeline(log.entries(), {taskId})` → `TimelineEvent[]`(純 fold,每字串 redact)— `src/personal/timeline/timeline.ts:58`

## 2. ⚠️ 關鍵接縫真相（最容易踩雷）
pipeline 注入的 appender 寫的是**結構性事件** `{kind:'tool-invocation',tool,context,decisionReason}`(pipeline.ts:79-84),
回傳的 `AppendReceipt` **只有 hash、無 event**;但 `TaskTimeline` 讀的是 `LogEntry.event`(必須是**完整 AuditEvent**:
action/resource/policyDecision/result/taskId/timestamp,timeline.ts:38-50)。**`pipeline.e2e.test.ts` 的 okAppender(只回
{sequence})不可照抄。** composition root 必須提供一個 **appender adapter**:`append(structuralEvent)` 時用
`createAuditEvent(...)`(audit/event.ts)由 `{context, tool, decisionReason}` 合成真正的 AuditEvent、寫進一份**共享的
`InMemoryAppendOnlyLog`**(kernel/log.ts:99/121),timeline 才能 `entries()` 折出可讀事件。這是「寫的 WORM == 讀的 WORM」唯一成立方式。

## 3. 切片分解（小、RED-first）
| Slice | 範圍 | 注入實作 | 狀態 |
|---|---|---|---|
| **P2R-PV-S1** | 最薄可執行主幹:純記憶體 composition root `createPersonalShell(deps)` + e2e(happy + 3 deny 短路 + approve-once + clarify-cap) | InMemoryCostGate · FakeSandboxAdapter effect · **共享 InMemoryAppendOnlyLog 的 AuditEvent appender** · screenBrainEvent · evaluatePolicy(allow tool:invoke) | DRAFT(先建)|
| **P2R-PV-S2** | 把 appender 換成 **live ingest**(`createIngestAppender`+`createRpcAppendTransport`)→ 真 kernel WAL append;gated on `AGENTOS_LIVE_KERNEL_ENDPOINT`;讀回仍走 WAL 檔斷言(沿用 live-kernel.e2e 模式)| 同 S1 + live appender(sourceId='personal')| DRAFT |
| **P2R-PV-S3** | live 讀回時間軸:需 kernel 新增 list/read-back RPC(目前只有 AppendService;Checkpoint 只回 head anchor、grpc-client Checkpoint fail-closed)→ timeline 吃 live kernel entries。**最重、可能再拆** | live kernel read-back | DRAFT(capability-gated)|

## 4. 風險（誠實）
- **live 讀回不存在**:kernel 只暴露 AppendService(main.go),無 list/read RPC;`TaskTimeline 讀 == appender 寫`的同一份 WORM 這個 invariant **只在 in-memory(S1)成立**;live(S3)要先補 kernel 讀回路徑(風險最高,可能依 R10-S3 Checkpoint 接線)。
- **appender 寫型別 ≠ timeline 讀型別**(見 §2)——S1 最易踩雷的接縫。
- **docker-compose 落差**:`deploy/personal/docker-compose.yml` 引用三個無 build context 的映像 + 埠落差(compose 7070 vs kernel 預設 7777);`docker compose up` 目前會失敗。屬部署(S2+/後續),非 S1。
- **須注入 allow rule**:authorize 用空 allow 集合 → happy path denied@policy;S1 測試明確注入 `allow tool:invoke`(沿用 pipeline.e2e.test.ts allowAll 樣板)。
- **iam barrel(B0)**:personal/* 直 import `../../iam/ids.js`(現有 interim 例外);composition root 沿用即可。

## 5. 交付順序
S1(in-memory,可跑,展示「它會跑」)→ S2(live append 入真 WORM)→ S3(live 讀回,需 kernel 新 RPC)。每刀 doc-first + RED + 獨立 Opus 4.8 review + merge。
