# Slice 規範（slice-spec）

> 本文件定義 Agent OS 的**最小交付單位：SLICE**，以及每個 slice 必須附帶的 **slice-doc** 範本。
> 本文件是 `AGENTS.md` §「Slice discipline + mandatory adversarial code review」與 §「Low coupling,
> high cohesion」的可執行細則。**AGENTS.md 在任何衝突上勝出。**
>
> 配套文件：`docs/standards/adversarial-code-review.md`（對抗式 code review 的執行細則）、
> `docs/dev-loops.md`（四層 loop 體系）、`docs/research/architecture-approach.md`（Two-Plane Polyglot
> 架構、11 layers、phase sequencing）。
>
> 鐵律重申（Looping Engineering）：**只有指令輸出是真相（only command output is truth）。**
> 任何「完成 / 綠 / 通過」的宣稱都必須附上實際指令的 exit code，**不接受 agent 自述**。

---

## 1. 什麼是 SLICE（定義）

**SLICE = 能端到端獨立 build / test / verify 的最小一致變更（the smallest coherent change that is
independently buildable, testable, and verifiable end-to-end）。**

一個合格的 slice 必須同時滿足：

1. **一致（coherent）** — 對應**單一意圖**（one responsibility）。它要嘛交付一個可觀察的行為增量，
   要嘛完成一次可獨立驗收的重構；不混入無關的順手修改、格式化、或跨關注點的變動。
2. **獨立可建（independently buildable）** — 合併後 repo 能 build；不依賴尚未 merge 的其他 slice 才能編譯。
3. **獨立可測（independently testable）** — 帶有**先寫的 RED 測試**（見 §6），其行為可被測試單獨驗證。
4. **端到端可驗（verifiable end-to-end）** — `pnpm run verify` 在此 slice 上**收斂為 GREEN（exit 0）**。
   「end-to-end」指通過統一 gate 的全部關卡：`typecheck && lint && build && test && secret-scan`，外加
   **dependency-boundary check**（§5）。
5. **尺寸約 ≤ 1 天**（見 §3 尺寸上限）。
6. **合併前通過剛好一次 adversarial code review = PASS**（見 §7、§8 lifecycle）。
   **不得僅憑 self-review 合併。**

> Slice 不是「commit」也不是「PR」的同義詞，而是**驗收單位**：一個 slice 可由多個 commit 組成，
> 但只以**一個** adversarial code review 收尾並以**一個**可審 diff 合併。

### 非 slice（反例，必須拆分或退回）

- 「大重寫」/ 跨多個 layer 同時動刀（違反 AGENTS.md「No broad rewrites」）。
- 引入行為**且**順手格式化無關檔案（混入關注點、汙染 diff）。
- 一個無法被任何指令證明的「文件/想法」變更（無 verifiable gate）。
- 必須等另一個未 merge 的分支才能編譯的半成品（非 independently buildable）。
- 削弱測試或安全檢查以求綠（AGENTS.md 明令禁止；adversarial review 會以此直接 FAIL）。

---

## 2. Slice 與架構 / 層次 / 平面的關係

Agent OS 是 **Two-Plane Polyglot**：TS 治理控制平面、Go evidence kernel、Python agent SDK、TS SDK/CLI/UI；
共 11 layers（CLI/UI · orchestration · approval · tool registry · policy · credential · sandbox adapter ·
inference · audit · persistence · tenant/IAM）。**Slice 在這個結構上有兩條硬規則：**

- **一個 slice 原則上落在單一 plane 的單一 layer。** 跨 plane（TS ↔ Go ↔ Python ↔ UI）只透過**型別化契約**
  （proto / Zod）互動；若一個 slice 必須同時動兩個 plane，它**只能**透過修改共享契約來連接，且契約變更本身
  應是更早的、獨立的 slice（見 §9 排序）。**禁止**為了讓某 slice「跑起來」而 deep-import 另一個 module 的內部。
- **跨 layer 的關注點不得外洩。** 例如 policy 決策邏輯不得滲進 adapter；credential 處置不得滲進 audit payload。
  違反者於 adversarial review 的 coupling/cohesion 維度直接 FAIL（§7）。

### Slice 如何對應到 Phase（`architecture-approach.md` §4 Sequencing）

每個 slice 的 slice-doc **必須宣告它所屬的 Phase**，並只承擔該 phase 的範圍：

| Phase | 範圍（slice 應落在此） | 典型 slice 例 |
|---|---|---|
| **P0** | 延續 scaffold、不重寫；OCSF AgentContext 對映、TS 邊界 redaction filter；把 **dependency-boundary check 接進 `pnpm run verify`**；開出 4 項 upstream Rust PR（inference-gate + Landlock 先行）+ Core-side egress allowlist interim | 「把 `dependency-cruiser` 接進 verify 並設一條 RED 規則」 |
| **P1** | Go evidence kernel：先 simple signed append-only hash chain + standalone verifier；再升 Tessera + RFC-3161 錨定；monotonic per-source sequence + gap detection + transactional outbox | 「kernel 拒絕亂序 sequence 的 ingest（fail-closed）」 |
| **P2** | Personal beachhead（c24）：Approval Inbox / Task Timeline / Artifact / Tool registry / lease lifecycle，串本機單一 OpenShell + SQLite | 「ToolManifest Zod schema + 註冊拒絕缺 required permission」 |
| **P3** | c6 Agent Escrow + c3 Tenant-Sealed Fleet：gateway-per-tenant、release-blocking 跨租 conformance | 「跨租讀取被結構性拒絕並 audited 的 RED 測試」 |
| **P4** | c1 Oversight-of-Record + c4 Maker-Checker：decision-path replay、外部錨定 evidence export、SoD conflict-pair | 「maker≠checker 由 capability 持有性 enforce（非 if-check）」 |
| **P5** | c20 Sub-Delegation Firewall + c10 Blast-Radius Budget + c12 Chinese-Wall | 「capability child⊆parent attenuation 的 property-based 測試」 |

> 規則：**slice 不得超前其 phase 的依賴。** 例如 P2 的 slice 不得內嵌尚未在 P1 完成的 kernel 內部假設；
> 它只能依賴 kernel 已發布的型別化契約。phase 依賴關係在 slice-doc 的「Depends-on / blocks」中明寫（§6.8）。

---

## 3. Slice 尺寸上限（size limits）

尺寸是**硬上限**，不是建議。任一條超標即**必須拆分**：

| 維度 | 上限（soft target → hard cap） | 處置 |
|---|---|---|
| 投入時間 | 約 ≤ 1 個工作日 | 估計 > 1 天 → 拆分 |
| 變更行數（淨，不含 generated / lockfile / snapshot） | ~≤ 300 行 → hard cap 400 | 超過 → 拆分 |
| 觸及檔案數 | ~≤ 8 → hard cap 12 | 超過 → 拆分 |
| 觸及 module（公共面）數 | ~≤ 2 → hard cap 3 | 超過 → 拆分；跨 plane 算多 module |
| 新增第三方依賴 | 0；若必要則**單獨成一個 slice** | 依賴變更不與行為變更同 slice |
| adversarial review 輪數 | 收斂上限 3 輪 | 連續 3 輪仍 FAIL → 停止，視為 slice 過大或設計有誤，回退重切（呼應 CLAUDE.md「卡住 3 次重新評估架構」） |

> 行數/檔案數上限的目的：讓 adversarial reviewer 能在**單次 fresh-context** 內完整把它讀懂並嘗試攻破。
> 讀不完的 diff 不是可被對抗審查的 slice。

---

## 4. 一個 slice 如何宣告並遵守 low-coupling / high-cohesion（HARD CONSTRAINT A）

這是 `AGENTS.md` §「Low coupling, high cohesion」的逐 slice 落地。每個 slice 在 slice-doc §6.4
**必須**完成以下宣告，且這些宣告必須可被指令檢查：

1. **單一責任（high cohesion）：** 用一句話說明本 slice 觸及之每個 module 的**唯一**責任；若一句話講不清，
   表示 cohesion 不足，須重切。
2. **公共面消費（low coupling）：** 列出本 slice 對其他 module 的依賴，且**只能**經其 public surface
   （TS：該 module 的 `index.ts` barrel，如 `src/index.ts` 既有 pattern；跨 plane：proto / Zod 契約）。
   **禁止 deep import 內部檔案**（例如 `import ... from "../policy/internal/x.js"`）。
3. **方向（acyclic, inward-pointing）：** 畫出本 slice 新增/變更的依賴箭頭，證明方向為
   **domain ← application ← adapters**（向內指），且**不形成任何 cycle**。
4. **新依賴證明（若有）：** 任何新增的 module-to-module 或第三方依賴，必須在 slice-doc 明文宣告，
   並證明它（a）不違反 inward 方向、（b）不製造 cycle、（c）有 YAGNI/DRY 之外的正當理由。

### 強制機制（必須過指令，否則非綠）

- **TS 平面：** `dependency-cruiser`（規則禁止 cycle、禁止 deep import 跨 module 內部、強制 inward 方向）；
  亦可用 `eslint-plugin-boundaries` 表達 layer 邊界。P0 的其中一個 slice 就是**把此檢查接進
  `pnpm run verify`**（見 §5）。
- **Python SDK：** `import-linter`（contracts：forbidden / layers），於該 plane 的 CI gate。
- **Go evidence kernel：** `depguard`（golangci-lint）+ Go `internal/` package 機制（內部包無法被外部 import，
  天然封裝 kernel 內部）。
- **跨 plane：** 由「只透過 proto / Zod 契約互動」的結構保證；adapter 是 single chokepoint。

> 「Enforced, not aspirational」：上述檢查的**失敗即 `pnpm run verify` 失敗**（或對應 plane 的 gate 失敗），
> 且 coupling/cohesion 是 adversarial review 的**阻擋性維度**（§7）。

---

## 5. dependency-boundary check 接進統一 gate（P0 必做 slice）

目前 `package.json` 的 `verify` 為：
`typecheck && lint && build && test && secret-scan`。

依 `architecture-approach.md` Phase 0，**必須新增一條 `verify` 子關卡**，例如：

```jsonc
// package.json scripts（目標形態，P0 的一個獨立 slice 完成）
"deps:check": "depcruise src --config .dependency-cruiser.cjs",
"verify": "pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run test && pnpm run deps:check && pnpm run secret-scan"
```

`.dependency-cruiser.cjs` 至少包含 **error 級**規則：

- `no-circular`（禁止任何依賴 cycle）。
- `not-to-internal`（禁止 deep import 另一 module 的內部；只允許其 barrel `index.ts`）。
- `inward-only`（adapters → application → domain，反向即 error）。

> 在這條檢查接上之前（`SLICE-P0-003` merge 前），**每個 slice 仍須在 adversarial review 手動證明**
> §4 的四點（reviewer 須親手追溯 import graph 並貼出追溯指令與結論）。
>
> **RED 證據（命令化，非「相信 reviewer 會手動做」）：** `dependency-cruiser` 是 linter 不是 test runner，
> 因此本 gate slice 的 RED 證據是「**對一個刻意植入的違規 fixture，`pnpm run deps:check` 必須 exit≠0**」：
> 在 `src/` 內暫時加一個製造 cycle / deep-import 的 fixture 檔，跑 `pnpm run deps:check` 貼出 **exit 1**
> （紅燈），再移除 fixture 跑出 **exit 0**（綠燈）。詳見 `docs/slices/phase-0/S0.3-deps-boundary-gate.md` §5。
>
> **自動失效（auto-void）＋封頂（cap）——interim 不得變永久：** 一旦 `SLICE-P0-003` merge，
> §4 / §5 / §6.6 / §10 中所有「手動證明替代」字句**立即自動失效**，`pnpm run deps:check` exit 0 成為
> **每個 DoD 的強制條目**，不再接受人工替代。手動替代期**上限 = 直到 `SLICE-P0-003` merge 為止，且
> `SLICE-P0-003` 是 Phase 0 最先 merge 的 slice（§9 硬性前置）**——也就是 interim 視窗只涵蓋
> 「`SLICE-P0-003` 本身」與「在它之前不得不先 merge 的 slice」，不得跨 phase 延用。

---

## 6. slice-doc 必填章節（規格）

每個 slice 都必須有一份 slice-doc（建議路徑 `docs/slices/<phase>-<id>-<kebab-title>.md`）。
**以下 8 節為必填，缺一不可：**

### (1) ID + Title
- 格式：`SLICE-<PHASE>-<NNN>`（例：`SLICE-P0-003`），加一行簡短 title。
- 與 git branch 對齊（例：`slice/p0-003-deps-boundary-gate`）。

### (2) Goal（一句話）
- 一句、可驗收的意圖。若需要「以及」連接多個目標 → slice 過大，拆分。

### (3) In-scope / Out-of-scope
- **In-scope：** 本 slice 明確要做的最小集合。
- **Out-of-scope：** 明確**不做**的相鄰事項（含「留給哪個後續 slice」），避免範圍蔓延。

### (4) Design delta + modules + public interface + dependency direction
本節同時履行 **HARD CONSTRAINT A**（§4），必須包含：
- **Design delta：** 對現狀的最小變更描述（行為差、契約差、狀態機差）。
- **Modules touched + 唯一責任：** 每個 module 一句 responsibility（high cohesion 自證）。
- **PUBLIC interface：** 列出本 slice 新增/變更的**對外公共面**（TS 函式/型別簽章、Zod schema、proto RPC）。
  內部實作不列入公共面。
- **Dependency direction：** 依賴箭頭圖（文字即可），證明 inward-pointing + acyclic；
  列出每一個新依賴並逐一證明（§4.4）。

### (5) Test-first plan（先寫的 RED 測試）
- 先寫、**會失敗**的測試清單，每條對應一個可觀察行為或不變量。
- 安全相關 slice **必須**含對抗式 RED：deny-by-default、fail-closed、credential 不外洩、audit 完整性、
  跨租隔離（依 slice 性質取用）。
- 指出測試檔位置與執行指令（例：`pnpm test src/policy/evaluate.test.ts`），並貼上**首次紅燈的 exit code**。

### (6) Definition of Done（DoD checklist）
本節為**逐條可勾、且每條附指令證據**。最少包含：

- [ ] **Test-first 成立**：實作前先有對應 RED 測試（附首次紅燈輸出）。
- [ ] `pnpm run verify` **exit 0**（貼上結尾與 exit code；只有指令輸出是真相）。
- [ ] **dependency-boundary check 綠**（`pnpm run deps:check` exit 0；P0 前以 §4 手動證明替代並註記）。
- [ ] **low coupling / high cohesion 遵守**：無新增跨 module / cyclic 依賴；觸及 module 僅經 public surface 被使用。
- [ ] **secret-scan 乾淨**：任何 source/log/artifact/fixture/snapshot/trace **無** secret-like 值。
- [ ] **Docs 更新**（若 behavior/commands/API/policy/config 改變）。
- [ ] **Adversarial code review = PASS**（fresh-context reviewer 嘗試攻破、findings 已解；附 review 結論連結/摘要）。
- [ ] 屬於安全不變量的 slice：**Independent Verifier Pass** 已執行（adversarially probed deny-by-default /
  fail-closed / audit 完整性 / credential non-leak / 跨租隔離）。
  > **消歧（與 dev-loops Tier 2 對齊，避免兩套驗收被讀成矛盾）：** Independent Verifier Pass 是**安全不變量
  > 類 slice** 的額外驗收層。**非安全 slice 的 Tier-2 acceptance 僅經 §7 的 adversarial code review 達成**
  > （reviewer 親跑指令 + 八面探測），不另跑 Independent Verifier Pass——兩者不重複、不矛盾：對安全 slice 兩者
  > 皆需，對非安全 slice 只需 adversarial review。

### (7) Rollback
- 一鍵回退方式（`git revert <merge>` 或關閉 feature flag）。
- 回退是否安全可逆？若 slice 含**外部副作用 / 資料遷移 / 不可逆 audit append**，須說明補償或 forward-fix 策略
  （audit kernel 為 append-only，回退靠 forward-correcting event，不得改寫歷史）。

### (8) Depends-on / blocks
- **Depends-on：** 必須先 merge 的 slice / 契約 / phase 前置（明寫 SLICE id）。
- **Blocks：** 哪些後續 slice 等待本 slice。
- 確認 depends-on 不形成 slice 之間的 cycle（slice DAG）。

---

## 7. Slice lifecycle（RED → GREEN → verify → adversarial review → merge）

每個 slice 走**固定生命週期**；每個轉換的 gate 都是一條真實指令（HARD CONSTRAINT B 在「review」階段強制）：

```
  ┌─────────┐   RED 測試先行   ┌─────────┐   實作到通過    ┌──────────────┐
  │  DRAFT  │ ───────────────▶ │   RED   │ ──────────────▶ │    GREEN     │
  │ slice-  │  (測試 FAIL，貼   │ (測試紅，│  (對應測試轉綠)  │ (該 slice 測試 │
  │  doc    │   出 exit≠0)     │  尚無實作)│                 │   全綠)       │
  └─────────┘                  └─────────┘                 └──────┬───────┘
                                                                  │ pnpm run verify
                                                                  ▼
                                                          ┌───────────────┐
                                                          │    VERIFY     │
                                                          │ exit 0（含     │
                                                          │ deps:check）   │
                                                          └──────┬────────┘
                                                                 │ 通過
                                                                 ▼
                                                  ┌──────────────────────────┐  FAIL（≤3 輪）
                                                  │  ADVERSARIAL CODE REVIEW  │ ─────────────┐
                                                  │  fresh-context、職責是攻破 │              │
                                                  │  含 coupling/cohesion 維度 │ ◀────────────┘
                                                  └──────────┬───────────────┘  修正後回 VERIFY
                                                             │ PASS
                                                             ▼
                                                       ┌──────────┐
                                                       │  MERGE   │ 可審 diff、coherent commit
                                                       └──────────┘
```

階段定義與 gate：

1. **DRAFT** — 寫 slice-doc（§6 八節）。gate：八節齊備、尺寸在 §3 上限內、depends-on 不成 cycle。
   > **誠實揭露（only-command-output-is-truth 的張力）：** 這三項 DRAFT 閘門目前**由人判**，沒有單一
   > 指令背書。本規範採以下處置，使其不成為「自述即過」的漏洞：
   > - **路由進 adversarial review 作為具名阻斷維度：** 「slice-doc 八節是否齊備、尺寸是否逾 §3 硬上限、
   >   slice DAG 是否成 cycle」三項，是 `docs/standards/adversarial-code-review.md` §4.7（low coupling /
   >   high cohesion）與 §4.8（claimed behavior）下的**阻斷性檢查**——reviewer 必須逐項確認，缺項或超尺寸
   >   即 FAIL，不得 merge。
   > - **可選的機器化（建議，落地後升級）：** 可在 P0 後新增一個 `slice-doc:lint` script（assert 八個
   >   必填標題存在、size-budget front-matter 在上限內），掛進 verify / pre-commit，把人判降為指令判。
   >   在此 script 落地前，上述「路由進 review」是 binding 的替代。
2. **RED** — 先寫測試並**確認失敗**。gate：對應測試 exit ≠ 0（貼出）。**禁止**先寫實作。
3. **GREEN** — 最小實作令 RED 測試轉綠。gate：對應測試 exit 0。
4. **VERIFY** — 跑統一 gate。gate：`pnpm run verify` exit 0（含 `deps:check`、`secret-scan`）。
   失敗 → 用 Tier 1 「Lint+Typecheck→Build→Test Until Green」收斂 loop（cap ~6）。
5. **ADVERSARIAL CODE REVIEW** — **fresh-context reviewer**，職責是**攻破**本 slice
   （見 `docs/standards/adversarial-code-review.md`）。gate：**review = PASS**。
   - **此 gate 不可由 self-review 取代**（HARD CONSTRAINT B）。
   - reviewer 必須獨立**重跑** `pnpm run verify` 並對抗式探測安全不變量；coupling/cohesion 是阻擋維度。
   - FAIL → 回 GREEN/VERIFY 修正後重審；收斂上限 3 輪，超出視為 slice 過大 → 回 DRAFT 重切。
6. **MERGE** — 只在前述全綠後合併；diff 可審、commit coherent、不含 generated junk / secret / 無關格式化。
   合併走 Pre-Commit Guard（`.githooks/pre-commit` 跑 `pnpm run verify`，**不得 `--no-verify`**）。

> Looping 對齊（`docs/dev-loops.md`）：RED→GREEN 是 Tier 1 Autoloop TDD；VERIFY 是統一 gate；
> ADVERSARIAL REVIEW 是 Tier 2 Acceptance（Independent Verifier Pass 的對抗式延伸）；
> Pre-Commit Guard 是 Tier 0 prevention。

---

## 8. 與 adversarial code review 的關係（HARD CONSTRAINT B）

- **每個 slice 合併前必過剛好一次 adversarial code review = PASS。** 細則見
  `docs/standards/adversarial-code-review.md`。本文件只規定：review 是 lifecycle 的**強制 gate**，
  且其阻擋性維度**至少**包含：
  1. **安全不變量**：deny-by-default、fail-closed、credential non-leak、audit 完整性、跨租隔離（依 slice 取用）。
  2. **Low coupling / high cohesion**（§4）：cycle、deep import、方向錯誤、關注點外洩任一出現即 FAIL。
  3. **Test-first 真實性**：RED 測試確實先行且能抓到回歸（reviewer 可暫時破壞實作驗證測試會紅）。
  4. **只有指令輸出是真相**：reviewer 親自重跑指令，不採信作者自述。
- reviewer 必須是 **fresh context**（不得是寫該 slice 的同一上下文）。

---

## 9. Slice 排序（slice DAG 與 phase 依賴）

- 全部 slice 構成一張 **DAG**（無 cycle）；每個 slice 的 §6.8 宣告 depends-on/blocks。
- **契約先於消費者：** 跨 plane 的型別化契約（proto / Zod schema）變更應拆成**獨立、較早**的 slice，
  其下游消費者 slice 才能 depends-on 它。避免「為了讓 A 跑而 deep-import B 內部」。
- **不得超前 phase 依賴**（§2）：例如 P2 slice 不得依賴尚未在 P1 完成的 kernel 內部。
- **P0 的閘門 slice（硬性 blocking 前置，非建議）：** 「把 dependency-boundary check 接進
  `pnpm run verify`」（`SLICE-P0-003`）是 slice DAG 中的**硬性前置邊**：
  - 它**必須是 Phase 0 最先 merge 的 slice**；
  - **在它 merge 進 verify 之前，任何 P2 及之後（P2+）的 slice 一律不得 merge。** 這把「coupling 由指令
    證明」從「應該很前面」升級為**可被 DAG 強制的 blocking depends-on**，避免 only-command-output-is-truth
    對 coupling 的保證被跨 phase 默默延後。
  - 唯一允許在 `SLICE-P0-003` 之前 merge 的，僅限 Phase 0 內「契約先於消費者」不得不先行的少數 slice
    （例如 `SLICE-P0-001`），且這些 slice 須以 §4 手動證明替代並註記（interim，受 §5 auto-void 封頂）。

---

## 10. 可複製的 slice-doc 範本（FILL-IN TEMPLATE）

> 複製以下整段到 `docs/slices/<phase>-<id>-<kebab-title>.md`，逐欄填寫。**保留英文技術術語。**
> 任何「綠 / 通過」欄位都**必須**貼上實際指令輸出與 exit code（only command output is truth）。

```markdown
# SLICE-<PHASE>-<NNN>: <一句話 title>

- **Phase**: P<n>（對應 architecture-approach.md §4）
- **Branch**: slice/<phase>-<nnn>-<kebab-title>
- **Author**: <id>    **Adversarial reviewer**: <須為 fresh-context、非作者>
- **Size budget**: 估計 <= 1 day；預期 net LOC <~300、files <~8、modules <~2

## (1) ID + Title
SLICE-<PHASE>-<NNN> — <title>

## (2) Goal（一句話）
<單一、可驗收的意圖。出現「以及」就拆分。>

## (3) In-scope / Out-of-scope
- In-scope:
  - <最小要做的事 1>
- Out-of-scope（明確不做，註記留給哪個後續 slice）:
  - <相鄰但不做的事> → 留給 SLICE-<...>

## (4) Design delta + modules + public interface + dependency direction
- **Design delta**: <對現狀的最小變更：行為/契約/狀態機差異>
- **Modules touched（每個一句唯一責任，high cohesion 自證）**:
  - `<path/module>` — <single responsibility>
- **PUBLIC interface（新增/變更的對外公共面；內部實作不列）**:
  - `<TS 簽章 / Zod schema / proto RPC>`
- **Dependency direction（low coupling 自證；HARD CONSTRAINT A）**:
  - 箭頭圖（向內、無 cycle）:
    ```
    adapters ──▶ application ──▶ domain
    ```
  - 僅經 public surface 消費（無 deep import）: ☐ 是
  - 新依賴宣告（逐一證明 inward + acyclic + justified；無則填「無」）:
    - <dep>: 方向=<...>、cycle=<無>、理由=<...>

## (5) Test-first plan（先寫的 RED 測試）
- 測試檔: `<path>.test.ts`
- RED 測試清單（每條對應一個行為/不變量）:
  - [ ] <test 1：期望 ... >
  - [ ] 安全對抗式（依需取用）: deny-by-default / fail-closed / credential non-leak / audit 完整性 / 跨租隔離
- 首次紅燈證據（貼 exit≠0）:
  ```
  $ pnpm test <path>.test.ts
  ... FAIL ...
  exit code: 1
  ```

## (6) Definition of Done（每條附指令證據）
- [ ] Test-first 成立（首次 RED 已貼於 §5）
- [ ] `pnpm run verify` exit 0
  ```
  $ pnpm run verify
  ... exit code: 0
  ```
- [ ] dependency-boundary check 綠（`pnpm run deps:check` exit 0；P0 前以 §4 手動證明並註記）
- [ ] low coupling / high cohesion 遵守（無新跨 module / cyclic 依賴；僅 public surface 消費）
- [ ] secret-scan 乾淨（source/log/artifact/fixture/snapshot/trace 無 secret-like 值）
- [ ] Docs 更新（若 behavior/commands/API/policy/config 改變）
- [ ] Adversarial code review = PASS（fresh-context；findings 已解）— 連結/摘要: <...>
- [ ] （安全不變量類 slice）Independent Verifier Pass 已執行並 clean

## (7) Rollback
- 回退方式: `git revert <merge-sha>` / disable flag `<...>`
- 可逆性: <安全可逆 / 含外部副作用或 audit append → forward-fix 策略：...>

## (8) Depends-on / blocks
- Depends-on: SLICE-<...>（契約/前置）
- Blocks: SLICE-<...>
- 確認 slice DAG 無 cycle: ☐ 是
```

---

## 11. 速查清單（合併前最後一眼）

- [ ] 單一意圖、尺寸在 §3 上限內。
- [ ] RED 測試先行並有首次紅燈證據。
- [ ] `pnpm run verify` exit 0（含 deps:check、secret-scan），輸出已貼。
- [ ] §4 四點（cohesion / public-surface / inward-acyclic / 新依賴證明）成立。
- [ ] Adversarial code review = PASS（fresh-context，非作者；coupling/cohesion 為阻擋維度）。
- [ ] slice-doc 八節齊備；Rollback 與 Depends-on/blocks 已填。
- [ ] 無 secret、無 generated junk、無無關格式化；commit coherent、diff 可審。
- [ ] 未 `--no-verify`、未削弱任何測試或安全檢查。
