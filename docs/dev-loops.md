# Agent OS 開發流程：Looping Engineering

> 我們借用 [loops.elorm.xyz](https://loops.elorm.xyz/) 的 looping engineering 方法，作為**開發 Agent OS 自身**的工程流程，用來拉高**開發 → 測試 → 驗收**的品質。完整 loop 研究見 [research/loops.md](./research/loops.md)。

## 核心原則

1. **只信指令輸出**：每個 loop 的 feedback gate 是一條真實指令，只看 exit code / status，**不接受 agent 自述**（呼應 CLAUDE.md「不得宣稱完成除非指令證明」）。
2. **永遠帶 cap**：每個收斂/排程 loop 都有 iteration 上限——cap 是 exit condition 寫錯時的唯一終止 backstop（呼應 CLAUDE.md「卡住 3 次就停下來重新評估」）。
3. **hook 防止、loop/cron 驗證**：deny-by-default 類以 event hook 在當下拒絕；`/loop` 與 cron 是 defense-in-depth 的驗證層。

## 統一 feedback gate

```bash
pnpm run verify   # = typecheck && lint && build && test && secret-scan ；exit 0 才算綠
```

大多數 loop 都用 `pnpm run verify` 當真相來源。

## 四層 loop 體系

### Tier 0 — 事件層（hooks，事前防止）
| 借用的 elorm loop | 用途 | gate | 狀態 |
|---|---|---|---|
| **Pre-Commit Guard** | commit 前必須綠 + secret 掃描，否則 **block commit** | `pnpm run verify` | ✅ 已啟用（`.githooks/pre-commit`） |
| Post-Edit Test Guard | 存檔即跑相關測試（秒級回饋） | `vitest related` | ⏳ 之後 |

### Tier 1 — 收斂層（capped `/loop`，開發中跑到綠）
| 借用的 elorm loop | 用途 | gate | cap |
|---|---|---|---|
| Autoloop TDD（＋ `/tdd`） | 功能內圈 Red→Green→Refactor | `pnpm test` | ~12 |
| Lint+Typecheck Fix → Build → Test Until Green | 改完跑到全綠 | `pnpm run verify` | ~6 |
| **Guardrails Learning Loop** | 同一失敗出現兩次 → 寫進 `docs/guardrails.md`（CLAUDE.md 規則） | 重複失敗偵測 | ~12 |
| Reflexion Debug / Investigation Script（＋ `/investigate`） | 卡關時的除錯內圈 | repro test | ~8 |

### Tier 2 — 驗收層（acceptance gate，獨立驗證）
| 借用的 elorm loop | 用途 | gate |
|---|---|---|
| **Independent Verifier Pass** | **無情境**獨立跑 verify，逐條列 failing check | `pnpm run verify` + coverage |
| PR Self-Review（＋ `/review`） | 合併前自審 diff | `git diff` |
| Codex Review Gate（CLAUDE.md，spec/plan/task/final） | 階段轉換驗收，cap 已內建（5 次停、連 3 次轉策略） | `codex-review.sh` |
| Ship PR Until Green（＋ `/ship`） | CI 綠才出貨 | `gh pr checks` |

### Tier 3 — 持續保證層（cron / `/schedule`，跨 session；有 CI/deploy 後開）
CI Failure Watcher、PR Babysitter、Security/Dependency Audit Weekly、Deploy Verification Loop。

## 對應產品的 8 個 custom security loop
本流程用的是 elorm loop 的**機制**；產品 runtime 的 8 個安全 custom loop（Sandbox Escape Regression、Policy Deny-by-Default…）如何用同一套機制落地，見 [research/loops.md](./research/loops.md) §5–§6。

## 目前狀態
- Tier 0 Pre-Commit Guard、Tier 1 `pnpm run verify` 綠燈圈、Tier 2 Independent Verifier Pass **已在第一個任務啟用**。
- CI / deploy 相關（Ship PR Until Green、Tier 3）待有遠端 repo / 部署目標後開啟。
