# Design — Developer SDK（R9）

> 2026-06-21。本文件是 **ITEM R9**（見 [`docs/slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) 第 R9 列）的權威設計，
> doc-first：本設計 + 其下五個小 slice spec 齊備並通過一次文件對抗式 review 後才開工。
> 方法論見 [`docs/standards/looping-engineering.md`](../standards/looping-engineering.md)、slice 紀律見
> [`docs/standards/slice-spec.md`](../standards/slice-spec.md)、測試/驗收見 [`docs/standards/test-and-acceptance.md`](../standards/test-and-acceptance.md)。
> **AGENTS.md 在任何衝突上勝出。only command output is truth。**

---

## 1. What / Why（要做什麼、為什麼）

### 1.1 問題
Agent OS 的三 surface 中，**Developer surface 目前是「假的」**：[`docs/design/five-piece-integration.md:48`](./five-piece-integration.md) 已誠實列出開發者面「仍要建：ToolManifest registry、contract-test harness、dependency-cruiser 反向規則、發布 Port 介面 + FakeAdapters 當 SDK、verifier CLI 當 release artifact」。
[`docs/design/three-surface-architecture.md:68`](./three-surface-architecture.md) 把開發者面定義為：**Python credential-blind shim（import-linter 禁帶 secret 的 import）+ TS SDK；作者宣告 Zod ToolManifest 並發布簽章、版本化的技能/工具；寫一次部署到任何 Agent OS instance，走同一條 PDP→lease→commit-before-effect→sandbox 路徑——開發者永不碰 secret、永不繞過治理**。

具體缺口（verified-from-code）：
- **沒有 Python plane**：`scripts/verify-py.sh` 目前對 `python/` 缺席走 skip（exit 0），但一旦目錄存在卻 **gate 未配置（缺 `pyproject.toml` / ruff）→ FAIL（exit 1）**（[`scripts/verify-py.sh:11-27`](../../scripts/verify-py.sh)）。也就是：**新增 Python shim 的同一刀必須同時把 gate 配起來，否則 `pnpm run verify` 立刻紅**。這直接決定了 S1 的尺寸與 DoD。
- **沒有 SDK barrel**：`src/index.ts` 是 **core** 的 public surface（[`src/index.ts:9-26`](../../src/index.ts)），它 export 了 policy/audit/runtime 等**內部治理型別**。把它直接當 SDK 發給開發者會洩漏過多內部面、且無法獨立版本化。需要一個**收斂、最小、面向作者**的 SDK barrel。
- **沒有 CLI**：作者今天無法用一條命令 lint / 驗證自己寫的 ToolManifest，也無法本地離線驗證一條 evidence chain。
- **verifier 只能用 Go source 跑**：`kernel/cmd/verifier/main.go` 是 standalone binary（[`kernel/cmd/verifier/main.go:1-23`](../../kernel/cmd/verifier/main.go)），但**尚未**作為**版本化 release artifact**（含跨平台 binary + WASM）發布給「不信 operator」的稽核者。

### 1.2 目標
交付 **governance-native 的 Developer SDK**，讓第三方作者：
1. 用 **Python credential-blind shim** 包裝既有 agent 邏輯，且 **import-linter 結構性禁止任何「會持有明文 secret」的 import**（fail-closed：違規即 gate 紅）。
2. 用 **TS SDK**（一個獨立、最小的 author-facing barrel + `Fake* ` adapters）在本機作者契約，**不 deep-import core 內部**。
3. 用 **CLI** 一條命令 lint/驗證自己的 ToolManifest（消費 R3 的 `parseToolManifest`）。
4. 用 **ToolManifest authoring** 流程（範本 + 驗證 + lint command）把工具宣告成 R3 的 Zod-strict 契約。
5. 取得 **standalone + WASM verifier release artifact**：把既有 `cmd/verifier` 升級為**版本化、可重現、跨平台**的 release 產物（含瀏覽器可跑的 WASM），讓稽核者在**任何環境**離線驗鏈。

### 1.3 為什麼 credential-blind 要靠 import-linter（grounded）
真實 vendor 把 secret **落地在 client 端**，正是 Agent OS 結構上要拒絕的：
- **Hermes** 把 profile / skill / 憑證寫進 `~/.hermes`（[`/tmp/hermes-agent-probe/hermes_constants.py:115,250-255`](file:///tmp/hermes-agent-probe/hermes_constants.py)）——這是 client-held credential 的事實證據。[`docs/design/five-piece-integration.md:29`](./five-piece-integration.md) 已鎖死「**拒絕** Hermes 自管 `~/.hermes`」。
- **SpendGuard** 是 client-held-key（L0-L2）模型，被我們移進 inference.local 只見注入後 header（[`docs/design/five-piece-integration.md:23,29`](./five-piece-integration.md)）。
- Agent OS 的 brain 邊界已用 `screenBrainEvent` 做**執行期**的 credential-blind 防線（[`src/runtime/brain/credential-guard.ts:32-40`](../../src/runtime/brain/credential-guard.ts)）——但那是 runtime 的最後一道。SDK 要再加一道**結構性、編譯/lint 期**的防線：shim 的程式碼**根本不能 import** 任何「會去碰 secret store / 寫憑證檔 / 直接打 model provider」的模組。

工具選擇是 grounded 的：**AGT 自己就用 `import-linter>=2.0`**（[`/tmp/agent-governance-toolkit/agent-governance-python/agent-os/pyproject.toml:41`](file:///tmp/agent-governance-toolkit/agent-governance-python/agent-os/pyproject.toml)），且 slice-spec 已指定 Python plane 用 import-linter contracts（[`docs/standards/slice-spec.md:116`](../standards/slice-spec.md)）。我們用 import-linter 的 **forbidden contract** 表達「shim → secret-bearing modules 禁止」，與 TS 的 `no-vendor-in-core`、Go 的 `depguard` 對齊成同一條可插拔/credential-blind 法則。

### 1.4 為什麼 verifier 要當 release artifact（grounded）
`cmd/verifier` 的設計目的就是「**稽核者信這顆小 binary 而非信我們的平台**」（[`kernel/cmd/verifier/main.go:1-5`](../../kernel/cmd/verifier/main.go)）：它只依賴 `internal/verify` + `internal/chain`、fail-closed（鏈不完全驗證就**絕不** exit 0）。但「source-only」對外部稽核者不夠——他們要的是**版本化、可重現、可在瀏覽器/離線環境跑**的產物。[`docs/design/three-surface-architecture.md:77`](./three-surface-architecture.md)（P4）與 [`five-piece-integration.md:48`](./five-piece-integration.md) 都把「WASM 離線 verifier / verifier CLI 當 release artifact」列為開發者面交付。本 ITEM 交付**可重現 build + 跨平台 + WASM** 的 release 流程，但**不**改 verifier 的信任語意（公鑰仍由稽核者提供，pinning/外部 root 是 P4，見 §5 gate）。

---

## 2. Architecture（架構）

### 2.1 五個 slice 與資料流
```
 作者寫 Python agent 邏輯                作者寫工具宣告              稽核者離線驗鏈
        │                                    │                          │
        ▼ (S1)                               ▼ (S4)                     ▼ (S5)
 python/agentos_shim/  ──import-linter──▶  ToolManifest 範本+lint  ─▶  verifier release
 (credential-blind:                         │  (消費 R3                   (standalone binary
  forbidden import                          │   parseToolManifest)        + WASM，版本化、
  secret-bearing mods)                      │                             可重現 build)
        │                                    │
        └──────────────┬─────────────────────┘
                       ▼ (S3 CLI: `agentos manifest lint` / `agentos verify`)
                       │ 消費 ▼
              TS SDK author barrel (S2)
              src/sdk/index.ts —— 只 re-export「作者需要的」最小面
              （ToolManifest 型別/parse、Port 介面、Fake* adapters）
              不 deep-import core 內部；經既有 barrel
```

### 2.2 每個 slice 的責任邊界
- **S1 — Python credential-blind shim（含 verify:py gate 配置）**
  - 新建 `python/` plane：`pyproject.toml`（ruff + import-linter）、`python/agentos_shim/`（最小 shim：把 agent 提案的 plan/tool-call 以 **bundleRef-only** 結構 emit，**不**碰 secret）、`.importlinter` forbidden contract。
  - **唯一責任**：在 Python plane 上把 credential-blind 變成 **import-time 結構性不變量**（shim package 禁 import `os.environ` 直取 secret、禁 import 任何寫憑證檔 / 直打 provider 的模組）。
  - **配置 `verify:py` gate**：因為 `scripts/verify-py.sh:18-27` 要求 plane 存在即須 `pyproject.toml` + ruff，否則 FAIL。本 slice 必須把 gate 配到綠，並**新增 import-linter 執行**到 Python gate（見 S1 DoD）。
- **S2 — TS SDK（author-facing barrel + Fake adapters 匯出）**
  - 新建 `src/sdk/index.ts`：**只** re-export 作者需要的最小公共面：R3 `ToolManifest`/`parseToolManifest`/`ToolSideEffect`、**四個有 `index.ts` barrel 的 Port 介面型別（Brain/CostGate/AgentHosting/Substrate）**、既有 `Fake*` adapters（皆**經各 module `index.ts` barrel**，**非** deep-import `fakes.ts`/`in-memory.ts`）。
  - **dependency-cruiser 硬約束**：`.dependency-cruiser.cjs` 的 `not-to-internal` 只允許跨 module 經 `src/<module>/index.ts` barrel；`src/sdk/` 受此規則約束。故（a）**Policy 不納入**（`src/policy/` 無 barrel，且為評估器非作者面 Port）；（b）R3 須先提供 `src/tools/index.ts` barrel（R3-S1 目前只經 root `src/index.ts` 對外）——見 S2 slice §8；（c）`src/sdk/index.ts` 單向不回指 root，避免 `no-circular`。
  - **唯一責任**：提供「寫一次、契約一次」的作者面，**收斂**而非洩漏 core 內部（不 export policy 評估內部、不 export audit kernel 內部）。只經既有 barrel re-export，無 deep import。
- **S3 — CLI（`agentos` 薄包裝）**
  - 新建 `src/cli/`：一個薄的 commander-free（用 Node 內建 `process.argv` 解析，零新依賴）CLI，兩個子命令：`agentos manifest lint <file>`（讀 JSON → `parseToolManifest` → exit 0/1）、`agentos verify --chain <f> --pubkey <f>`（spawn release verifier，relay exit code）。
  - **唯一責任**：把 R3 parse + verifier 暴露成**命令列、exit-code 化**的作者/稽核者入口。fail-closed：未知子命令/缺參數 → 非 0 退出。
- **S4 — ToolManifest authoring**
  - 新建 `docs/sdk/tool-manifest-authoring.md` + `src/sdk/templates/tool-manifest.example.json`（範本）+ 把 `manifest lint` 的「一致性護欄」說明文件化。**不新增 schema 邏輯**（schema 是 R3 的 S1）。
  - **唯一責任**：作者體驗——一個可複製的 9 欄範本 + 文件化的 lint 流程；驗收靠 S3 的 `manifest lint` 對範本 exit 0、對刻意違規 fixture exit 1。
- **S5 — standalone + WASM verifier release artifact**
  - 新建 `scripts/build-verifier-release.sh`（GOOS/GOARCH matrix 跨平台 build + `GOOS=js GOARCH=wasm` build + SHA-256SUMS + 版本嵌入），與一個 `kernel/cmd/verifier` 的 WASM entrypoint wrapper（若需要；verifier 邏輯**不改**，只加 build 流程與最小 wasm glue）。
  - **唯一責任**：把既有 `cmd/verifier`（[`kernel/cmd/verifier/main.go`](../../kernel/cmd/verifier/main.go)）變成**版本化、可重現、跨平台 + WASM** 的 release 產物。**不改信任語意**（pubkey 仍由稽核者提供）。

### 2.3 與既有 core 的關係（不破壞已建不變量）
- **SDK 是 core 的下游消費者，不是新權威**：S2 SDK barrel 只 **re-export** 既有 public surface（經 `src/index.ts` pattern），不新增任何 deny/allow/append 能力。PDP 仍是唯一 deny 權威（[`five-piece-integration.md:7`](./five-piece-integration.md)），SDK 不能繞過。
- **verifier 信任語意不變**：S5 只改 build/打包，verifier 仍 fail-closed、仍依賴稽核者提供的 Ed25519 pubkey（[`kernel/cmd/verifier/main.go:35-38,64-70`](../../kernel/cmd/verifier/main.go)）；pubkey pinning / 外部 root 明確留 P4（§5 gate）。
- **credential-blind 雙層**：runtime 層已有 `screenBrainEvent`（[`credential-guard.ts:32`](../../src/runtime/brain/credential-guard.ts)）；S1 加的是 **lint/import 期**的結構層——兩層互補、不重複（一個擋執行期 payload、一個擋編譯期 import）。

---

## 3. Reuse vs New（重用既有 vs 新建）

### 3.1 重用（已建 / 已 merge）
- **R3 ToolManifest**：`parseToolManifest` / `ToolManifest` schema（S3/S4 直接消費，**不重造 schema**）。
- **四個有 `index.ts` barrel 的 Port 介面 + Fakes**：`src/runtime/brain/index.ts`、`src/cost/index.ts`、`src/hosting/index.ts`、`src/runtime/substrate/index.ts`（S2 SDK 只經 barrel re-export）。**Policy 排除**（`src/policy/` 無 `index.ts`，且為評估器非作者面 Port）。
- **既有 barrel pattern**：`src/index.ts:9-26`（root 聚合面，dependency-cruiser 唯一豁免點；S2 sdk barrel 比照但**單向不回指 root**，且只經各 module `index.ts`）。**注意**：R3 的 `ToolManifest` 目前僅經 root `src/index.ts` 對外、無 `src/tools/index.ts`——S2 須先讓 R3 補該 module barrel（見 S2 §8）。
- **standalone verifier**：`kernel/cmd/verifier/main.go`（S5 只加 build/WASM，不改邏輯）；其依賴 `internal/verify.VerifyChain`（[`kernel/internal/verify/verify.go:27`](../../kernel/internal/verify/verify.go)）不動。
- **verify cascade gates**：`scripts/verify-py.sh`（S1 配置它）、`scripts/verify-go.sh`（S5 的 build 不破壞它）。
- **credential-blind 律 + runtime guard**：`screenBrainEvent`（S1 對齊其語意，但落在 import 期）。
- **import-linter 工具**：AGT 已驗證的 `import-linter>=2.0`（[AGT pyproject.toml:41](file:///tmp/agent-governance-toolkit/agent-governance-python/agent-os/pyproject.toml)）作參考。

### 3.2 新建
- `python/`（plane）+ `pyproject.toml` + `.importlinter` + `python/agentos_shim/`（S1）。
- `src/sdk/index.ts`（S2）。
- `src/cli/`（S3）。
- `docs/sdk/tool-manifest-authoring.md` + `src/sdk/templates/tool-manifest.example.json`（S4）。
- `scripts/build-verifier-release.sh` + 最小 WASM wrapper（S5）。

### 3.3 不做（明確 out-of-scope，留給後續 ITEM）
- 真實 Hermes brain shim（credential-blind over Brain Port，跑真模型）→ **R11 vendor-adapters**（INDEX.md R11）。本 R9 的 Python shim 只是 **credential-blind 結構骨架 + import-linter gate**，不接真 Hermes。
- 把 SDK 發到 npm/PyPI 的 publish pipeline（registry、簽章發布）→ 後續發布 ITEM。
- ToolManifest 的密碼學簽章 / provenance（簽章技能）→ 後續（依賴 WORM/外部錨定）。
- verifier pubkey pinning / 外部化 root（客戶 KMS/HSM）→ **P4**（[three-surface-architecture.md:77](./three-surface-architecture.md)）。
- CLI 的互動式 scaffold / TUI → 後續；本 ITEM CLI 只做 lint + verify 兩個 exit-code 化命令。

---

## 4. Trade-offs（取捨）

| 決策 | 取捨 | 理由 |
|---|---|---|
| SDK 用**獨立 barrel `src/sdk/index.ts`** 而非直接給 `src/index.ts` | 多一個 barrel 要維護 | `src/index.ts` 是 **core** 面、export 治理內部；SDK 面要**收斂**且能獨立演進，避免洩漏內部、避免後向相容耦合 |
| Python shim 只做 **credential-blind 骨架 + import-linter gate**，不接真 Hermes | 此刀無「跑起來的真 agent」 | 保持 slice 小（size budget）；真 vendor 接線是 R11；先把 **結構性 credential-blind 不變量**用指令鎖死 |
| CLI **零新依賴**（用 `process.argv`，不引 commander/yargs） | 解析較手寫 | slice-spec §3 規定新增第三方依賴要單獨成 slice；CLI 範圍極小，內建解析足夠，避免依賴變更混入 |
| verifier release **跨平台 + WASM**，但**不改信任語意** | 不解決 pubkey pinning | pinning/外部 root 是 P4（誠實 gate）；本刀只解「可重現、可在任何環境跑」，不過度宣稱信任升級 |
| import-linter 用 **forbidden contract**（黑名單禁 secret-bearing import）而非 layers | 需維護 forbidden 清單 | 與 TS `no-vendor-in-core`、Go `depguard` 同構（黑名單式結構防線）；對「shim 不得碰 secret store」是最直接的表達 |
| `verify:py` gate 在 **S1 一次配齊** | S1 比純加檔案重一點 | `scripts/verify-py.sh:18-27` 強制：plane 存在即須 gate，否則 `verify` 紅——不配齊就無法 GREEN，這是結構約束非選擇 |

---

## 5. Honest capability gates（誠實的能力閘門）

- **verified-from-code**：
  - `verify:py` 對「plane 存在但 gate 未配置」FAIL（[`scripts/verify-py.sh:18-27`](../../scripts/verify-py.sh)）——決定 S1 必須一刀配齊 gate。
  - `cmd/verifier` 是 fail-closed standalone binary、只依賴 `internal/{verify,chain}`、不依賴 producer（[`kernel/cmd/verifier/main.go:1-23,64-71`](../../kernel/cmd/verifier/main.go)）；`VerifyResult{Ok,Length,BrokenAt,Reason}` 是 byte-for-byte 契約（[`kernel/internal/verify/verify.go:16-57`](../../kernel/internal/verify/verify.go)）。
  - Go module path `github.com/agent-os/kernel`、go 1.22（[`kernel/go.mod:1-3`](../../kernel/go.mod)）——S5 build matrix 的基礎。
  - core barrel pattern（[`src/index.ts:9-26`](../../src/index.ts)）、runtime credential guard（[`src/runtime/brain/credential-guard.ts:32-40`](../../src/runtime/brain/credential-guard.ts)）、Brain Port credential-blind args（[`src/runtime/brain/port.ts` ToolCall args bundleRef 註解]）。
  - AGT 真的依賴 `import-linter>=2.0`（[AGT pyproject.toml:41](file:///tmp/agent-governance-toolkit/agent-governance-python/agent-os/pyproject.toml)）；Hermes 真的把憑證落地 `~/.hermes`（[hermes_constants.py:115,250-255](file:///tmp/hermes-agent-probe/hermes_constants.py)）——credential-blind import-linter 的 grounding。
- **inferred（設計推斷，非 vendor 既有）**：用獨立 `src/sdk/` barrel 收斂作者面、CLI 的兩個子命令形狀、import-linter forbidden 清單的具體模組名、WASM wrapper 的具體 entrypoint——皆為 Agent OS 設計選擇，非任何 vendor 既有結構。
- **尚未做（gate，不在 R9 宣稱）**：真 Hermes shim 跑真模型（R11）；SDK publish 到 npm/PyPI；ToolManifest 簽章/provenance；verifier pubkey pinning / 外部 root（P4）。本 ITEM 只交付「**credential-blind 結構骨架 + 作者面 SDK barrel + CLI + authoring 範本 + 可重現跨平台/WASM verifier 產物**」，不宣稱端到端真 vendor 整合或信任 root 升級。
- **only command output is truth**：本文件所有「綠/通過」宣稱在 slice 實作前皆為 placeholder；唯有各 slice DoD 的 `pnpm run verify` exit 0 + fresh-context Independent Verifier PASS 才算數。

---

## 6. Slice 分解與 DAG（無 cycle）

| Slice | 檔案 | Title | Depends-on |
|---|---|---|---|
| **P2R-R9-S1** | [P2R-R9-S1-python-credential-blind-shim.md](../slices/phase-2-remaining/P2R-R9-S1-python-credential-blind-shim.md) | Python credential-blind shim + `verify:py` gate（ruff + import-linter forbidden contract） | 無（新 Python plane；對齊 credential-blind 律） |
| **P2R-R9-S2** | [P2R-R9-S2-ts-sdk-author-barrel.md](../slices/phase-2-remaining/P2R-R9-S2-ts-sdk-author-barrel.md) | TS SDK author barrel（`src/sdk/index.ts` 最小 re-export + Fakes，無 deep import） | R3（ToolManifest）、P2 ports/fakes |
| **P2R-R9-S3** | [P2R-R9-S3-cli-manifest-lint-and-verify.md](../slices/phase-2-remaining/P2R-R9-S3-cli-manifest-lint-and-verify.md) | CLI `agentos`：`manifest lint`（消費 R3 parse）+ `verify`（relay verifier exit） | P2R-R9-S2、R3 |
| **P2R-R9-S4** | [P2R-R9-S4-tool-manifest-authoring.md](../slices/phase-2-remaining/P2R-R9-S4-tool-manifest-authoring.md) | ToolManifest authoring 範本 + 文件 + lint 驗收 | P2R-R9-S3、R3 |
| **P2R-R9-S5** | [P2R-R9-S5-verifier-release-artifact-wasm.md](../slices/phase-2-remaining/P2R-R9-S5-verifier-release-artifact-wasm.md) | standalone + WASM verifier release artifact（跨平台、可重現、版本化，不改信任語意） | P1 kernel（`cmd/verifier`） |

```
P2R-R9-S1 -> { }                       (Python plane，獨立)
P2R-R9-S2 -> { R3, P2-ports }
P2R-R9-S3 -> { P2R-R9-S2, R3 }
P2R-R9-S4 -> { P2R-R9-S3, R3 }
P2R-R9-S5 -> { P1-kernel }             (verifier，獨立於 S1-S4)
```
> 無 cycle 證明：rank S1=1、S5=1（兩條獨立鏈）、S2=2、S3=3、S4=4（S2→S3→S4 每條邊嚴格遞減）⇒ DAG。契約先於消費者：R3 schema → SDK barrel(S2) → CLI(S3) → authoring(S4)；verifier 鏈（S5）與 SDK 鏈無交叉依賴。

---

## 7. Grounded citations（real file:line）
- `scripts/verify-py.sh:11-27`（Python plane 存在但 gate 未配置 → FAIL；決定 S1 必須一刀配齊 ruff + pyproject）
- `scripts/verify-go.sh:11-30`（Go plane gate；S5 build 不得破壞）
- `kernel/cmd/verifier/main.go:1-23`（standalone fail-closed verifier 目的：稽核者信 binary 不信平台）
- `kernel/cmd/verifier/main.go:35-38,64-71`（pubkey 由稽核者提供、required；res.Ok → exit 0，否則 1/2）
- `kernel/internal/verify/verify.go:16-57`（`VerifyResult{Ok,Length,BrokenAt,Reason}` byte-for-byte 契約 + tamper/sequence/checkpoint 檢查）
- `kernel/go.mod:1-3`（module `github.com/agent-os/kernel`、go 1.22）
- `src/index.ts:9-26`（core barrel re-export pattern；S2 SDK barrel 比照但收斂作者面）
- `src/runtime/brain/credential-guard.ts:32-40`（runtime credential-blind guard；S1 是其 import 期互補層）
- `src/runtime/brain/port.ts`（ToolCall args 必須 bundleRef-only、credential-blind 註解）
- `/tmp/agent-governance-toolkit/agent-governance-python/agent-os/pyproject.toml:41`（AGT 依賴 `import-linter>=2.0`，credential-blind import gate grounding）
- `/tmp/hermes-agent-probe/hermes_constants.py:115,250-255`（Hermes 把憑證/profile 落地 `~/.hermes` — client-held credential，正是 SDK 結構性要拒絕的）
- `docs/design/five-piece-integration.md:48`（Developer surface「仍要建」清單：ToolManifest registry/contract harness/dependency-cruiser 反向規則/發布 Port+Fakes 當 SDK/verifier CLI 當 artifact）
- `docs/design/five-piece-integration.md:29`（CREDENTIAL：拒絕 Hermes `~/.hermes` 自管 + SpendGuard client-held-key）
- `docs/design/three-surface-architecture.md:68`（Developer 面定義：Python import-linter shim + TS SDK + Zod ToolManifest + 簽章版本化技能）
- `docs/design/three-surface-architecture.md:77`（P4：WASM 離線 verifier 嵌入殼 + 外部化簽章 root — R9 不宣稱信任 root 升級）
- `docs/standards/slice-spec.md:116`（Python SDK 用 import-linter contracts；Go 用 depguard；TS 用 dependency-cruiser）
