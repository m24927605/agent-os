# Phase 0 Slices — INDEX

> **狀態（2026-06-19）：Phase 0 全部完成 ✅** — S0.1–S0.7（含後補的 S0.7）皆走完
> branch → **RED test-first** → `pnpm run verify` → **fresh-context 對抗式 code review = PASS** →
> `--no-ff` merge 進 main。S0.6 對抗式 review 抓到一個 deny fail-closed **BLOCKER**（非拋錯的畸形
> deny 規則被靜默跳過），已修正並以「對 pre-fix 紅、對 HEAD 綠」的鎖定測試 + 重審 PASS。
> main 上 `pnpm run verify` 綠（**51 tests** / deps:check / secret-scan）。**未開的 Phase-0 周邊項**：
> verify polyglot 級聯入口、upstream Rust PR（屬 infra/外部，見 §0 與 roadmap §2）。

> **Phase 0 的唯一意圖：延續（extend，**非**rewrite）現有 ~500 行 scaffold，把它推向 P0 substrate。**
> 對應 [architecture-approach.md](../../research/architecture-approach.md) §4「Phase 0（延續 scaffold，非重寫）」與
> [slice-spec.md](../../standards/slice-spec.md) §2 的 P0 範圍。**AGENTS.md 在任何衝突上勝出。**
>
> 鐵律（Looping Engineering，逐 slice 強制）：
> - **只有指令輸出是真相（only command output is truth）** — 任何「綠/通過/done」都必須附**實際指令的 exit code**，不接受 agent 自述。
> - **Test-first TDD** — 每個 slice 先寫 RED 失敗測試，再實作到 GREEN，capped loop（無 unbounded loop）。
> - **Deny-by-default + fail-closed everywhere**；credentials 絕不進 workspace/logs/artifacts/snapshots/traces/fixtures。
> - **HARD CONSTRAINT A（low coupling / high cohesion）** — 由 `pnpm run deps:check` 指令強制（S0.3 落地後），且為對抗式審查的阻斷維度。
> - **HARD CONSTRAINT B（per-slice adversarial code review）** — 每個 slice merge 前必過剛好一次 fresh-context、refute-by-default 的對抗式審查 = PASS（[adversarial-code-review.md](../../standards/adversarial-code-review.md)）。

---

## 0. Phase 0 在做什麼 / 不做什麼

| 做（in-scope of Phase 0） | 不做（留給後續 phase） |
|---|---|
| 完成 OCSF AgentContext 對映於 ids + AuditEvent（S0.1） | Go evidence kernel 的真實 Tessera tile log / RFC-3161 外部錨定 → **P1** |
| AuditEvent canonical serialization + content-addressed hashing（S0.2） | Approval Inbox / Task Timeline / Tool registry / lease lifecycle → **P2** |
| 把 dependency-boundary check 接進 `pnpm run verify`（S0.3，HARD CONSTRAINT A 的指令級執法） | gateway-per-tenant、跨租 conformance → **P3** |
| OpenShell adapter interface（TS）+ fail-closed null adapter + mock contract tests（S0.4） | 真實 connect-node gRPC client、pin image digest、live OpenShell → **P2/P3** |
| evidence-kernel v0 契約：append-only hash-chained signed log interface + verifier skeleton（S0.5） | 真實 Go kernel 進程/獨立身分、跨進程 ingest gRPC → **P1** |
| PDP-layer seed：擴充 `evaluatePolicy`（S0.6） | OPA/Z3 整合、capability algebra、SoD、budget、inference-route gate → **P3/P4/P5** |

> **尚待補的 Phase 0 slice（roadmap §2「待新增 slice」對應，須依 slice-spec 範本補寫進本目錄並更新下方 DAG）：**
> - **S0.7 — F3 TS 邊界 value-scanning redaction filter（enforced）**：現況 `src/audit/redact.ts` 只 by-key
>   redact、**value-scanning 尚未實作**；S0.7 以 RED-first（canary 放進 free-form 欄位 → 期望 scrub）落地。
>   依賴 S0.2（canonical serialize 出口）+ S0.3。對應 `engineering-standards.md` §7.3、`test-and-acceptance.md` §3.2。
> - **verify polyglot 級聯入口** 與 **upstream Rust PR 啟動/追蹤**：infra/governance slice，RED = 失敗的
>   contract/存在性斷言（見 roadmap §2）。

> Phase 0 **全程留在 TS plane**（唯一例外：S0.5 只寫**契約/skeleton**，不寫 Go 真實實作；真實 Go kernel 是 P1）。
> 這刻意符合 architecture-approach.md §4「明確拒絕 Phase 0 重寫進 Go/Rust」——Go 只用於 P1 新建 kernel，不移植 scaffold。

---

## 1. Slice 清單與 DAG

| Slice | Title | Layer（11 層） | Net LOC（估） | Depends-on |
|---|---|---|---|---|
| [S0.1](./S0.1-ocsf-agentcontext.md) | OCSF AgentContext 完成於 ids + AuditEvent | tenant/IAM · audit | ~120 | （無，起點） |
| [S0.2](./S0.2-canonical-serialize-hash.md) | AuditEvent canonical serialization + content-addressed hashing | audit | ~140 | S0.1 |
| [S0.3](./S0.3-deps-boundary-gate.md) | dependency-boundary check 接進 `pnpm run verify` | （build/CI gate，跨全 repo） | ~110（+依賴新增單列） | （無；但**應最先 merge**） |
| [S0.4](./S0.4-openshell-adapter-null.md) | OpenShell adapter interface + fail-closed null adapter + mock contract tests | sandbox adapter | ~170 | S0.1, S0.3 |
| [S0.5](./S0.5-evidence-kernel-v0-contract.md) | evidence-kernel v0 契約：append-only hash-chained signed log interface + verifier skeleton | audit | ~180 | S0.1, S0.2, S0.3 |
| [S0.6](./S0.6-pdp-layer-seed.md) | PDP-layer seed：擴充 `evaluatePolicy`（多 rule 來源 + 第一個 deny-precedence 不變量） | policy | ~150 | S0.3 |

### Slice DAG（無 cycle — slice-spec §9）

依賴以**鄰接表（adjacency list）**表示，一行一條邊「`X -> Y` 讀作 X depends-on Y」（機械可檢，無歧義）：

```
S0.3 -> ()                # deps gate：無依賴；slice-spec §9 硬性「最先 merge」之 blocking 前置
S0.1 -> ()                # 起點契約（ids / AgentContext）；無依賴（建議在 S0.3 後 merge，受 §5 auto-void interim）
S0.2 -> { S0.1, S0.3 }
S0.4 -> { S0.1, S0.3 }
S0.5 -> { S0.1, S0.2, S0.3 }
S0.6 -> { S0.3 }          # 刻意不依賴 S0.1（不消費 AgentContext，保持單一意圖）
```

> **無 cycle 證明（拓撲序存在）：** rank(S0.3)=rank(S0.1)=0；rank(S0.2)=rank(S0.4)=rank(S0.6)=1；
> rank(S0.5)=2。每條邊都從高 rank 指向 ≤ 的 rank（S0.5→{0,1,0}、S0.2→{0,0}…），**無回邊 ⇒ DAG**。
> **排序紀律（slice-spec §9）：** S0.3（deps gate）是**硬性最先 merge** 的 blocking 前置（在它 merge 進
> verify 前，P2+ slice 不得 merge）；契約先於消費者：S0.1 先於 S0.2/S0.4/S0.5。
> 確認 slice DAG 無 cycle：**是**。

---

## 2. 每個 slice 共同遵守的 Definition of Done（逐條指令可證）

每個 slice doc 的 §6 各自展開，但**全部**至少滿足（slice-spec §6 DoD + adversarial-code-review §5 MERGE GATE）：

- [ ] **Test-first 成立**：實作前先有對應 RED 測試，已貼首次紅燈 exit code（≠0）。
- [ ] `pnpm run verify` **exit 0**（typecheck && lint && build && test && **deps:check** && secret-scan；輸出尾段 + exit code 已貼）。
- [ ] **dependency-boundary check 綠**：S0.3 merge 後為 `pnpm run deps:check` exit 0；S0.3 merge 前的 slice（僅 S0.1/S0.3 本身可能在此窗口）以 slice-spec §4 四點**人工證明**並註記「工具尚未落地」為 process note。
- [ ] **low coupling / high cohesion 遵守**：無新增跨 module / cyclic 依賴；觸及 module 僅經 public surface（`src/index.ts` barrel / Zod / 宣告介面）被消費，無 deep import。
- [ ] **secret-scan 乾淨**：`pnpm run secret-scan` 輸出 `secret-scan: clean`；reviewer 自設 canary 後在 6 個 sink（workspace/logs/artifacts/snapshots/traces/fixtures）+ audit payload grep 0 命中。
- [ ] **Docs 更新**（若 behavior/commands/API/policy/config 改變）。
- [ ] **Adversarial code review = PASS**（fresh-context、!= author、refute-by-default；reviewer 親自重跑指令；coupling/cohesion 為阻斷維度）。
- [ ] 屬安全不變量的 slice（S0.1/S0.2/S0.4/S0.5/S0.6 皆是）：**Independent Verifier Pass** 已對抗式探測 deny-by-default / fail-closed / credential non-leak / audit 完整性（依 slice 取用）。

### 2.1 共同規則（適用每份 slice-doc 的 §5/§6，避免逐檔重複）

> 下列規則**一次定義於此、每份 slice-doc 引用**（only-command-output-is-truth 的具體落地）：

1. **EXECUTION-TIME EVIDENCE（執行時填入，非完成宣稱）：** 每份 slice-doc §5/§6 中的指令 transcript
   與 exit code（例如 `$ pnpm run verify … exit code: 0`、`first RED exit code: 1`）**都是樣板佔位，不是
   已達成的結果**。它們**必須**在執行時被**真實輸出覆蓋**；在被真實輸出覆蓋前，**不得**據此宣稱該 slice
   已綠/已 done。讀者請把這些行讀作「此處貼真實輸出」的指示。
2. **First-RED 必須是真實捕獲、且早於實作：** 每份 slice 的「首次紅燈」**必須是作者在寫任何實作前真實跑出
   的 exit≠0 輸出，並 commit**（test-first）。**禁止**在實作存在後補一段看起來像紅燈的文字。adversarial
   reviewer 須經 git history / 親自還原實作重跑（adversarial-code-review.md §3.3 第 4 步）**再確認 RED 為真**。
3. **Per-slice 實作 loop cap（Looping Engineering，無 unbounded loop）：** 每份 slice 的 RED→GREEN→verify
   內圈**有 cap**：若在 **≈6 次**迭代內仍無法 GREEN，**停止、重新評估 slice 邊界（很可能切太大）、必要時
   退回 DRAFT 重切**（呼應 slice-spec §3 與 adversarial-code-review §5 連 3 次失敗重評）。
4. **canary 是「明顯非機密」的 sentinel：** credential-non-leak 用的 canary（如 `CANARY-SECRET-<uuid>`）
   是**刻意構造、明顯非真實憑證**的 sentinel；它**只在記憶體構造、不寫入任何 fixture 檔**。secret-scan 對它
   的共存處置以 `docs/standards/test-and-acceptance.md` §3.2 的綁定機制為準（runtime 組裝 / scanner allowlist
   其一，並記於 `docs/guardrails.md`），確保第 6 sink 的 secret-scan 不因 canary 而誤報、也不漏報真 secret。

---

## 3. 與既有 scaffold 的對齊（不重寫，只延續）

| 既有檔案 | Phase 0 如何延續 | 觸碰它的 slice |
|---|---|---|
| `src/iam/ids.ts`（branded ids） | branded ids **就是** OCSF AgentContext 欄位；補齊聚合型別 + runtime 驗證 | S0.1 |
| `src/audit/event.ts`（`createAuditEvent` fail-closed） | 成為流入 evidence kernel 的 typed domain event；補 OCSF 對映 + canonical 形態 | S0.1, S0.2 |
| `src/audit/serialize.ts` / `redact.ts` | canonical serialization 在 redact 之上建 deterministic 排序；redaction 維持 6-sink 不變量 | S0.2 |
| `src/policy/evaluate.ts`（deny-by-default + fail-closed） | seed PDP layer：擴充多 rule 來源 + deny-precedence，**不弱化** deny-by-default | S0.6 |
| `src/index.ts`（public barrel） | 所有新公共面只經此 barrel 對外，維持「只經 public surface 消費」 | S0.1–S0.6 |
| `package.json` `verify` / `scripts/scan_secrets.sh` / `.githooks/pre-commit` | `verify` 新增 `deps:check` 子關卡；pre-commit guard 不得 `--no-verify` | S0.3 |

> 任何 slice 若需「重寫」既有檔案而非「延續」，即違反 Phase 0 意圖與 AGENTS.md「No broad rewrites」，**退回重切**。
