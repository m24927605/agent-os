# loops.elorm.xyz 研究：Loop 範本庫對 Agent OS 的對應與採用建議

> 研究目的：評估 [loops.elorm.xyz](https://loops.elorm.xyz/) 這個 closed-loop workflow 範本庫，並把它的 loop pattern 對應到我們建立在 NVIDIA OpenShell 之上的 Agent OS（Personal Agent Workstation + Enterprise Agent Runtime Platform），尤其是對應到我們已定義的 8 個 custom loop 與 Claude Code 的 `/loop` / hook / cron 三種觸發機制。
>
> 文件語言：繁體中文（保留英文技術術語）。撰寫者：Staff+ synthesizer。

---

## 1. 摘要

**一句話：** loops.elorm.xyz 是一個給 coding agent 用的「closed-loop workflow 範本庫」，把每個重複性 agent 活動拆成 `trigger → feedback gate（指令輸出即真相）→ exit condition → iteration cap` 的 4 段契約；它對我們最大的價值不是現成的 CI/test loop，而是這套**「用可機讀的指令輸出當唯一真相、永遠帶 iteration cap、絕不相信 agent 自述」的 loop anatomy**——這正好是 Agent OS 把 8 個 security custom loop 落地成可驗證、deny-by-default、有界、idempotent 機制的骨架。

**重點：**

- 範本庫共列舉 **40 個 loop**，橫跨 15 個分類（API / Automation / CI / Database / Debugging / DevOps / Docs / Git / Maintenance / Performance / Planning / Quality / Review / Security / Testing）。經抽樣驗證的 5 個 loop（Ship PR Until Green、Pre-Commit Guard、Post-Edit Test Guard、Independent Verifier Pass、CI Failure Watcher）其 name/category/trigger/exit 與我所拿到的 enumeration 完全一致（見第 3、8 節驗證註記）。
- 這 40 個 loop 全部屬於**一般軟體工程**用途（測試、CI、依賴、文件、deploy），**沒有任何一個是針對 sandbox 安全、租戶隔離、credential 注入、policy enforcement 設計的**。因此對 Agent OS 而言，**值得套用的是「機制（mechanism）」，不是現成的安全 loop**。
- 三個結構性 pattern 最值得直接借用：
  1. **Independent Verifier Pass**（只信指令輸出、不信實作宣稱、max 8 iterations）→ 直接映射我們的 #1/#2/#3/#7/#8 convergence loop。
  2. **Pre-Commit Guard / Post-Edit Test Guard**（event-based gate，失敗即 block）→ 直接映射 deny-by-default 與 credential 阻擋的**「事前防止」**那一半。
  3. **CI Failure Watcher / Deploy Verification Loop**（interval/scheduled，輪詢外部已收斂狀態）→ 直接映射 #6 Tenant Isolation 與 deploy/health 的**「持續保證」**那一半。
- 對應到 Claude Code 機制：**convergence loop → 帶 cap 的 self-paced `/loop`**；**enforcement gate → hooks**；**continuous-assurance → cron/`schedule`**。同一個安全不變量常常會在「hook 防止 + loop/cron 驗證」兩個機制裡各出現一次，這是刻意的 defense-in-depth，不是重複。
- **與 CLAUDE.md 的紅線完全相容**：elorm 模型的「每個 interval/self-paced loop 都帶 max iteration count」正是 CLAUDE.md「不要無界背景迴圈」的具體實作；它的「state 活在世界裡、每輪用 gate 指令重新讀取、不信 agent 自述」正是 CLAUDE.md「task execution idempotent」與「不得宣稱完成除非指令證明」的具體實作。

---

## 2. loops.elorm.xyz 是什麼

loops.elorm.xyz 是一個**「closed-loop workflow 範本庫」**，目標讀者是使用 prompt-based coding agent 的開發者（站上反覆標示 target tools 為 **Cursor、Claude Code、Codex**，以及 general/prompt-based coding agents）。

它的核心抽象是：**一個「loop」不是程式語言裡的控制流（control-flow construct），而是一份契約（contract）**——介於「觸發」「驗證閘門」「終止規則」三者之間，中間由 agent 提供判斷力。每個 loop 範本都以同一個 4 段格式描述：

1. **Trigger** — 什麼啟動一次 iteration（manual kickoff / event-based hook / interval schedule）。
2. **Feedback gate**（站上寫成「Between iterations run: …」）— 一個**輸出即為下一步決策唯一真相**的指令，例如 `gh pr checks`、`npm test`、`npm run build && npm run lint`、`gh run list … --limit 1`、`curl -fsS <health-url>`。閘門是**確定性、可機讀的**（exit code / status 字串），**絕非 agent 的自我評估**。
3. **Exit condition**（「Exit when: …」）— 一個離散、可觀測的成功狀態，例如「all PR checks are success」「tests exit 0」「latest run conclusion is success」。
4. **Self-pacing logic + iteration cap** — agent 讀閘門輸出，只在 exit condition 未達成時才繼續；**每個 loop 都帶一個 max iteration 上限（常見 3 / 4 / 5 / 6 / 8 / 10 / 12 / 15 / 20）**，所以 by construction 是有界的。

每個範本頁面通常附有：分類標籤、一段 kickoff prompt（可貼進 agent）、target tools、以及給 Cursor（`.cursor/loops/`、`.cursor/hooks.json`）/ Claude Code（`.claude/` install files）的安裝/下載連結。換句話說，這個站把「怎麼讓 agent 反覆做一件事直到通過驗證」標準化成可複製貼上的配方。

**對我們的判讀：** 這個站的價值是它把「agent 的迭代行為」收斂成一個可審計、可終止、以外部指令為真相的 schema。Agent OS 不該照抄它的 40 個工程 loop，而該**把它的 4 段 schema 當成我們 8 個 security custom loop 的書寫與落地範本**。

---

## 3. 完整 loop 目錄（40 個 enumerated loop）

來源欄一律為 `https://loops.elorm.xyz/loops/<slug>`，以下省略前綴只列 slug。Trigger 欄標註 pacing 類型：`Manual`（self-paced）/ `Event`（hook）/ `Interval`（scheduled）。

| # | Name | Category | Trigger（pacing） | Feedback gate（between iterations） | Exit condition（含 cap） | Target tools / 來源 slug |
|---|------|----------|-------------------|-------------------------------------|--------------------------|--------------------------|
| 1 | Ship PR Until Green | CI | Manual | `gh pr checks` | all PR checks success（max 10）✅驗證 | Cursor/Claude Code/Codex; gh — `ship-pr-until-green` |
| 2 | Pre-Commit Guard | Testing | Event（commit intent on file_edit） | test suite output；失敗 block commit | tests exit 0 before each commit ✅驗證 | Cursor/Claude Code（`.cursor/hooks.json`/`.claude/`）— `pre-commit-guard` |
| 3 | Post-Edit Test Guard | Testing | Event（file_edit） | `npm test -- --findRelatedTests <files>` | related tests exit 0 ✅驗證 | Cursor/Claude Code — `post-edit-test-guard` |
| 4 | Independent Verifier Pass | Testing | Manual | 只看指令輸出，列出每個 failing check + 路徑 | all verifier commands exit 0（max 8）✅驗證 | Cursor/Claude Code; 任何 prompt agent — `independent-verifier-pass` |
| 5 | CI Failure Watcher | CI | Interval（5m） | `gh run list --branch $(git branch --show-current) --limit 1` | latest run conclusion success ✅驗證 | Claude Code/Cursor/Codex; gh — `ci-failure-watcher` |
| 6 | Deploy Verification Loop | DevOps | Interval（15m） | `curl` health endpoint → status code + body | all health endpoints success | Cursor/Claude Code/Codex; curl — `deploy-verification-loop` |
| 7 | Guardrails Learning Loop | Automation | Manual | `npm test && npm run lint`；把重複失敗 append 到 `.ralph/guardrails.md` | all checks pass 或 max 12 | Cursor/Claude Code/Codex — `guardrails-learning-loop` |
| 8 | Post-Merge Regression Guard | Testing | Event（git_merge/rebase） | `npm run test:smoke` | smoke suite exit 0 | Cursor（/loop）/Claude Code — `post-merge-regression-guard` |
| 9 | npm Audit Fix Loop | Security | Manual | `npm audit --audit-level=high && npm test` | no high/critical（max 10） | Cursor/Claude Code; npm — `npm-audit-fix-loop` |
| 10 | Docs Sync After Edits | Maintenance | Manual | `git diff main...HEAD --name-only` | affected docs 全部更新驗證（max 3） | Cursor（/loop）/Claude Code — `docs-sync-after-edits` |
| 11 | API Contract Until Match | API | Manual | `npm run test:contract`（列出每個 endpoint/field mismatch） | contract suite exit 0（max 10） | Cursor/Claude Code/Codex — `api-contract-until-match` |
| 12 | Fix CI Until Green | CI | Manual | `gh run list … --limit 1 --json conclusion` | latest run success（max 8） | gh; Cursor/Claude Code/Codex — `fix-ci-until-green` |
| 13 | Dependency Audit Weekly | Maintenance | Interval（7d） | `npm outdated \|\| true` | summary 含建議升級已貼出 | Claude Code/Cursor — `dependency-audit-weekly` |
| 14 | Flaky Test Triage | Testing | Manual | test 輸出；跨多輪記錄 pass/fail pattern | 每個 failure 分類完成、真 regression 修或明確 defer | Cursor/Claude Code — `flaky-test-triage` |
| 15 | De-Sloppify Pass | Quality | Manual | `npm run lint && npm test` | 無 slop 且 checks pass（max 4） | Claude Code/Cursor — `de-sloppify-pass` |
| 16 | Knip Until Clean | Maintenance | Manual | `npx knip` | knip exit 0（max 5） | Knip/Depcheck; Cursor/Claude Code — `knip-until-clean` |
| 17 | Coverage Until Threshold | Testing | Manual（self-paced） | coverage check 指令 | coverage 達標且 tests exit 0 | Cursor/Claude Code — `coverage-until-threshold` |
| 18 | Reflexion Debug Loop | Debugging | Manual | `npm test -- --testNamePattern=<test>`；reflection 寫進 `.loops/reflexion.md` | repro test exit 0（max 8） | Cursor/Claude Code — `reflexion-debug-loop` |
| 19 | Autoloop TDD | Testing | Manual（self-paced） | `npm test` | target behavior 覆蓋且全綠（max 12） | Cursor/Claude Code — `autoloop-tdd` |
| 20 | Dependency Upgrade One-by-One | Maintenance | Manual | `npm outdated && npm test && npm run build` | 無關鍵 outdated 或 user stop（max 15） | Cursor/Claude Code; npm — `dependency-upgrade-one-by-one` |
| 21 | Ralph Story Executor | Automation | Manual | `npm test && npm run lint && npm run build`；讀寫 `.ralph/prd.json`、`.ralph/progress.md` | 無 `passes:false` 的 story（max 20） | Cursor/Claude Code/Codex — `ralph-story-executor` |
| 22 | Investigation Script Loop | Debugging | Manual | 讀 probe script 的 stdout/stderr 調整假設 | script 輸出證明 root cause（max 8） | Cursor/Claude Code/Codex — `investigation-script-loop` |
| 23 | Changelog Sync After Ship | Maintenance | Manual | `git log -5 --oneline` | changelog 涵蓋所有使用者可見變更（max 3） | Cursor/Claude Code — `changelog-sync-after-ship` |
| 24 | OpenAPI Sync Until Valid | API | Manual | `npx @redocly/cli lint openapi.yaml` | lint exit 0（max 8） | @redocly/cli 或 swagger-cli — `openapi-sync-until-valid` |
| 25 | Staging Smoke Test | DevOps | Manual | `npm run smoke:staging` | smoke exit 0（max 6） | Cursor/Claude Code/Codex — `staging-smoke-test` |
| 26 | PR Watch Loop | CI | Interval（15m） | `gh pr list --label codex-watch --json …` | 每個 watched PR 都有 status report | gh; Cursor/Claude Code/Codex — `pr-watch-loop` |
| 27 | A11y Audit Until Clean | Quality | Manual | a11y check（結構化列出 selector violations） | a11y exit 0、0 serious（max 8） | Cursor/Claude Code — `a11y-audit-until-clean` |
| 28 | PR Babysitter | CI | Interval（15m） | `gh pr list --label codex-watch` + `gh pr checks` | 每個 PR 綠且 current，或 escalate | gh; Cursor/Claude Code/Codex — `pr-babysitter` |
| 29 | Migration Until Applied | Database | Manual | `npx prisma migrate status` | 無 pending failure（max 6） | Prisma; Cursor/Claude Code/Codex — `migration-until-applied` |
| 30 | Format Until Clean | Testing | Manual | `npm run format && git diff --quiet` | formatter 乾淨、無剩餘 diff（max 5） | Prettier/Biome; Cursor/Claude Code — `format-until-clean` |
| 31 | E2E Until Green | Testing | Manual（self-paced） | E2E check 指令 | E2E exit 0（max 10） | Cursor/Claude Code — `e2e-until-green` |
| 32 | Security Audit Weekly | Maintenance | Interval（7d） | `npm audit --json` | summary 含優先修復已貼出 | Cursor/Claude Code; npm — `security-audit-weekly` |
| 33 | Build Until Green | Testing | Manual（self-paced） | `npm run build` | build exit 0（max 10） | Cursor/Claude Code/Codex — `build-until-green` |
| 34 | Lint and Typecheck Fix | Testing | Manual | `npm run lint && npx tsc --noEmit` | 兩者 exit 0 | Cursor/Claude Code — `lint-typecheck-fix` |
| 35 | Spec-First Ship | Planning | Manual | `npm test`（對照 `spec.md` checklist） | spec.md 無未勾選需求（max 15） | Cursor/Claude Code/Codex — `spec-first-ship` |
| 36 | Merge Conflict Resolver | Git | Manual（self-paced） | rebase + check 指令 | rebase 完成且 tests exit 0（max 8） | Cursor/Claude Code — `merge-conflict-resolver` |
| 37 | Test Until Green | Testing | Manual | `npm test` | tests exit 0（max 10） | Cursor/Claude Code — `test-until-green` |
| 38 | PR Self-Review | Quality | Manual | `git diff main...HEAD` | 三輪審查無 critical finding | Cursor/Claude Code/Codex — `pr-self-review` |
| 39 | Visual Regression Until Match | Testing | Manual | 視覺回歸測試輸出（列出差異截圖/元件） | visual tests exit 0 | Playwright/Percy; Cursor/Claude Code — `visual-regression-until-match` |
| 40 | Bundle Size Budget | Performance | Manual | `npm run build && npm run size-limit` | size-limit exit 0（max 6） | Cursor（/loop）/Claude Code/Codex — `bundle-size-budget` |

**驗證註記：** 第 1、2、3、4、5 列（標 ✅驗證）已逐項對照其來源頁面確認 name/category/trigger/exit 一致。**其餘 35 個 loop 的欄位來自提供給我的 enumeration JSON，未經逐頁瀏覽器驗證**；它們彼此格式一致、且與已驗證的 5 個同構，可信度高，但若要對外引用，建議再抽樣複查（特別是各 loop 的 max iteration 數字）。enumeration 宣稱 `totalFound: 40`、`unreachable: []`，與上表 40 列吻合。

---

## 4. Loop 分類學與機制（anatomy）

### 4.1 一般 anatomy：trigger → work → feedback → exit

```
            ┌──────────────────────────── iteration cap（硬上限，security backstop）
            ▼
  [trigger] ──► (agent work：讀 gate 輸出 → 修 → 動作)
                         │
                         ▼
                 [feedback gate]  ← 指令輸出 = 唯一真相（exit code / status）
                         │
              exit 未達成 ┘ 繼續（pacing 決定何時「再來一次」）
              exit 達成   ─► 終止
```

關鍵洞見：**「再來一次」由誰決定**，決定了這是哪一種 loop。

### 4.2 Pacing taxonomy（核心區分）

| Pacing | 由誰決定「再來一次」 | 節奏 | 終止 | 對應 Claude Code 機制 |
|---|---|---|---|---|
| **Self-paced（manual）** | agent，讀完 gate 輸出後 | 工作完成即進下一輪 | exit 達成 **或** cap 達到 | `/loop`（不帶 interval） |
| **Scheduled / interval** | 外部時鐘 | 固定（`5m`/`15m`/`7d`） | exit 達成 **或** cap 達到 | `/loop 5m`、cron/`schedule` |
| **Event-driven** | 外部動作（commit/edit/merge） | 事件發生時 | 事件 handler exit 0/非0（gate 即決定 allow/deny） | hooks |

**最深的一點：self-paced 與 interval 是「同一個 loop body、不同的喚醒來源」；event-driven 在結構上不同**——它是「每事件單發一次的 gate」，不是「repeat-until」。event loop 的「迴圈」只在「事件會重複發生」這個意義上成立；每次觸發只跑一次 gate、回傳 allow/deny。**這對 Agent OS 至關重要**，因為 deny-by-default 與 idempotency 在三種機制裡的行為不同（見第 7 節）。

### 4.3 把 elorm 40 loop 歸到四個機制桶

- **manual / self-paced（多數）**：#1 #4 #7 #9–#11 #14–#25 #29–#31 #33–#40 — 收斂型「run until green」。
- **event-hook**：#2 Pre-Commit Guard、#3 Post-Edit Test Guard、#8 Post-Merge Regression Guard — 在動作發生當下 gate。
- **interval / scheduled**：#5 CI Failure Watcher（5m）、#6 Deploy Verification（15m）、#13 Dependency Audit（7d）、#26 PR Watch（15m）、#28 PR Babysitter（15m）、#32 Security Audit（7d）。
- **verification（橫切性質，非獨立桶）**：#4 Independent Verifier Pass 是「只信指令輸出」的純化代表，這個性質其實貫穿所有 loop 的 feedback gate。
- **其他（state/resilience 性質）**：#7 Guardrails Learning、#18 Reflexion Debug、#21 Ralph Story Executor — 會把跨輪 state 落到檔案（`.ralph/`、`.loops/`），讓 resume / 不重犯錯成為可能；這對應到我們的 #5 Task Resume Idempotency。

---

## 5. 對應關係表（核心交付）

把「相關的 elorm loop pattern」對應到 (a) 我們用哪個 Claude Code 機制實作 → (b) 對應 Agent OS 8 個 custom loop 之一（或新增）→ (c) 適用的 Agent OS layer / OpenShell 元件。

> 安全 loop 的「典型」實作往往同時用兩個機制：**hook 防止（prevention）+ loop/cron 驗證（assurance）**，這是刻意的 defense-in-depth。下表「機制」欄標出**主**機制與**輔**機制。

| elorm pattern（來源） | (a) 我們的機制 | (b) 對應 Agent OS custom loop | (c) Agent OS layer / OpenShell 元件 |
|---|---|---|---|
| **Independent Verifier Pass** #4（只信指令輸出，max 8） | 主：capped self-paced `/loop` | **#1 Sandbox Escape Regression** — gate = `pytest tests/sandbox_escape/`，exit = 所有 escape 被拒且被 audit；輔：cron 夜跑回歸 | Sandbox runtime adapter layer（OpenShell sandbox/mount/proxy 控制）+ Audit/event log layer |
| **Independent Verifier Pass** #4 + **Pre-Commit Guard** #2 | 主：hook（pre-action gate，預設 deny）；輔：capped `/loop`（policy test 套件） | **#2 Policy Deny-by-Default** — gate 斷言未知 file/net/process/inference/credential 請求回傳 `deny` + 寫出 `PolicyDecision` log；exit = exit 0 | Policy engine layer（OpenShell policy/seccomp/network egress 控制）+ Audit |
| **Pre-Commit Guard** #2（失敗 block commit）+ **Independent Verifier Pass** #4 | 主：git **pre-commit hook**（secret scanner，非0 即 block）；輔：capped `/loop` scanner；再輔：cron fleet sweep | **#3 Credential Non-Leak** — hook 在「寫入前」攔截；loop 在 session 中偵測修復；cron 跨 fleet 掃已落地的洩漏 | Credential provider layer（CredentialBundle 注入機制）+ Persistence + Audit |
| **Pre-Commit Guard** #2（pre-action gate） | 主：hook on 任何 privileged `ToolInvocation`（side-effect ≠ read-only 或 resource 未知） | **#4 Approval UX Consistency** — hook 的 gate 輸出 = 該動作是否映射到一個格式完整的 `ApprovalRequest`（含 actor/task/resource/requested action/risk summary/policy reason/expiration+scope）；不完整即 deny | Approval workflow layer + Tool registry layer（ToolManifest/ToolInvocation） |
| **Guardrails Learning Loop** #7 / **Reflexion Debug** #18 / **Ralph Story Executor** #21（跨輪 state、resume、不重犯錯） | 主：capped self-paced `/loop`，state 落檔（等同 `.ralph/progress.md`） | **#5 Task Resume Idempotency** — resume 時重讀 gate（世界的當前狀態）而非重播過去 iteration；以 `request_id` 去重 side-effect | Task orchestration layer + Persistence layer（Task/AgentSession 狀態） |
| **CI Failure Watcher** #5 / **Deploy Verification Loop** #6（interval 輪詢外部收斂狀態） | 主：**cron / `schedule`**（夜跑，跨 session 存活）；輔：`/loop 15m`（互動期間） | **#6 Tenant Isolation** — 跨租戶 probe 套件（tenant A 嘗試讀 B 的 task/cred/sandbox/policy/artifact），exit/alert = 所有跨租戶嘗試被拒且被 audit | Enterprise tenant/IAM layer + Gateway/control plane（OpenShell 多租戶隔離邊界） |
| **Independent Verifier Pass** #4（schema 驗證型 gate） | 主：capped self-paced `/loop`；輔：cron hourly sampler | **#7 Audit Completeness** — gate = schema-validate `AuditEvent`（actor_id/tenant_id/project_id/task_id/sandbox_id/action/resource/policy_decision/timestamp/request_id/result）；exit = all events valid | Audit/event log layer + Persistence layer |
| **API Contract Until Match** #11 / **OpenAPI Sync Until Valid** #24（schema/contract 驗證直到通過） | 主：capped self-paced `/loop` | **#8 Tool Registry Contract** — gate = `validate_tool_manifests`：每個 `ToolManifest` 須有 name/version/input+output schema/required permissions/side-effect class/timeout/audit behavior/docs；exit = all valid | Tool registry layer |
| **Deploy Verification Loop** #6（health endpoint 輪詢） | 主：cron / `schedule`；輔：`/loop 15m` | **新增建議：#9 Deployment Verification Loop**（enterprise mode 部署驗證；非現有 8 loop） | Gateway/control plane + Sandbox lifecycle（OpenShell runtime 健康檢查） |
| **Sandbox lifecycle 事件**（無單一 elorm 範本，最接近 Post-Merge Regression Guard #8 的 event 模型） | 主：hook on create/start/stop/resume/destroy | **跨 #1/#7**：每個 lifecycle 事件須 emit `AuditEvent`，hook 是 auditable 的 choke point | Sandbox runtime adapter layer（OpenShell lifecycle API）+ Audit |
| **Security Audit Weekly** #32 / **npm Audit Fix Loop** #9（依賴弱點） | 主：cron（7d）；輔：capped `/loop` 修復 | **新增建議：#10 Supply-Chain / Dependency Posture Loop**（補充性，非安全不變量核心） | Persistence/build pipeline（非核心 layer，屬 platform 維運） |

**判讀要點：** deny-by-default 不變量（#2/#3/#4）的**主機制必須是 hook**——輪詢（loop/cron）只能事後偵測違規，唯有 event hook 能在動作發生當下**拒絕**。把 deny-by-default 只放在 loop 或 cron 是不安全的；loop/cron 是 defense-in-depth 的驗證/保證層。

---

## 6. 推薦採用清單（優先級 / 理由 / layer / 與 OpenShell 關係）

> 優先級原則：先做能直接證明安全不變量、且實作成本最低、能被指令客觀驗證的 loop。

### P0（必做，安全骨架）

1. **#3 Credential Non-Leak** — 主：**pre-commit hook**（secret/canary scanner，非0 block）+ 輔：capped `/loop` scanner。
   - 理由：credential 洩漏是 critical failure；hook 是唯一能「寫入前阻擋」的機制，且 elorm 的 Pre-Commit Guard 是現成同構範本，落地成本最低。掃描器報告**只回 match 位置與計數，絕不回 secret 值**（否則 loop 自己變成洩漏源）。
   - Layer：Credential provider + Persistence + Audit。
   - OpenShell 關係：掃描範圍涵蓋 OpenShell sandbox 的 workspace FS、snapshot、artifact 輸出與 trace。

2. **#2 Policy Deny-by-Default** — 主：**hook**（pre-action gate，無法肯定 allow 即 deny）+ 輔：capped `/loop` policy test 套件。
   - 理由：這是整個 Agent OS 的根不變量（unknown file/net/process/inference/credential 一律 deny）。
   - Layer：Policy engine。OpenShell 關係：對應 OpenShell 的 seccomp / mount / network egress / inference route 控制點，hook 在這些控制點前 gate。

3. **#7 Audit Completeness** — 主：capped self-paced `/loop`（schema 驗證 `AuditEvent`）。
   - 理由：所有其他 loop 的「被 audit」exit condition 都依賴 AuditEvent 的 shape 正確；這是先決條件，且 schema 驗證是最乾淨的「run until green」。
   - Layer：Audit/event log + Persistence。OpenShell 關係：lifecycle 事件（create/start/stop/resume/destroy）皆需產生合格 AuditEvent。

### P1（次做，補齊 enforcement 與 contract）

4. **#1 Sandbox Escape Regression** — 主：capped `/loop`（`pytest tests/sandbox_escape/`）+ 輔：cron 夜跑。
   - 理由：直接對應 OpenShell 的核心賣點（secure sandbox）；驗證 agent 無法讀 host 檔、存取未授權 mount、繞過 proxy、觸及被封內網位址。Layer：Sandbox runtime adapter。

5. **#4 Approval UX Consistency** — 主：hook on privileged `ToolInvocation`。
   - 理由：privileged 動作必須映射到格式完整的 `ApprovalRequest`；對 Personal Workstation 的 approval inbox 是必要前置。Layer：Approval workflow + Tool registry。

6. **#8 Tool Registry Contract** — 主：capped `/loop`（`validate_tool_manifests`），借用 API Contract Until Match #11 模型。
   - 理由：每個工具 manifest 完整性可純 schema 驗證，成本低、價值高。Layer：Tool registry。

### P2（enterprise mode 與持續保證）

7. **#6 Tenant Isolation** — 主：**cron / `schedule`**（跨租戶 probe 夜跑）+ 輔：`/loop 15m`。
   - 理由：跨租戶存取是 critical failure，但屬 enterprise multi-tenant 才有的面向；cron 優於 `/loop` 因為它跨 session 存活、屬控制平面的持續檢查。Layer：Enterprise tenant/IAM + Gateway/control plane。

8. **#5 Task Resume Idempotency** — 主：capped `/loop`，state 落檔（借 Ralph/Reflexion 模型）。
   - 理由：重要但較複雜；待 #2/#3/#7 穩定後再做。Layer：Task orchestration + Persistence。

9. **#9（新增）Deployment Verification** — 主：cron + 輔 `/loop 15m`，借 Deploy Verification Loop #6。
   - 理由：對應 enterprise「deployment verification」需求；非現有 8 loop，標示為我們自己的提案。Layer：Gateway/control plane。

**與 OpenShell 的總體關係：** elorm 的 loop 是**通用 agent 行為層**；OpenShell 提供**強制點（enforcement points）**：sandbox 隔離、mount/網路 egress、lifecycle API。我們的 hook 掛在 OpenShell 的強制點上做 deny-by-default，我們的 `/loop` 與 cron 用 OpenShell 暴露的測試/probe 介面當 feedback gate 來驗證這些強制點仍然有效。**loops 提供節奏，OpenShell 提供權限邊界。**

---

## 7. 反樣式 / 安全注意事項（對照 CLAUDE.md）

| 風險 | elorm 模型怎麼避免 | Agent OS 必須加碼的約束（對照 CLAUDE.md） |
|---|---|---|
| **Unbounded background loop**（CLAUDE.md：「不要無界背景迴圈」） | **每個 interval/self-paced loop 都帶 max iteration count**；站上從不出貨無 cap 的 self-paced loop。 | self-paced `/loop` **必須帶 cap**——cap 是若 exit condition 寫錯時的唯一終止 backstop，因此是**安全控制而非可選項**。cron 不可自我重排程（no self-rescheduling runaway）；每次 run 內仍有 per-run cap。event hook 天生有界（每事件一次），其風險不是無界而是「慢/阻塞的 gate 卡住 agent」。 |
| **Deny-by-default 被放錯位置** | 模型本身不談安全；這是我們要補的。 | deny-by-default 必須以 **hook（prevention）為主**，`/loop`（convergence test）與 cron（assurance）為輔。輪詢只能事後偵測，hook 才能當下拒絕。hook 在無法肯定 allow 時的預設輸出 = **非0（deny）**。對應 CLAUDE.md「unknown file/network/process/inference/credential access denied by default」。 |
| **Credential 洩漏**（CLAUDE.md：credentials 絕不寫入 sandbox FS/log/artifact/snapshot/test fixture/trace） | 無對應（工程 loop 不處理）。 | 三機制各有不同強度：hook=寫入前阻擋（最強）、`/loop`=session 中偵測修復、cron=跨 fleet 掃已落地洩漏。**任何 loop 自己產生的 log/artifact 只能記 match 位置與計數，永不記 secret 值**，否則 loop 變成洩漏源。掃描須涵蓋 logs/artifacts/snapshots/workspace files/test fixtures/traces 全部六處。 |
| **非 idempotent / resume 重複 side-effect**（CLAUDE.md：「make task execution idempotent」） | 模型的核心：**state 活在世界裡、每輪用 gate 指令重新讀取、agent 從不信任自己過去的宣稱**；Ralph/Reflexion 把 state 落檔。 | self-paced/interval `/loop` 的 resume 必須**重讀 gate（外部當前狀態）**而非重播過去 iteration——gate 指令是 idempotent 的真相來源。hook 必須 idempotent（事件會 retry）。cron sweep 必須以 `request_id` / content hash 去重，避免重複寫 AuditEvent 或重複告警。對應 CLAUDE.md「resumed task 不重複外部寫入、不丟失 audit history」。 |
| **相信 agent 自述當成功**（CLAUDE.md：「不得宣稱完成除非指令證明」） | Independent Verifier Pass #4 明定「no self-reporting, only command output counts」。 | 所有 exit condition 必須綁定**真實指令的 exit code / status**，絕不接受 agent narration 當通過。 |
| **Allow-all 網路 / 過寬 policy**（CLAUDE.md：「不要 allow-all 網路 policy」） | 無對應。 | feedback gate 與 hook 都不得為了讓 loop「轉綠」而放寬 policy（CLAUDE.md：「不得為通過測試而悄悄削弱安全檢查」）。policy 變更若由 agent 產生，須走 review/approval（對應 #4 Approval loop）。 |
| **Scheduled run 在無人值守時放大風險** | 無對應。 | cron 的輸出通道（alert/audit）本身必須 tenant-scoped 且 credential-free；無人值守正是洩漏或跨租戶讀取最易被忽略的時刻。 |

---

## 8. 建議的最小第一步

**先落地 #3 Credential Non-Leak，採 Pre-Commit Guard（hook）形態，外加一個 capped self-paced `/loop` 掃描器作為輔助。**

**為什麼是這個：**
- 它是 elorm 現成、已驗證的同構範本（Pre-Commit Guard，trigger/exit 已確認），落地成本最低。
- 它直接守住 CLAUDE.md 最高優先的不變量（credential 絕不落地），且**「寫入前阻擋」只有 hook 做得到**，能立刻展示 deny-by-default 的事前防止能力。
- 它的 feedback gate 是純指令、可機讀（scanner exit code），完美符合「只信指令輸出」原則，且天生有界（每 commit 一次）。

**最小實作切面：**
1. 種一組 **canary secret 值**（測試用假密鑰，標記為 test fixture 但**值不入版控**）。
2. 寫 `scripts/scan_secrets.sh`：grep canary 值掃過 workspace files / logs / artifacts / snapshots / traces；命中即 exit 非0，**只輸出檔案路徑 + 命中次數，絕不輸出命中的值**。
3. 掛成 git pre-commit hook（非0 即 block commit），並提供一個 kickoff prompt 讓 capped `/loop`（cap ~6）在 session 中偵測並修復既有洩漏。
4. 同時寫 `tests/test_credential_non_leak.py`：斷言（a）種入 canary 時 scanner 命中且 exit 非0，（b）乾淨樹時 exit 0，（c）scanner 自身輸出**不含** canary 值（防止 loop 變洩漏源）。

**怎麼驗證（exit condition）：**
- `bash scripts/scan_secrets.sh` 在乾淨樹 exit 0；在故意種入 canary 的樹 exit 非0。
- `pytest tests/test_credential_non_leak.py` 全綠。
- 故意 `git commit` 一個含 canary 的檔案，確認 pre-commit hook **阻擋**該 commit。
- `grep` hook 的輸出/log，確認**不含** canary 值（Credential Non-Leak Loop 自身的 exit condition：no secret values printed or persisted）。
- 因為這是新空 repo（目前 `/Users/sin-chengchen/products/agent-os` 僅有 `docs/research/`，無原始碼、無 package manifest、無測試框架），第一步需**先初始化最小專案骨架**（選定語言/測試框架）才能讓上述指令可執行；在那之前，所有 gate 指令尚無法運行，這是目前唯一的 blocker，需如實標註。

---

## 附錄 A：未驗證 / 開放事項

- 本文第 3 節 40 個 loop 中，僅 #1–#5 經來源頁面逐項確認；其餘 35 個欄位來自 enumeration JSON，**未逐頁瀏覽器驗證**（尤其各 loop 的 max iteration 數字與精確指令字串）。
- loops.elorm.xyz **沒有任何安全/sandbox/租戶/credential 專用 loop**；本文第 5、6 節中 #1–#8 對 Agent custom loop 的「實作配方」屬**我方提案（借 elorm 機制 + OpenShell 強制點）**，非 elorm 站上既有範本。#9 Deployment Verification、#10 Supply-Chain 明確標為新增提案。
- Claude Code `/loop` 是否支援帶 interval（`/loop 5m`）與 cron/`schedule` 的精確語義，需依本環境實際機制再確認；本文採「self-paced=不帶 interval 的 `/loop`、scheduled=cron/`schedule`、event=hooks」的對應假設。
- 目前 repo 為空骨架，無法執行任何 feedback gate 指令；第 8 節的最小第一步需先初始化專案骨架方可驗證。
