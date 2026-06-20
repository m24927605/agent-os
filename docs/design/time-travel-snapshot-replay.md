# Agent OS — 時光旅行：Snapshot / Restore / Replay（風險管理）

> 2026-06-20，Staff+ 團隊（讀真實 repo：`agent-os` / OpenShell / Hermes / SpendGuard）設計，純思考無 code。
> 裁決：**feasible-but-reframed**。地基（event-sourcing、commit-before-effect、outbox 冪等、離線 verifier）P0/P1 已具備。

## 一句話
**做得到——但要誠實拆成兩個本質不同的能力**：① **Forensic Replay（唯讀真相重建，今天可建、零 kernel 改動）**；② **Live Rollback（真的把系統倒回某時點繼續跑，內部狀態可逆、外部 effect 不可逆）**。PC snapshot 類比精確、也劃定上限：它還原**本地/內部狀態**，但收不回已離開網路的 email。

## 兩個能力（分開答）
- **Forensic Replay（唯讀）**：`state(T) = fold(events[0..N])`。WORM 本就是純 event-sourcing（`kernel/internal/store/store.go` 的 LogRecord 帶 Sequence/PrevHash/EntryHash/Event）。在 orchestration 層寫 deterministic 的 `TimelineReducer`，把事件套到**複製出來的狀態物件**上重建任一時點——**不重跑任何 tool、不打外部、不碰 credential**，離線 verifier 可驗（同段 log → 同一 timeline hash）。交付「真相重建」供稽核/事後調查/Independent Verifier。**~500 LOC、零 kernel 改動、風險最低 → 先做（P1.5）。**
- **Live Rollback（mutating）**：把 agent 走錯的內部狀態（壞 plan、汙染 memory、卡死 retry loop）倒回已知良好點繼續。**內部可逆；自 T 起的外部 effect 是不可化約問題**，只能 prevent/compensate/accept。

## 能還原 / 不能還原
**能還原**：WORM 衍生 materialized state（fold 重建）、orchestration DB（transaction overwrite 成 folded state）、cost ledger（SpendGuard Postgres：有 WAL archiving 則 PITR 到 LSN，否則 append 一筆 REVERSAL）、brain memory/skills（**條件式**，需 brain memory 版本化，見下）、sandbox 宣告式狀態（reprovision-from-golden-image + idempotent setup replay）、commit gate **之前**的 staged effect（零成本完全還原）。

**不能還原（物理界線，非 code 問題）**：已送出的 email／已 POST 的外部 API／已扣的款／已發的權限；OpenShell sandbox 的**記憶體/in-flight state**（見下「兩個現實校正」）；非 idempotent tool 的 tool 內部副作用；以及「補償在外部系統是否真的生效」（WORM 只能證明**嘗試過**補償）。

## 外部 effect 補償策略（三段，承重點）
一旦 effect 離開系統就無法用「倒回內部狀態」抹除。三段式處理，**分類掛在 `ToolManifest.sideEffect`**（none/read/write/irreversible/external）+ 每 tool 的 `idempotent: bool`：

1. **PREVENT-before-commit（最佳、免費）**：effect 不在 durable commit 前外溢。`kernel/internal/commitgate` 已強制 commit-before-effect——effect 被 staged，audit 紀錄 durable 後才放行。**snapshot 取在 commit 之前 ⇒ effect 從未離開 ⇒ rollback 零成本、零外部痕跡。** 最便宜的「補償」是還沒 commit。
2. **COMPENSATE-after（saga 模式）**：已 commit、但有反向動作的 effect，每個這類 tool 宣告一個 `compensate()`——退款、寄更正/撤回信、刪除已貼訊息、revoke 已發權限。rollback 到 T ＝ 還原內部狀態 + 對 T 之後每個不可逆 effect **往前**跑其補償。**關鍵誠實：補償 ≠ 抹除**——收件人仍看過原信、退款是一筆**新**交易而非讓扣款沒發生過。原始 effect 與補償**各自 append 進 WORM**（歷史顯示「做了 X、又補償了 X」），永不抹除。這是分散式交易的 Saga：無全域 rollback，故每步配一個 compensating transaction，逆序執行。
3. **ACCEPT-and-record（最後手段）**：無任何可能補償者（不可逆物理動作、或外部系統不支援撤回）——無法逆轉。策略：**仍倒回內部狀態，但 WORM 永久記錄 `external_effects_since_baseline`（divergence report）並升級人工**。operator 在**核准 rollback 前**就看到「哪些外部 effect 將永遠留在世界上」，不盲簽。

**Email 端到端範例**：commit 前（草稿 staged、未送）→ rollback ＝ 丟草稿（PREVENT，免費）；已送、收件人未關鍵行動 → compensate ＝ 寄「請忽略/更正」後續信（但對方已看過，誠實標註）；已送 + 收件人已行動 → 無法補償 ⇒ ACCEPT-and-record：倒回內部狀態，WORM 記「T 時已寄給 X、無法收回」，通知人工。

## Brain memory 版本化（讓 brain 狀態也能還原）
**問題**：腦（Hermes）有自己演進的狀態——學到的 memory、user model、自建/自改的 skill（curator）、跨 session 知識。把系統倒回 T，**腦的 memory/skill 也得是 T 當時的樣子**，否則任務狀態倒回了、腦卻仍「記得」未來的事（不一致，甚至正是你要倒掉的汙染）。

**現況**：Hermes **不做版本化**——memory 單回合 ephemeral、原地 mutate、無「memory 變更」事件，無法問「sequence N 時腦知道什麼」。

**版本化 ＝ 把腦的每次 memory/skill 變更當成被記錄的 versioned mutation**：
- 每次 memory write / skill create / skill update / curator action 走治理路徑並**發一筆 `MemoryMutatedEvent` 進 WORM**（這正是架構已定的「self-improving agent 的 memory mutation 必須 Append-to-WORM-before-effect」規則）。則**腦的 memory@T ＝ fold(memory events ≤ N)**，與全系統同一套 event-sourcing。
- 在 **Brain Port** 上加 `BrainState{ export(), import(), schema_version }` 抽象，讓 orchestration 能 snapshot/restore 腦的 memory **而不需懂 Hermes 內部**（保 pluggability；dependency-cruiser 擋住 orchestration 直接 import hermes）。
- **為何對 rollback 關鍵**：沒有它，倒回後腦帶著「未來」memory → 會重推出同樣的壞 plan、或依你已抹掉時間線的知識行動；有它,腦被還原到 T 狀態,從乾淨點續跑。
- **一魚兩吃**：同一機制也讓「治理、可稽核的自我進化」成真——稽核者能重播「哪些經驗造就哪些 skill」。
- **狀態**：P2 工作（Hermes 整合經 Brain Port）。**interim fallback**：rollback 時直接 reset 腦 memory、下一輪 prefetch 重載（精度較低、丟學到的脈絡，但安全）。

## 一致性快照設計
統一錨點 ＝ 單一 **WORM sequence number N**（ingest 單執行緒 mutex 序列化，sequence 不可改），其他狀態都以 N 定址。一致切點用 **commit-boundary quiesce**（非 Chandy-Lamport）：ingest 同步單寫入 + commitgate 強制 commit-before-effect ⇒ 天然靜止點。協定：orchestration 取得**跨 ingest 的 GLOBAL lock**（**非** per-task——WORM 全租戶共享，per-Task lock 擋不住 kernel append，草案必修點）→ 確認 seq>N 無 irreversible/external effect（掃 `outbox.delivered`）→ 同步擷取 WORM head entryHash@N、orchestration FSM fold hash、brain memory dump hash、sandbox 宣告狀態、Postgres WAL LSN → 各 constituent 存獨立 immutable snapshot store（S3 versioned 或 append-only snapshotstore.db）→ `SnapshotRecord` 本身以 `system.snapshot` AuditEvent append 進 WORM。
**必修 kernel gap**：「acquire lock 就沒有新 Append」在現行 kernel 不成立——須在 `kernel/internal/server/append.go` 暴露 **snapshot-safe checkpoint RPC**，原子擷取 `[store committed offset, outbox.lastSeq, outbox.delivered]`，否則讀檔撞 fsync 中途 torn frame。

## WORM 不變量（時光旅行在「狀態層」，不在「log 層」）
**rollback 絕不截斷 log。** `restore-to-S` 是一筆 **NEW forward `RestoreEvent`**（kind `system.restore`，actor=admin/approver，sourceId ≠ brain）append 進 hash-chain；log 永不 rewrite/truncate——由 `store.go`（無 Truncate 表面）+ `outbox.go`（append-only by construction）強制。倒的是**狀態層 projection**，原始 events[0..M] 全留在鏈上，forward 從 M+1 續。**attester≠actor 維持**：restore 由 orchestration 發起、admin 簽署，brain 無法自我 restore。
**verifier 必擴充**：目前無法區分「合法 restore」與「攻擊者刪中段 entries 重連 prevHash」——須把 `RestoreEvent` 設為強制 schema，verifier 偵測到「鏈中 state 跳轉但無對應的、由授權 actor 簽署的 RestoreEvent」即 fail（tamper detection）。
**tamper-evident → tamper-proof**：kernel 私鑰被盜可偽造 RestoreEvent → **P4 把 restore 批准簽章移到 customer-held KMS（外部 signing root）**；P0–P3 期間 restore 僅 tamper-evident，須誠實標註。

## 兩個現實校正（覆驗抓到的 blocking 錯誤）
1. **「rollback 用 ftruncate 把 WORM 截到 N」= 不可行、會毀護城河**：store/outbox 皆 append-only 無 truncate；硬幹撕裂 frame、重啟 torn-tail fail、entryHash 衝突 → 離線 verifier 驗證失敗、append-only 破功。✅ 改 forward-append RestoreEvent + 重建 projection。
2. **OpenShell 的「snapshot」是宣告式 Sandbox CRD，不是記憶體 checkpoint**：已確認 `sandbox_snapshot` 回傳 Sandbox proto（driver.rs:4897），`ffi.rs` 無 CRIU/libkrun memory checkpoint → sandbox **只能 reprovision、丟 in-flight state**，別宣稱毫秒級記憶體還原。

## 最高風險：snapshot 必須 credential-blind
brain memory dump 與 sandbox 狀態可能含學到的明文 credential/API key（Hermes memory export 與 sandbox checkpoint 目前不 redact）。**序列化前必套 `canonical.redactSecrets`（idempotent）；credential 走 runtime broker 重新注入、不從 snapshot 取；snapshot 存 immutable read-only ACL；E2E 須 grep 明文 secret 並 fail-closed。**

## Build list（善用已建，標 capability-gated）
1. **Forensic Replay fold 引擎**（TS ~500 LOC，今天、零 kernel 改動）：`TimelineReducer(events[0..N])` → TaskTimeline，deterministic、clone 狀態、不重跑 tool；RED ＝ 離線重放 vs live timeline hash 比對。
2. **PREVENT-before-commit snapshot + deferred abort**（TS ~200 LOC）：StateSnapshot marker，commitgate.Guard 前可取消，重用 commit_gate.go/outbox.go。
3. **SnapshotRecord schema + 強制驗證**（Zod ~150 LOC）：snapshotId/sequence/wormHeadHash/memoryVersion/ledgerLsn/sandboxRef/externalEffectsSinceBaseline；以 `system.snapshot` append。
4. **Restore orchestration FSM + GLOBAL lock**（TS ~600 LOC）：validate→lock→append RestoreInitiated→重建各 projection（DB txn / PITR / brain import / sandbox reprovision）→replay outbox（CheckDedup 去重）→append RestoreCompleted；每 phase fail-closed。
5. **【kernel 必修】snapshot-safe checkpoint RPC**（Go ~150 LOC）：取代不可行的 ftruncate-to-N。
6. **Brain Port `BrainState{export/import/schema_version}` + Hermes adapter**：解耦 memory snapshot、保 pluggability。
7. **Cost ledger rollback 路徑**（TS/SQL ~200 LOC）：PITR-to-LSN 或 append REVERSAL；ledger invariant（sum(debits)=sum(credits)）fail-closed。
8. **PDP restore 規則 + ApprovalInbox gate**（TS ~150 LOC）：`system.restore` deny-by-default、需 admin、核准前先呈現 DivergenceReport。
9. **verifier 擴充**：辨識/驗證 RestoreEvent，無標記鏈跳轉即 tamper fail。
10. **【capability-gated】** Hermes memory per-sequence 版本化（emit MemoryMutatedEvent）；OpenShell 若日後支援 CRIU/libkrun checkpoint 再接，否則維持 reprovision fallback。
11. **E2E conformance + 對抗測試**（~400 LOC）：credential-blind snapshot（grep 明文 secret fail）、restore atomicity 各 phase crash 復原、outbox 冪等、PITR 有/無 WAL 兩情境。

## Roadmap 落點
- **Forensic Replay → P1.5**（先做；Independent Verifier 的天然延伸；零 kernel 改動）。
- **Internal Live Rollback → P2**（Task/AgentSession FSM + resume ledger + snapshot orchestration + kernel snapshot-safe RPC + Brain memory 版本化）。
- **跨系統一致性 reconciliation / distributed lock → P3**。
- **tamper-proof restore（customer KMS 外部簽署根）→ P4**。

## 風險摘要
credential 洩漏（critical，見上）；草案 ftruncate（blocking，已改 forward-append）；OpenShell 無記憶體 checkpoint（hard，只能 reprovision）；Hermes memory 未版本化（blocking for full brain rollback，P2 補）；snapshot quiesce 非原子（blocking，需 kernel RPC + GLOBAL lock）；跨系統一致性發散（hard，需 provisional hold + 夜間 reconciliation）；verifier 無法辨識惡意截斷（hard-but-solvable，強制 RestoreEvent schema）；Postgres PITR 是營運依賴；DivergenceReport 須核准前呈現；restore 私鑰偽造（P4 KMS）；非 idempotent tool rollback 後一律 abort；snapshot 無自動 GC（須 retention 策略）。
