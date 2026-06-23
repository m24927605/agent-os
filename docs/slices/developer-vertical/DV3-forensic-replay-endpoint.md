# SLICE-DV3: forensic replay 端點（typed foldedState + projection + buildTaskTimeline 對齊 + point-in-time）

- **Phase**: P4（Developer 垂直;把 DV1 的 thin `replayFold` 升成有意義、對齊、point-in-time 的 forensic 端點）
- **Branch**: slice/dv3-forensic-replay-endpoint
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **Size budget**: <= 1 day；純 TS;新增依賴 = 0
- **狀態**: **DRAFT**

## (0) 動機 + 現況（grounded）
DV1 的 `replayFold(uptoSeq?)` 是 thin `replayTimeline`。但 forensic 端點有三個缺口:
- `replayTimeline` 的 **`foldedState` = `{events: unknown[]}`**(只堆原始 events,public 型別 `unknown`,replay.ts:35,162)——**無意義累積狀態、無開發者/稽核契約**(研究 risk 明指)。
- DV1 的 WORM `LogEntry`→`ReplayEvent` 投影是 **inline**,未形式化/未獨立測試。
- forensic replay(`replayFold`)與系統實際 timeline(`buildTaskTimeline`,personal/timeline/timeline.ts:58,`AuditEvent[]→TimelineEvent[]`)**未證對齊**——開發者無法信 forensic replay 反映系統真實視圖。
- DV1 未 exercise/證 **point-in-time `uptoSequence`**(replay.ts 已支援 cut-point + 越界 `ReplayError`)。

## (1) ID + Title
SLICE-DV3 — (a) **鎖定 typed forensic foldedState schema**(取代 `unknown`):一個 deterministic 純 fold 累積(如 `{ eventCount, executed, denied, byResource: Record<resource,{lastAction,lastResult}> }`)over WORM 的 AuditEvents;(b) 形式化 + 匯出 **`projectWormToReplayEvents(entries) → ReplayEvent[]`**(`LogEntry{sequence,event}→ReplayEvent`,typed,fail-closed);(c) `DeveloperKit.replayFold` 回 forensic 視圖(timeline + typed forensicState)且 **point-in-time `uptoSequence`** 證明(as-of-N steps/state + deterministic timelineHash + 越界 ReplayError);(d) **對齊證明**:同一份 WORM 經 `replayFold` 的 steps 與 `buildTaskTimeline` 的 TimelineEvent[] 一致(同序、同 per-step action/resource)。

## (2) Goal（一句話）
讓開發者/稽核員能把 WORM forensic-replay 成**有 schema、deterministic、可截到任一時點**的狀態,且該重播**對齊系統實際 timeline**(`buildTaskTimeline`)——把「不必信任 operator」從「驗鏈」延到「驗系統演進的可重算性」。

## (3) In-scope / Out-of-scope
- In-scope:
  - **typed forensic foldedState schema**:定義具體型別(取代 replay.ts 的 `unknown`/raw-events 或在 Developer 層加 `foldForensicState`——取最小乾淨,見 §4 決策),deterministic 純 fold,redaction-blind,content-addressed timelineHash 不變語意。
  - **projection helper**:`projectWormToReplayEvents(entries: readonly LogEntry[]): readonly ReplayEvent[]`(typed event、依 sequence 排序契約、fail-closed on malformed),DV1 inline 改用之。
  - **DeveloperKit.replayFold** 升級:回 `{ timeline: TaskTimeline; forensicState: ForensicState }`(或新增 `forensicState(uptoSeq?)`);`uptoSequence` point-in-time(as-of-N + 越界 ReplayError 傳遞)。
  - **對齊**:測試證 `replayFold(WORM).steps` 與 `buildTaskTimeline(同 WORM entries)` 一致(count、order、per-step action/resource 對得上)。
  - 單元測試(in-tree,純函數):foldedState schema 正確累積、deterministic(同 WORM→同 timelineHash)、point-in-time 截點正確、越界 ReplayError、對齊 buildTaskTimeline、projection fail-closed。
- Out-of-scope（誠實標記）:
  - live(forensic replay 是純函數重算,**無 live 需求**;鏈的密碼學驗證是 DV2/K2/PK2 的 verifier,已 live)。
  - 改 `buildTaskTimeline`(audit 層)——DV3 只**對齊**它,不改它。
  - snapshot/restore(R10-S2/S3)整合 = 後續。
  - UI 呈現 forensicState = 後續。

## (4) Design delta + 依賴方向 + 決策
- **決策(foldedState schema 落點)**:① 改 `replayTimeline` 的 foldedState 為 typed(但耦合 generic 引擎到 AuditEvent 形狀,且改 timelineHash → 動既有 replay.ts 測試);或 ② `replayTimeline` 保持 generic,Developer 層加純 `foldForensicState(events): ForensicState`(replay.ts 不變,schema 在消費者)。**傾向 ②**(replay.ts 維持 generic 引擎、低耦合;ForensicState 為 Developer-facing 契約),writer 取最小乾淨且**不破既有 replay.ts/DV1 測試**。
- 依賴經 barrel(orchestration〔replayTimeline〕、audit〔LogEntry/AuditEvent〕、personal/timeline〔buildTaskTimeline,僅對齊測試 import〕)。
- **PUBLIC**:`ForensicState` 型別;`projectWormToReplayEvents`;`DeveloperKit.replayFold` 的新回傳/`forensicState`。

## (5) Test-first plan（RED 先行）
- foldedState/forensicState schema 測試:fold over 已知 WORM → 正確 `{eventCount, executed, denied, byResource}`;在 schema 實作前紅。
- deterministic:同 WORM 兩次 → 同 timelineHash/forensicState;**point-in-time**:`replayFold(uptoSeq=k)` 只含 seq≤k、forensicState as-of-k;越界 uptoSeq → ReplayError。
- **對齊**:`replayFold(WORM).steps` 的 (action,resource,順序) == `buildTaskTimeline(同 entries)` 的對應 — 不一致則紅。
- projection:malformed LogEntry → fail-closed;依 sequence 排序。
- 首次 RED:`projectWormToReplayEvents`/`forensicState`/typed schema 不存在 → 型別/import 錯。

## (6) Definition of Done（待實測填）
- [ ] RED:schema/projection/forensicState 在實作前紅。
- [ ] `pnpm run verify` exit 0(DV1/DV2 + 既有 replay.ts/Personal 不變;forensic 單元綠;depcruise/secret-scan clean)。
- [ ] **typed forensic foldedState**:`ForensicState` schema 取代 `unknown`;deterministic 純 fold;mutation(漏算 denied / 非 deterministic 排序)→ 測試紅。
- [ ] **projection helper**:`projectWormToReplayEvents` typed + fail-closed(malformed → reject);DV1 inline 改用之。
- [ ] **point-in-time**:`replayFold(uptoSeq)` as-of-N steps/state 正確 + 越界 ReplayError;mutation(忽略 uptoSeq / off-by-one)→ 紅。
- [ ] **對齊 buildTaskTimeline**:同 WORM 的 replayFold steps 與 buildTaskTimeline 一致;mutation(replayFold 漏一步 / 亂序)→ 對齊測試紅。
- [ ] timelineHash content-addressed 不變(redaction-blind);credential-blind。
- [ ] Adversarial review = PASS(獨立 Opus 4.8;mutation:forensicState 漏算、uptoSeq 忽略、對齊偏差)。

## (7) Rollback
- `git revert <merge-sha>`(ForensicState + projection + replayFold 升級 + 測試)。DV1/DV2 核心、replay.ts generic 引擎(若選 ②)不受影響。

## (8) Depends-on / blocks
- Depends-on:DV1(createDeveloperKit + replayFold + WORM)、R10-S1(replayTimeline/ReplayEvent/TaskTimeline)、P2R-R7-S5(buildTaskTimeline/TimelineEvent)。
- Blocks:無(forensic 端點完成;DV4 Python、DVx integrate、snapshot/restore 整合 = 後續)。
- 確認 DAG 無 cycle: ☑ 是
- **誠實前提**:DV3 證 forensic replay 有 schema、deterministic、point-in-time、對齊系統 timeline(純函數,無 live);鏈的密碼學驗證 = DV2/K2/PK2(已 live);snapshot/restore 整合、UI = 後續。
