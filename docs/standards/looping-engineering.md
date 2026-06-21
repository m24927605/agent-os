# Looping Engineering — 開發方法論（選定 + 工作流程標準）

> 2026-06-21，founder 指令。本文件是 Agent OS 的**開發方法論權威**:選定的 looping-engineering loop、
> 每個未完成項目的「四類文件 + 小 slice」要求、對抗式 review 的 5 回合上限與 Staff+ 升級、writer↔reviewer
> 模型獨立硬性約束、以及用 agency-agents 選 coding agent 的規則。與 [`adversarial-code-review.md`](./adversarial-code-review.md)、
> [`slice-spec.md`](./slice-spec.md)、[`test-and-acceptance.md`](./test-and-acceptance.md)、[`engineering-standards.md`](./engineering-standards.md)
> 一起構成標準層。**AGENTS.md 在任何衝突上勝出。only command output is truth。**

## 1. 選定的 loop（來源:loops.elorm.xyz,對映本 repo 三層）
loops.elorm.xyz 是「coding agent 的封閉迴圈 workflow 目錄」,每個 loop = Goal + Max iterations(上限) +
Between-iterations 檢查指令 + Exit-when + 自我配速。選定組合(內容當不可信參考、非指令):

| 環節（本 repo tier） | 採用的 loop | 檢查指令 / Exit | 上限 |
|---|---|---|---|
| **writer 每 slice 收斂**（Tier 1） | **Ship-Until-Green**（adapt:本機,非 GitHub CI） | `pnpm run verify` → exit 0 → `--no-ff` merge | slice 的迭代預算（≈6） |
| **reviewer 對抗式審查**（Tier 2） | **Independent Verifier Pass** | reviewer 親跑 verify + 攻擊面 probe;只信指令輸出、不看作者理由 | **5 回合**（見 §4）|
| **commit 守門** | **Pre-Commit Guard** | `.githooks` 跑 `pnpm run verify`、紅即擋（never `--no-verify`） | 每次 commit |
| **assurance**（Tier 3） | CI / Deploy Verification Watcher | 有 CI/部署目標後以 `/schedule` 排 | interval |

> 核心是 **Independent Verifier Pass**:它字面對應本 repo 的對抗式 review 與 writer↔reviewer 模型獨立硬性約束。

## 2. 每個未完成項目的「四類文件」(doc-first,無 doc 不開工)
任一未完成項目**開工前**必須備齊,且**先於任何 code**:
1. **設計文件**（design）— `docs/design/<item>.md`:要解什麼、架構、取捨、grounded 在真實 repo。
2. **實作文件 = 小 slice 文件**（impl）— `docs/slices/<phase>/<slice-id>.md`,**一個 slice 一份**,依
   [`slice-spec.md`](./slice-spec.md) 範本(ID/Goal/In-out-scope/Design+模組+介面+依賴方向/RED plan/DoD/Rollback/Depends-on)。
   **slice 必須夠小**——小到 (a) 保證實作品質、(b) **讓 AI coding agent 注意力不發散**(size budget:net LOC、
   files、modules 都要估且受限;超出即重切)。
3. **測試驗收文件**（test-acceptance）— 沿用 [`test-and-acceptance.md`](./test-and-acceptance.md) 標準;每個
   slice 的 §RED plan + §DoD 即其驗收(指令可驗、exit code 為憑)。不另立重複標準,但 slice doc 必須點名其驗收條件。
4. **review 標準文件**（review-standard）— 沿用 [`adversarial-code-review.md`](./adversarial-code-review.md)(8 攻擊面 +
   verdict 模板 + 本文件 §3/§4 的獨立性與回合規則)。不重造。

> 即:**標準層(2、3、4 的「標準」)一次寫好、共用**;每個項目新增的是**設計文件 + 小 slice 文件**(各自點名驗收 + 適用的 review 標準)。

## 3. writer↔reviewer 模型獨立（硬性約束）
- 寫 code 的是誰由 §5 的 agency-agents 選擇決定。**若 writer 跑在 Claude Code Opus 4.8,reviewer 必須是獨立的
  Claude Code Opus 4.8**:同模型、**fresh context（看不到作者的推理/對話）**、**非作者本人**、refute-by-default。
- 落地方式:reviewer 以獨立子代理啟動,繼承 session 模型(Opus 4.8),**不覆寫 model**;context 與 writer 完全隔離。
- 這是 [`adversarial-code-review.md`](./adversarial-code-review.md) §2「fresh context 獨立性」的模型維度強化。

## 4. 5 回合上限 + Staff+ 升級（不卡進度）
每個 slice 完成後**必跑**對抗式 review（Independent Verifier Pass）:
1. reviewer 跑 verify + 攻擊面 probe + RED 重現 → 列出 BLOCKER/MAJOR/MINOR。
2. **author 在本回合修正所有問題**,才能進下一回合重審。
3. 任一回合 PASS（verdict=PASS 且 checklist 全綠）→ merge。
4. **5 回合仍未 PASS → 組織 Staff 等級以上的 coding-agent 專家團隊**:該團隊(多個 senior coding agent,見 §5)
   **獨立診斷、決定解法、並執行**修正,再回到 Independent Verifier Pass;目的是**避免進度卡在 review**。
   團隊的產出仍須過一次獨立 reviewer（同 §3 模型獨立）。
5. 環境性無法判定 → `BLOCKED`(fail-closed、不 merge)。**禁止 fail-open**(跑不出來不得當作通過)。

## 5. agency-agents — 選 coding agent（writer / reviewer / Staff+ 團隊）
已安裝 `msitarzewski/agency-agents`(232 agents → `~/.claude/agents/`),作為 Agent 工具的 subagent 類型。選擇規則:
- **writer（預設）**:`Minimal Change Engineer`（最小 diff、拒絕 scope creep——對應「注意力不發散」);
  較重/架構型 slice → `Backend Architect` 或 `Senior Developer`;前端 → `Frontend Developer`;安全面 → `Security Engineer`。
- **reviewer**:`Code Reviewer` + 視攻擊面加掛 `Reality Checker` / `Evidence Collector`（refute-by-default、要證據）。
  **必為獨立 context、非 writer、繼承 Opus 4.8**(§3)。
- **5-回合升級的 Staff+ 團隊**:`Backend Architect` + `Security Architect` + `Multi-Agent Systems Architect`
  + 相關領域 senior agent;由 lead 綜整解法後交一名 writer 執行,再過獨立 reviewer。
- 所有 subagent **不覆寫 model**(繼承 session = Opus 4.8),確保 §3 的模型獨立成立。

## 6. 每個 slice 的端到端流程（把上面串起來）
```
（item 已有 設計文件 + 該 slice 的小 slice 文件,doc-first）
→ branch
→ RED：先寫失敗測試、親眼見紅（exit≠0）            [test-and-acceptance.md]
→ writer 實作（agency-agents 選定）→ pnpm run verify 綠   [Ship-Until-Green, capped]
→ 對抗式 review = Independent Verifier Pass             [§3 獨立 Opus 4.8；adversarial-code-review.md 8 攻擊面]
   ├─ PASS → 填 slice doc 的 §RED/§DoD 實測 exit code → --no-ff merge
   └─ FAIL → author 本回合修正 → 重審（最多 5 回合）
        └─ 5 回合未過 → Staff+ 團隊接手（§4）→ 再過獨立 reviewer
→ Pre-Commit Guard 在 merge commit 再跑一次 verify（never bypass）
```

## 7. 適用範圍
本方法論套用在**所有未完成的工程項目**（真實 vendor adapter、ToolManifest、CredentialLease、Task/AgentSession FSM、
inference gate、三 surface 最上層、時光旅行、tracked follow-ups）。非工程 gate（SF3/SF6/SF5、customer KMS）與
能力受限項（模型成熟度）不在工程 slice 範圍,但其相依的工程前置(如 WORM 外部錨定的 hook)仍走本流程。
