# Agent OS — Polyglot 工程標準（Engineering Standards）

> 本文件是 Agent OS build playbook 的「工程標準」分冊。它把 `AGENTS.md`（authoritative
> operating contract）的安全不變量與 Looping Engineering 方法論，落成**每種語言可被指令驗證的
> build rules**。權威衝突時 **`AGENTS.md` wins**；本文件只負責把那些規則具體化到 TS control plane /
> Go evidence kernel / Python SDK shim / Rust upstream / TS SDK+UI / Postgres 六條技術線。
>
> 架構脈絡見 [`docs/research/architecture-approach.md`](../research/architecture-approach.md)
> （Two-Plane Polyglot，已採用）。開發迴圈見 [`docs/dev-loops.md`](../dev-loops.md)。
> 日期：2026-06-19。狀態：**Binding（與 AGENTS.md 同級，受其覆蓋）**。
>
> 保留英文技術術語與程式識別符號。

---

## 0. 不可協商的前提（讀其餘章節前先內化）

這三條不是建議，是本文件每一節都在「強制」的東西。任何標準若與此衝突，以此為準：

1. **只信指令輸出（only command output is truth）。** 沒有一個綠燈的指令 exit code，就**不存在**
   「done」「works」「secure」。Self-reported 不被接受（`AGENTS.md` §Looping Engineering 1–2）。
   本文件的每一條 acceptance criterion 都對應一條可執行指令，列在 §10 的矩陣裡。
2. **兩條 HARD CONSTRAINT**（`AGENTS.md` §Low coupling, high cohesion + §Slice discipline）：
   - **(A) LOW COUPLING / HIGH COHESION** —— 由**每語言的 dependency-boundary check** 強制，且該
     check **必須 wired 進該語言的 verify gate**（§4 給出具體工具與 config）。非法或 cyclic 依賴
     **必須讓 verify 非零退出**。**落地前置（binding ordering）：** §4.1 的 `only-public-surface` 規則與
     現況 scaffold **尚不相容**（目前無 per-module `index.ts` barrel，且 `src/audit/event.ts` /
     `src/policy/types.ts` 直接 deep-import `../iam/ids.js`）。因此本約束的 TS 強制**必須**依
     `docs/slices/phase-0/INDEX.md` 的順序落地：先以 `SLICE-P0-003`（deps gate）接上 `no-circular` +
     `inward-only`，再以一個**獨立的 barrel-migration slice** 建立 `src/iam/index.ts` /
     `src/policy/index.ts` / `src/audit/index.ts` 並改寫 import，**之後**才開啟 `only-public-surface`
     規則。在 barrel 落地前，`only-public-surface` 僅 scope 到新 module（見 §4.1）。
   - **(B) PER-SLICE ADVERSARIAL CODE REVIEW** —— 每個 slice 在 merge 前必須通過一位 fresh-context、
     以「弄壞它」為職責的 reviewer（§9）。**No slice merges on self-review alone.** 細則見
     `docs/standards/adversarial-code-review.md`；slice 定義見 `docs/standards/slice-spec.md`。
3. **Deny-by-default + fail-closed everywhere；credentials NEVER** 落到 workspace / logs / artifacts /
   snapshots / traces / fixtures。這在每語言被重述為 build rules（§7），並由 `secret-scan` 與
   adversarial review 雙重把關。

> **Capped loops，no unbounded loops。** 任何收斂/排程迴圈都必須宣告 iteration cap（`AGENTS.md`
> Looping 4；卡關 3 次停下重評）。本文件不引入任何 background poller 來「enforce」安全——prevention
> 永遠在 hook，loop/cron 只是 verification（`dev-loops.md` Tier 0 vs Tier 3）。

---

## 1. 範圍：六條技術線與單一契約來源

| 技術線 | 語言/框架 | 角色（失敗模式） | 倉庫位置（建議） |
|---|---|---|---|
| **Control plane core** | TypeScript / Node 22（Fastify + ConnectRPC + Zod + XState + Drizzle） | 治理邏輯，每週迭代，高 velocity | `src/`（沿用 scaffold，**不重寫**） |
| **Evidence kernel** | Go（Tessera + Ed25519 + RFC-3161） | correctness-under-adversary 的 WORM 證據基底；獨立進程/身分 | `kernel/`（新建） |
| **Agent-facing SDK** | Python（薄 shim，credential-blind） | agent 生態系接觸面，marshaling-only | `sdk/python/`（新建） |
| **Integrator SDK + CLI** | TypeScript（connect-es） | platform/SRE/MSP 整合者的一級 client | `sdk/ts/`、`cli/`（新建） |
| **UI** | TypeScript（Next.js + shadcn + React Flow + WASM verifier） | approval inbox / timeline / replay 的人面，secondary | `ui/`（新建） |
| **OpenShell upstream hardening** | Rust（upstream PR only） | 強制路徑硬化，**不碰本倉庫 scaffold** | OpenShell 上游 fork（PR 分支） |
| **Persistence** | TypeScript over SQL（Postgres / SQLite，Drizzle） | 可變營運狀態；**刻意與不可變 Go kernel 分離** | `src/persistence/`（control plane 內） |

### 1.1 單一契約來源（single source of truth across planes）—— HARD CONSTRAINT (A) 的跨平面面向

平面之間**只透過 typed contract** 對話，**永不**互相 import 內部實作（`AGENTS.md` §Low coupling）。
契約有兩個權威來源，分工明確、互不重疊：

- **`proto/` 的 Protobuf** 是**跨進程/跨語言 wire** 的唯一來源：control plane ↔ OpenShell（native
  gRPC via `connect-node`）、control plane ↔ evidence kernel（append-only ingest gRPC）、Python SDK /
  TS SDK / UI ↔ control plane（Connect / gRPC-Web）。**所有語言的 client/server stub 必須從同一份
  `.proto` 生成，不得手寫。** 生成產物（`*_pb.ts`、`*_pb2.py`、`*.pb.go`）受 §3 的 generated-code
  規則治理。
- **`src/` 的 Zod schema**（branded ids、`AuditEvent`、`PolicyRequest`…）是 **control plane 進程內**
  trust-boundary 的 runtime 驗證唯一來源。Zod ↔ proto 的對映由 control plane 的 adapter 負責，且
  「proto 形狀」與「Zod 形狀」的一致性以 **contract test** 釘住（drift = test fail）。

> **drift 防線：** OpenShell 是 alpha，proto 會無預警漂移。adapter pin 在 `version + image digest`
> （NemoClaw `min==max` 紀律），並有 contract-test gate（`AGENTS.md` 架構決策 §3）。proto 變更走
> 一個 PR、重生全部語言 stub、跑全部 contract test，缺一不可 merge。

---

## 2. 通用 verify gate 模型（每語言一個，組合成單一真相）

`pnpm run verify` 是 monorepo 根的**單一入口**（`AGENTS.md` Looping 1）。它**依序**呼叫每條技術線
自己的 gate；任一非零，整體非零。沒有「部分綠」這種狀態。

```
pnpm run verify                       # 根 gate，唯一真相來源
├─ ts:verify     typecheck + lint + build + test + deps + secret-scan   # control plane / SDK / UI
├─ go:verify     go vet + staticcheck + go test -race + go:deps         # evidence kernel
├─ py:verify     ruff + pyright + import-linter + pytest                # python SDK shim
└─ (rust 上游)   在 OpenShell CI 跑；本倉庫以 contract test 對其 PR 驗證   # 見 §6
```

**現況（CURRENT；2026-06-19 已用指令核實）：** 倉庫今天的 `package.json` 定義
`verify = typecheck && lint && build && test && secret-scan`，且 `.githooks/pre-commit` 跑它並
**block 失敗的 commit**。`deps` step **尚未存在**（由 `SLICE-P0-003` 落地），`kernel/`、`sdk/`、`proto/`
亦**尚未存在**——因此上方 ASCII 中的 `ts:verify` 的 `deps`、以及 `go:verify` / `py:verify` / Rust 線
**都是 TARGET（尚未 wired），不是 CURRENT**。任何擴充**只能加 step，不能拿掉 step**，且 `pre-commit`
持續是 fail-closed（pnpm 缺失即 block）。

> **規則（gate-first）：每加一條技術線，先把它的 gate 接進根 verify，再寫該線第一行實作碼**（呼應
> test-first）。一條沒有接進 verify 的技術線在本專案視為**「不存在」（NOT-YET-EXISTENT-PER-GATE-FIRST）**。
> **依此規則，Go evidence kernel / Python SDK / Rust upstream 三條線在其 gate（`go:verify` / `py:verify`
> / contract-test）被 wired 進根 verify 之前，本文件對它們的標準屬「待生效（PENDING-SCAFFOLD）」——
> 它們是 §1 的設計目標與規格，不是「現在 binding 且已綠」的關卡。** §10 的 Acceptance 矩陣對每一格標
> LIVE / PENDING-SCAFFOLD，避免被誤讀為「現在就會綠」。

### 2.1 各語言 gate 的權威定義

| 語言 | gate 指令（必須全綠） | 對應 npm script / Makefile target |
|---|---|---|
| **TypeScript** | `tsc --noEmit`（strict）→ `biome check`（lint+format）→ `tsc -p tsconfig.build.json`（build）→ `vitest run`（test）→ `depcruise`（deps，§4.1）→ `scripts/scan_secrets.sh`（secret-scan，§7.4） | `pnpm run verify`（已存在，擴充 deps step） |
| **Go** | `go vet ./...` → `staticcheck ./...` → `go test -race ./...` → `go-arch-lint check`（deps，§4.2） | `make go-verify`，由 `go:verify` script 包裝 |
| **Python** | `ruff check`（lint）→ `ruff format --check`（format）→ `pyright`（typecheck）→ `lint-imports`（import-linter deps，§4.3）→ `pytest` | `make py-verify`，由 `py:verify` script 包裝 |
| **Rust（upstream）** | `cargo fmt --check` → `cargo clippy -D warnings` → `cargo test`（在 OpenShell CI） | 不在本倉庫；本倉庫以 contract test gate 對其 |

> Brief 列出的最小集（TS: `pnpm run verify`；Go: `go test + go vet + staticcheck`；Python:
> `pytest + ruff + pyright`）是**下限**。本文件在每個下限之上**加掛 dependency-boundary check**，因為
> 那是 HARD CONSTRAINT (A) 的指令化身——不接進 gate 就等於沒有強制。

---

## 3. 各語言 repo layout

通則（適用所有語言）：

- **一個 module 一個責任（high cohesion）；只經 public surface 被消費（low coupling）。** 每個 module
  有明確、**唯一**的「對外面」：
  - **TS：barrel `index.ts` 是 module 的唯一 public surface**（與 §4.1 的 `only-public-surface` regex
    一致——該規則只允許 import 對方的 `index.ts`，不允許 `api.ts` 之類其他「宣告介面」檔；若需要一個
    語意上的 public API 檔，請把它 re-export 自 `index.ts`，使 `index.ts` 仍是唯一進入點）。
  - **Go：package 的 exported API**（其餘放 `internal/`，由編譯器強制）。
  - **Python：package `__init__.py` 的 re-export**。
  **深入別人 internals = 違規（§4 會讓它 verify fail）。**
  > **遷移註記（TS）：** 現況 scaffold 尚無 per-module `index.ts`（只有頂層 `src/index.ts`），且
  > `event.ts` / `policy/types.ts` 直接 import `../iam/ids.js`。在 barrel-migration slice 落地前，
  > `only-public-surface` 規則僅對**新 module** 生效（見 §4.1 與 §0.2 的 binding ordering）。
- **測試與被測碼同層共置**（沿用現況：`src/audit/event.test.ts` 緊鄰 `src/audit/event.ts`）。
- **generated code 隔離且標記**：放在 `**/gen/` 或檔名 `*_pb.*`，在 lint/coverage/deps 規則中以路徑
  排除，且**不得手改**（drift 只能改 `.proto` 再重生）。
- **無 host path / tenant id / user id / provider token 硬編碼**（`AGENTS.md` §Coding standards）。

### 3.1 TypeScript control plane（`src/`，沿用 + 擴充）

```
src/
  index.ts                 # 套件 public surface（已存在）
  iam/        ids.ts        # branded TenantId/ProjectId/TaskId/ActorId/RequestId/EventId/SandboxId
                            #   ← 即 OCSF AgentContext 欄位（已存在，KEEP）
  audit/      event.ts      # createAuditEvent fail-closed（已存在，KEEP）→ 餵 Go kernel 的 typed event
              redact.ts     # 依 key 名 redact（已存在）；§7.3 升級為 value-scanning
              serialize.ts  # 確定性序列化
  policy/     types.ts      # PolicyRequest / PolicyDecision / AllowRule（已存在）
              evaluate.ts   # deny-by-default + fail-closed（已存在，KEEP）→ PDP layer 種子
  # 以下為依架構新增的 module，每個都是一個 cohesive 責任、各有 index.ts public surface：
  orchestration/            # Task/AgentSession/Artifact 狀態機（XState）+ resume ledger
  approval/                 # ApprovalRequest 引擎（maker≠checker by capability possession）
  toolregistry/             # ToolManifest / ToolInvocation（Zod-typed）
  credential/               # CredentialBundle lease lifecycle（mint→inject→use→revoke→expire）
  inference/                # 每路由 inference policy gate
  adapter/openshell/        # single chokepoint：connect-node typed gRPC client
  evidence/                 # 對 Go kernel 的 append-only ingest client（只能 append）
  persistence/              # Drizzle repositories（per-tenant DB；NO plaintext credential）
  tenant/                   # Tenant/User/Project routing（gateway-per-tenant）
```

`tsconfig.json` 已是 strict 全開（`strict`、`noUncheckedIndexedAccess`、`noImplicitOverride`、
`noFallthroughCasesInSwitch`、`forceConsistentCasingInFileNames`）。**不得放寬。** ESM（`NodeNext`）下
**相對 import 必須帶 `.js` 副檔名**（現況慣例，見 `event.ts` import `../iam/ids.js`）。

### 3.2 Go evidence kernel（`kernel/`，新建）

```
kernel/
  go.mod                    # module github.com/<org>/agent-os-kernel；獨立 module（不與 TS 同進程）
  cmd/
    kerneld/   main.go       # WORM ingest daemon（gRPC server）
    verify/    main.go       # standalone verifier（single static binary；亦出 WASM build）
  internal/                 # 全部實作細節放 internal/，外部無法 import（Go 語言級 low-coupling）
    tilelog/                #   Tessera tile-based log engine（先簡 hash-chain，再升 Tessera）
    sign/                   #   Ed25519 checkpoint 簽章（per-tenant key）
    anchor/                 #   RFC-3161 TSA / witness 外部錨定
    ingest/                 #   monotonic per-source sequence + gap detection + transactional outbox
  api/        ...           # 由 proto 生成的 server stub（gen，唯一 exported wire 面）
  verifier/   ...           # verifier 可被第三方 import 的最小 public package（auditor 信任的 ~surface）
```

**核心結構不變量：** kernel 與 control plane 是**不同進程 + 不同語言 + 不同身分**；control plane 對
kernel **只能 append，無改寫權**（`AGENTS.md` 架構 §3）。`go.mod` 獨立確保它**不可能** import TS/任何
control-plane 內部。`-race` 必開（WORM 路徑的 concurrency 正確性是 c1/c4 admissibility 的基礎）。

### 3.3 Python SDK shim（`sdk/python/`，新建）

```
sdk/python/
  pyproject.toml            # ruff + pyright + pytest + import-linter 設定集中於此
  src/agentos/
    __init__.py             # public surface：只 re-export 對外 API
    session.py              # `with agentos.session(...) as s:` governed-session context manager
    subsession.py           # sub-session 衍生（c20 sub-delegation）
    invocation.py           # ToolInvocation helper
    _transport/             # ConnectRPC client + 包裝 OpenShell 官方 Python SDK（私有，前綴 _）
    gen/                    # 由 proto 生成的 *_pb2.py（不得手改）
  tests/                    # pytest（含 credential-blind 不變量測試，§7）
```

**鐵則：shim 是 marshaling-only，從不持有 credential。** 所有治理在 control plane。`_transport` 等
私有實作以底線前綴；對外只有 `agentos.session` 等少數 entrypoint（high cohesion）。

### 3.4 TS SDK + CLI + UI（`sdk/ts/`、`cli/`、`ui/`，新建）

- `sdk/ts/`：由**同一份 proto** 經 `connect-es` 生成，發為 npm。與 control plane 共用 Zod schema 來源，
  消除 drift。
- `cli/`：thin commander/oclif，**只**消費 `sdk/ts/` 的 public client（不深入 control plane internals）。
- `ui/`：Next.js（App Router/RSC）+ shadcn + React Flow；evidence viewer 內嵌 verifier 的 **WASM
  build**。**browser 不直連 raw gRPC**——走 control plane 暴露的 Connect / gRPC-Web；live feed 用
  server-streaming 或 polling（架構 §2 評審指正）。

> 上述四線雖落在不同目錄，仍**共用根 verify 的 TS gate**（同一 biome / tsc / vitest / depcruise）。

---

## 4. dependency-boundary check —— HARD CONSTRAINT (A) 的指令化身（CONCRETE）

> **這是本文件的核心交付。** Low coupling / high cohesion 不能只是文字——它必須在每語言由一個具體工具
> 強制，且該工具**必須是 verify gate 的一步**。以下逐語言給出工具、config、以及「一個非法/cyclic
> 依賴長什麼樣、會如何讓 verify 非零退出」。

### 4.0 共通的非法依賴定義（11 layers + 跨平面）

兩類依賴在**任何語言**都非法，工具必須抓出來：

1. **Cyclic dependency（環）** —— 任意 module A → … → A。依賴必須 **acyclic、inward-pointing**
   （domain ← application ← adapters，`AGENTS.md` §Low coupling）。
2. **Cross-layer leak / deep import** —— 跨越 §5 的 11 層方向約束，或繞過 module public surface 直 import
   其 internals。

### 4.1 TypeScript — `dependency-cruiser`（wired into `pnpm run verify`）

工具：**`dependency-cruiser`**（`depcruise`）。**它本身是 HARD-A 的執法工具，因此必須在「wire deps step
進 verify」的同一個 slice（`SLICE-P0-003`）內被加入為 pinned devDependency**（`pnpm add -D
dependency-cruiser@<pinned>`，寫入 `pnpm-lock.yaml`）——執法工具不可是未受管依賴。

> **落地順序（binding；呼應 §0.2 與評審指正）：** 規則 (1) `no-circular` 與 (3) `layers-inward-only`
> 對現況 scaffold **已相容**，可在 `SLICE-P0-003` 一次開啟。但規則 (2) `only-public-surface` **與現況
> 不相容**：現無 per-module `index.ts`，且 `src/audit/event.ts`、`src/policy/types.ts` 直接 deep-import
> `../iam/ids.js`——若立即開啟會使 `pnpm run deps:check` 非零、連帶 `pnpm run verify` 由綠轉紅，違反
> 「KEEP-AND-EXTEND，只加綠、不破綠」承諾。因此規則 (2) **必須**：
> - **(a)** 先以一個**獨立的 barrel-migration slice** 建立 `src/iam/index.ts` / `src/policy/index.ts` /
>   `src/audit/index.ts` 並把跨 module import 改走 barrel；**之後**才把 (2) 設為 `error` 對全 `src/` 生效；或
> - **(b)** 在 barrel 落地前，把 (2) 的 `from.path` scope 限縮到**新增 module**（例如 `^src/(orchestration|approval|toolregistry|credential|inference|adapter|evidence|persistence|tenant)/`），
>   使既有三個 module 暫不受 (2) 約束、但新 module 一律 enforce。
>
> 本專案採 **(a)+(b) 混合**：先 (b) 讓新 module 立即受管，再以 barrel-migration slice 收尾後切到 (a)。

在根 `package.json` 加 step，使 `verify` 變為（目標形態，`SLICE-P0-003` 落地後）：

> **Canonical script 名（全 playbook 統一）：依賴邊界檢查的 npm script 一律命名 `deps:check`**（與
> `docs/slices/phase-0/S0.3-deps-boundary-gate.md` 落地的名稱一致）。其他文件中曾出現的 `deps` / `boundaries`
> 為同義別名，**以 `deps:check` 為準**。

```jsonc
// package.json（擴充現有 verify；只加 step，不拿掉任何既有 step）
"scripts": {
  "deps:check": "depcruise --config .dependency-cruiser.cjs src",
  "verify": "pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run test && pnpm run deps:check && pnpm run secret-scan"
}
```

`.dependency-cruiser.cjs`（`forbidden` 規則，severity 必須是 `error` 才會讓 exit code 非零）：

```js
module.exports = {
  forbidden: [
    {
      // (1) 任何 cyclic dependency = 直接 fail
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      // (2) 禁止深入別的 module 的 internals：只能 import 對方的 index.ts（public surface）
      //     例：from src/orchestration 直接 import src/policy/evaluate.ts 內部檔 → error
      //
      //     ⚠ 落地順序（§0.2 / §4.1 binding ordering）：barrel-migration slice 落地前，from.path
      //        僅 scope 到「新增 module」（既有 iam/audit/policy 暫不受此規則，因其尚無 index.ts
      //        且現況 deep-import ../iam/ids.js——立即開啟會破現有綠燈）。barrel 落地後，把 from.path
      //        放寬為 ^src/([^/]+)/ 對全 src 生效（option a）。
      name: "only-public-surface",
      severity: "error",
      from: {
        // option (b)：先只管新 module；barrel-migration slice 後改為 ^src/([^/]+)/
        path: "^src/(orchestration|approval|toolregistry|credential|inference|adapter|evidence|persistence|tenant)/",
      },
      to: {
        path: "^src/([^/]+)/(?!index\\.ts$).+",
        // 同一 module 內部互相 import 允許；跨 module 只准打到對方 index
        pathNot: "^src/$1/",
      },
    },
    {
      // (3) 11 層方向：adapters/UI 可依賴 application/domain，反向禁止
      //     例：from src/policy（domain/PDP）import src/adapter/openshell → error（inward-pointing 被違反）
      name: "layers-inward-only",
      severity: "error",
      comment: "domain <- application <- adapters；見 engineering-standards §5",
      from: { path: "^src/(iam|audit|policy)/" },          // domain 層
      to: { path: "^src/(adapter|cli|ui|persistence)/" },   // 外層
    },
    {
      // (4) 跨平面只走契約：control plane 不得 import 任何 generated 之外的 SDK/UI 內部
      name: "no-cross-plane-internals",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^(sdk|ui|cli)/", pathNot: "/gen/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(\\.test\\.ts$|/gen/)" },
    tsConfig: { fileName: "tsconfig.json" },
  },
};
```

**一個非法/cyclic 依賴長什麼樣 → 後果：** 若有人在 `src/policy/evaluate.ts` `import` 了
`../adapter/openshell/client.js`（domain 反向依賴 adapter），規則 (3) `layers-inward-only` 命中、
severity `error`，`depcruise` 以非零退出 → `pnpm run deps:check` 失敗 → `pnpm run verify` 失敗 →
pre-commit hook **block 該 commit**。若有人造出 `a.ts → b.ts → a.ts` 的環，規則 (1) `no-circular`
同樣 fail。**這就是「Enforced, not aspirational」的字面意思。**

### 4.2 Go — `go-arch-lint`（+ Go 語言級 `internal/`，wired into `go:verify`）

> **PENDING-SCAFFOLD：** `kernel/` 尚未存在，`go:verify` 尚未 wired 進根 verify。本節是 P1 kernel
> 初始化 slice 的規格，**不是現在 binding 且已綠的關卡**。`go-arch-lint`（或所選的 `depguard`）須在
> 建立 `kernel/` 的同一個 slice 內加入為 pinned tool（`go.mod` / `go.sum` 或 golangci-lint 設定），
> 並隨 `go:verify` 一起 wired 進根 verify。

Go 有兩道：

- **語言級**：`kernel/internal/**` 的 package 依 Go 規則**無法被 module 外 import**——這天然封死了
  evidence kernel 的實作細節，是 low-coupling 的 by-construction 防線。
- **架構級**：用 **`go-arch-lint`** 宣告層與允許邊（與 `depguard` 二擇一或併用；**最終選擇於 P1 建立
  `kernel/` 時拍板**，屆時其 path glob 依 kernel 實際 layout 微調）。`go:verify` 串：

```bash
go vet ./... && staticcheck ./... && go test -race ./... && go-arch-lint check
```

`.go-arch-lint.yml`：

```yaml
version: 3
components:
  ingest:    { in: internal/ingest }
  tilelog:   { in: internal/tilelog }
  sign:      { in: internal/sign }
  anchor:    { in: internal/anchor }
  api:       { in: api }            # proto-generated wire surface
  verifier:  { in: verifier }       # auditor 信任的 public surface
deps:
  ingest:    { mayDependOn: [tilelog, sign, anchor] }
  tilelog:   { mayDependOn: [sign] }
  verifier:  { mayDependOn: [tilelog, sign] }   # verifier 不依賴 ingest（standalone）
  # 未列出的邊一律禁止；circular 由 go-arch-lint 內建偵測
```

**一個非法依賴長什麼樣 → 後果：** 若 `internal/sign` import 了 `internal/ingest`（簽章層反向依賴 ingest，
製造環），`go-arch-lint check` 報未授權邊並非零退出 → `go:verify` 失敗 → 根 `verify` 失敗。
`depguard`（staticcheck/golangci-lint 家族）可作 import-allowlist 的補強。

### 4.3 Python — `import-linter`（wired into `py:verify`）

> **PENDING-SCAFFOLD：** `sdk/python/` 尚未存在，`py:verify` 尚未 wired 進根 verify。本節是 P3 Python
> SDK 初始化 slice 的規格。`import-linter`（與 `ruff` / `pyright`）須在建立 `sdk/python/` 的同一個 slice
> 內以鎖定版本加入 `pyproject`，並隨 `py:verify` 一起 wired 進根 verify。

工具：**`import-linter`**（`lint-imports`）。`py:verify` 串：

```bash
ruff check . && ruff format --check . && pyright && lint-imports && pytest
```

`pyproject.toml`（或 `.importlinter`）：

```ini
[importlinter]
root_package = agentos

[importlinter:contract:layers]
name = SDK layers（public surface 在上，transport 在下，方向不可反）
type = layers
layers =
    agentos.session
    agentos.subsession
    agentos.invocation
    agentos._transport

[importlinter:contract:transport-is-private]
name = 外部不得繞過 public surface 直 import _transport
type = forbidden
source_modules = agentos.session
forbidden_modules = agentos._transport.openshell_raw
# 註：合法路徑是 session -> _transport（layers 允許），但禁止外部消費者直 reach raw client
```

**一個非法依賴長什麼樣 → 後果：** 若 `agentos._transport` 反向 import 了 `agentos.session`（下層依賴
上層，違反 layers 方向），`lint-imports` 回非零 → `py:verify` 失敗 → 根 `verify` 失敗。`import-linter`
的 layers contract **內建偵測 indirect/cyclic** import。

### 4.4 Rust（upstream）— `cargo`-native

upstream Rust PR 不在本倉庫；其邊界由 OpenShell 自身的 crate boundary + `cargo clippy -D warnings` 在
OpenShell CI 強制。本倉庫對它的依賴邊界以 §6 的 contract test + version/digest pin 把關。

---

## 5. 11 層與「no-cross-layer-leak」規則

`AGENTS.md` §Low coupling 列出 11 個 concern，**concerns 不得跨層洩漏**。本節把它定義成可被 §4 工具
強制的具體層與方向。

| # | Layer | 責任（high cohesion 的一句） | 可以依賴 | **禁止依賴（leak）** |
|---|---|---|---|---|
| 1 | **CLI / UI** | 人面/指令面，消費 SDK client | SDK（public client）| control plane internals、kernel、persistence |
| 2 | **Task orchestration** | Task/AgentSession/Artifact 狀態機、resume ledger | policy、approval、tool registry、adapter、evidence | UI/CLI、SDK internals |
| 3 | **Approval workflow** | ApprovalRequest（maker≠checker by capability）| policy、credential、evidence | orchestration internals |
| 4 | **Tool registry** | ToolManifest/ToolInvocation 契約與准入 | policy | credential raw、adapter internals |
| 5 | **Policy engine（PDP）** | deny-by-default 決策（capability algebra/SoD/budget/route）| iam、audit（型別）| adapter、persistence、UI（**domain 不得依賴外層**）|
| 6 | **Credential provider** | lease lifecycle（mint→…→expire）；**永不明文持久化** | iam、audit | UI、SDK、persistence 明文欄位 |
| 7 | **Sandbox runtime adapter** | OpenShell single chokepoint（typed gRPC）| iam、audit（型別）| orchestration/approval internals（只被它們呼叫，不反向）|
| 8 | **Inference routing** | 每路由 inference policy gate | policy | adapter internals |
| 9 | **Audit / event log** | typed domain event → append-only ingest 進 kernel | iam（branded ids）| **任何會帶 raw secret 的層**（redact 先行）|
| 10 | **Persistence** | 可變營運狀態（Drizzle，per-tenant DB）| iam | domain 邏輯（被 repository 介面隔離）、kernel（**證據與營運狀態必須分離**）|
| 11 | **Tenant / IAM** | 身分與 gateway-per-tenant 路由 | —（最底層 domain）| 一切外層 |

**方向總則（inward-pointing）：** `domain（iam, audit-types, policy, tenant）← application
（orchestration, approval, tool registry, credential, inference）← adapters（openshell adapter,
persistence, evidence client, CLI, UI）`。**箭頭只能向內。** 任何反向或跨層斜插（例：UI 直讀
persistence、policy import adapter、audit 收到未 redact 的 credential 物件）就是 leak，由 §4.1 的
`layers-inward-only` / `only-public-surface` 規則在 `verify` 抓出。

> **跨平面對映：** 11 層大多活在 TS control plane；evidence kernel（Go）對應 layer 9 的**下游 sink**，
> 但**獨立進程/身分**，control plane 只 append（layer 9 → kernel 是單向 ingest，kernel 從不回呼
> control plane）。Python/TS SDK + UI 是 layer 1 的外緣，只經 proto/Connect 契約進來。**沒有任何一條
> 跨平面邊是「import 對方原始碼」——全是 typed wire。**

---

## 6. typed-schema 規則（Zod / Pydantic / proto）

1. **proto 是跨平面 wire 的唯一來源**（§1.1）。stub 全生成，不手寫；proto 改動 → 重生全語言 →
   跑全 contract test，否則不可 merge。
2. **TS：Zod 在每個 untrust 邊界做 runtime 驗證。** TypeScript 型別**不是** runtime 安全邊界
   （`AGENTS.md` §Coding standards）——必須 `.parse()`/`.safeParse()`。沿用現況慣例：`evaluatePolicy`
   收 `unknown` 並 `PolicyRequest.safeParse` 後 fail-closed；`createAuditEvent` 缺欄位即 throw（無
   partial event）。branded ids（`TenantId` 等）確保 `TenantId` 不能被當 `ProjectId` 用——**新增 id 一律
   走 `nonEmpty.brand<...>()`，不得用裸 string。**
3. **Python：Pydantic 只在 `validate()` 邊界保證 field 一致性，`model_construct` 一用即失效**
   （架構決策 §2 明列）。因此 Pydantic **只**用於 SDK 邊界的 shape 驗證，**不得**用來主張跨物件 stateful
   不變量（maker≠checker、child⊆parent、budget 單調遞減）——那些不變量**只**活在 TS PDP，並以
   property-based + adversarial conformance 測試當 release gate。
4. **Go kernel：** 入口只接 proto message；內部 domain 型別獨立，序列化用確定性編碼（hash-chain 需
   byte-stable）。
5. **一份 schema、一處改。** 同一概念（如 `AuditEvent` 形狀）不得在兩處各自手寫；TS 是 Zod 權威、wire 是
   proto 權威，兩者一致性以 contract test 釘住。

---

## 7. 安全不變量 → build rules（每語言重述）

把 `AGENTS.md` §Non-negotiable security invariants 落成「會讓 verify / review fail 的具體規則」。

### 7.1 Deny-by-default + fail-closed（所有語言）

- 任何能力（file/network/process/inference/credential）**未明確 allow 即 deny**；malformed input /
  missing context / 內部 error ⇒ `deny`，**永不** `allow`（現況 `evaluate.ts` 已體現）。
- **Build rule：** 每個新增的 policy decision point 必須有一條 **RED-first 測試**證明「unknown → deny」
  與「malformed → deny（fail-closed）」。缺這兩條測試的 PDP 變更，adversarial review 直接 fail。
- **deny 屬於 hook（prevention）**，不是 poller（`dev-loops.md` Tier 0）。**禁止**新增任何 background
  loop 去「補上」一條 deny 規則。

### 7.2 Credentials NEVER persisted/printed（所有語言）

- 不得寫入 workspace files / logs / artifacts / snapshots / traces / **test fixtures**。
- **Persistence build rule（TS/Drizzle）：** schema **不得**有明文 credential 欄位；只存 lease metadata +
  reference，secret 委由 OpenShell SecretResolver（架構 §2）。新增「看起來像 secret 的明文欄位」由
  adversarial review 阻擋。
- **Python shim build rule：** shim **結構上**不持有 credential（marshaling-only）；測試必須斷言
  session 物件不暴露任何 secret 欄位。

### 7.3 Redaction（defense-in-depth）

- **現況（CURRENT；已核實 `src/audit/redact.ts`）：** redaction **只依 key 名**（`secret/token/api_key/
  bearer/...` → `[REDACTED]`）；**value-scanning 尚未實作**（檔內自註：「Scanning string VALUES … is the
  full loop #3 follow-up」）。**這代表：放在非 secret-key 欄位（free-form `action` / `message` /
  `resource` 字串）的 secret-shaped 值，目前不會被 redact。** 任何文件**不得**宣稱現有 redactor 已能攔下
  free-form value 中的 secret。
- **升級（綁定 RED-first slice，非開放 TODO）：** value-scanning redaction（高熵/secret-shaped 字串）由
  `docs/slices/phase-0/S0.4-redaction-filter.md`（`SLICE-P0-004`，F3）以 **RED-first** 落地：先寫一條
  「把 canary 放進 free-form 欄位 → 期望輸出已 scrub」的**失敗測試**（證明目前是 convention 非 enforced），
  再實作 value-scanning 使其轉綠。任何進 audit / kernel 的 payload **必須**先過此 redact 出口（§7.5 的
  single redaction exit）。「credentials never in traces/snapshots」是 P0 AGENTS.md 不變量，**不得**降為
  「之後再說」。

### 7.4 secret-scan gate（已存在，不可退化）

- `scripts/scan_secrets.sh` 掃 `src/ scripts/ .githooks/`，命中即非零退出，且**只印 `file:line`、絕不印
  matched value**（gate 本身不能變成 leak 源）。它是 `verify` 與 pre-commit 的一步。
- **擴充規則（綁定 slice，非開放 TODO）：** 新增技術線（`kernel/`、`sdk/`、`ui/`）時，**必須在該技術線
  的初始化 slice 內**把其根目錄加進 `ROOTS`（否則新平面成為未掃描的洩漏面）。canary fixture 與
  logs/artifacts/snapshots/traces 的執行期覆蓋，由 `docs/standards/test-and-acceptance.md` §3.2 的
  6-sink credential-non-leak conformance suite 以 RED-first 落地（`SLICE-P0-004` 起），並列為
  release-blocking——「credentials never in traces/snapshots」是 P0 不變量，由 conformance suite 而非
  TODO 守住。

### 7.5 Audit completeness + 跨租隔離

- 每個 privileged decision/action 必須 emit 完整 `AuditEvent`（actor/tenant/project/task/sandbox?/
  action/resource/policy_decision/timestamp/request_id/result）——現況 `createAuditEvent` 已 fail-closed
  強制此 shape。**新增 privileged 路徑缺 audit emit = review fail。**
- **同步先寫後放行（synchronous-commit-before-effect）：** 先把事件確定寫入並 hash-chain 進 kernel，
  **再**放行外部副作用（架構 §3 data flow 5）。
- **跨租隔離 by construction（enterprise = gateway-per-tenant）** 且**有測試**：tenant A 嘗試讀 B 的
  task/credential/log/sandbox/policy/artifact **必須被拒並 audited**。跨租 conformance suite 是
  **release-blocking** gate（c3）。

> 上述每一條都對映到 `AGENTS.md` §Custom loops（產品 runtime 的 8 個 security loop）；本文件負責「開發
> 期」把它們變成可跑的測試與 gate，runtime enforcement 見 `docs/research/loops.md`。

---

## 8. 依賴政策（dependency policy，所有語言）

1. **不加 dependency without justification**（`AGENTS.md`）。新增依賴的 PR 必須在 description 寫明：
   為何需要、是否有更小替代、授權與維護狀態、SBOM 影響。
2. **No broad allow-all** —— 不得引入會繞過 deny-by-default 的「allow 一切」型依賴或設定。
3. **Pin + 可重現：** TS 用 `pnpm-lock.yaml`（已存在）；Python 用鎖定的 `pyproject`/lock；Go 用
   `go.sum`；OpenShell adapter pin `version + image digest`。
   **dependency-boundary 執法工具本身也是依賴，且必須被 pin：** `dependency-cruiser`（TS）、
   `go-arch-lint`/`depguard`（Go）、`import-linter` + `ruff` + `pyright`（Python）、`buf`（proto）
   現在**都尚未在任何 manifest**。規則：**每個執法工具，必須在「wire 其 gate step 進 verify」的同一個
   slice 內**以鎖定版本加入對應 manifest（TS 進 `package.json` + `pnpm-lock.yaml`；Go 進 `go.mod`/
   `go.sum` 或 golangci-lint 設定；Python 進 `pyproject`）——執法 HARD-A 的工具不可是未受管/未 pin 的依賴。
4. **避免 deprecated 基底：** 例 audit kernel 用 **Tessera 而非 maintenance-mode 的 Trillian**（架構決策
   已查證）。
5. **generated code 不算手寫依賴**，但其生成器（protoc plugins、connect-es、buf）受同樣 pin 規則。
6. **Rust 只走 upstream**——不在本倉庫引入 Rust 依賴；硬化以 OpenShell PR 進入，由其 CI 承載（避免
   alpha rebase 稅）。

---

## 9. PER-SLICE ADVERSARIAL CODE REVIEW —— HARD CONSTRAINT (B)

> Slice 定義與流程的權威在 `docs/standards/slice-spec.md` 與 `docs/standards/adversarial-code-review.md`
> （由 playbook 其他分冊撰寫）。本節定義**工程標準面**的不可協商點。

1. **小而獨立可驗證的 slice。** 每個 slice 自帶 RED-first 測試、跑綠根 `verify`、不破 §4 的
   dependency-boundary。
2. **Merge 前必過 adversarial code review。** reviewer 是 **fresh context**，職責是**弄壞它**：嘗試
   突破 deny-by-default、fail-closed、audit 完整性、credential 非洩漏、跨租隔離。**self-review 不算數。**
3. **Coupling/cohesion 是 review 的 explicit blocking 維度**（`AGENTS.md` §Low coupling 最後一條）：
   reviewer 必須明確檢查「這個 slice 有沒有製造新的跨 module/cyclic 依賴、有沒有深入別人 internals」。
   `verify` 的 deps step 給機器判定；reviewer 給語意判定（責任是否真的 cohesive）。
4. **Acceptance = Independent Verifier Pass**（`dev-loops.md` Tier 2）：獨立、無情境重跑 `verify` 並
   逐條列 failing check，findings 驅動 fix → re-verify 迴圈至 clean。
5. **Capped。** review→fix 迴圈帶 cap（連 3 次同類失敗 → 停下、寫 `docs/guardrails.md`、重評架構）。

**Definition of Done（每個 slice 套用，鏡像 `AGENTS.md`）：**

- [ ] test-first：implementation 前已有 failing 測試。
- [ ] 根 `pnpm run verify` exit 0（**貼出指令結果**）——含**當下已 wired** 的每語言 gate 與 §4 deps
      check（gate-first：尚未 wired 的語言線屬 PENDING-SCAFFOLD，見 §10 Status 欄）。
- [ ] secret-scan clean；任何 source/log/output 無 secret-like 值。
- [ ] low coupling / high cohesion：無新跨 module/cyclic 依賴；只經 public surface 觸碰（deps check 綠）。
- [ ] adversarial code review = PASS（fresh-context reviewer 試圖弄壞、findings 已解）。
- [ ] Independent Verifier Pass = PASS。
- [ ] 行為/指令/policy 變更時 docs 已更新。
- [ ] **絕不在無指令證明下宣稱 done。**

---

## 10. Acceptance 矩陣（每條標準 → 可執行指令；only command output is truth）

> **如何讀本表（重要）：** `Status` 欄區分兩種狀態，**杜絕把「將會綠」誤讀為「現在綠」**：
> - **LIVE** = 指令今天就存在且可跑（已用 2026-06-19 的 `package.json` / `scripts/` 核實）。
> - **PENDING-SCAFFOLD** = 指令**尚未存在**（script 未在 `package.json`、或 `kernel/` / `sdk/` / `proto/`
>   未建）；它隨**指定 slice** 與其 RED 測試一併落地（不得後補），落地前該列**不可被當成已綠**。
>
> 規則（gate-first，§2）：標 PENDING-SCAFFOLD 的列，在其 gate 被 wired 進根 verify 前，屬「待生效標準」，
> 非「現在 binding 且已綠的關卡」。

| 標準（本文件章節）| 驗證指令（exit 0 = 綠）| 把關層 | Status / 落地 slice |
|---|---|---|---|
| TS strict typecheck（§3.1）| `pnpm run typecheck` | verify | **LIVE** |
| TS lint+format（§3.1）| `pnpm run lint`（biome）| verify | **LIVE** |
| TS build（§2.1）| `pnpm run build` | verify | **LIVE** |
| TS tests / TDD RED-first（§7.1）| `pnpm run test`（vitest）| verify | **LIVE** |
| secret 非洩漏（§7.2/7.4）| `pnpm run secret-scan` | verify + pre-commit | **LIVE** |
| **根單一真相（§0/§2）** | `pnpm run verify`（exit 0）| pre-commit block | **LIVE**（現 = typecheck&&lint&&build&&test&&secret-scan；`SLICE-P0-003` 加 `deps`） |
| **TS dependency-boundary（§4.1, HARD A）** | `pnpm run deps:check`（depcruise，`error` severity）| verify | **PENDING-SCAFFOLD** → `SLICE-P0-003`（加 pinned `dependency-cruiser` dev dep + wire 進 verify） |
| Go vet/lint/test（§2.1）| `go vet ./... && staticcheck ./... && go test -race ./...` | go:verify | **PENDING-SCAFFOLD** → P1 建 `kernel/` |
| **Go dependency-boundary（§4.2, HARD A）** | `go-arch-lint check`（或 `depguard`）| go:verify | **PENDING-SCAFFOLD** → P1 建 `kernel/` |
| Python lint/format/type/test（§2.1）| `ruff check . && ruff format --check . && pyright && pytest` | py:verify | **PENDING-SCAFFOLD** → P3 建 `sdk/python/` |
| **Python dependency-boundary（§4.3, HARD A）** | `lint-imports`（import-linter）| py:verify | **PENDING-SCAFFOLD** → P3 建 `sdk/python/` |
| proto↔Zod 一致（§1.1/§6）| `pnpm run contract:check`（Zod↔proto round-trip；vitest）＋ `pnpm run proto:check`（`buf lint && buf breaking`）| verify | **PENDING-SCAFFOLD** → 建 `proto/` 的 slice（架構 §5 / S3）；建立前 §6 契約一致性由 Zod round-trip 單獨守 |
| 跨租隔離（§7.5）| `pnpm run conformance:tenant`（= `vitest run conformance/tenant-isolation.conformance.test.ts`）| **release-blocking** | **PENDING-SCAFFOLD** → P3（tenant/gateway 落地時，隨其 RED-first conformance slice） |
| redaction value-scanning（§7.3, F3）| `pnpm run test`（canary 流經 free-form 欄位 → `[REDACTED]`）| verify | **PENDING-SCAFFOLD** → `SLICE-P0-004` |
| **per-slice adversarial review（§9, HARD B）** | （人判 gate，無單一指令）reviewer 親跑 `pnpm run verify` + `pnpm run deps:check` 並貼 exit 0 ＋ 結構化 PASS verdict | **merge gate** | **LIVE（流程）**；§9 的 deps 指令本身 PENDING-SCAFFOLD |

> 表中任一格沒有綠燈，對應的工作就**不是 done**。**adversarial-review 那一列雖無「單一指令」，唯一被接受
> 的證據仍是 command output：** reviewer 在 clean checkout 上**親自重跑** `pnpm run verify`（與 `pnpm run
> deps`）並貼出 exit 0，加上一份依 `docs/standards/adversarial-code-review.md` §4 模板填寫的**結構化 PASS
> verdict**，作為**可稽核的 durable artifact**（記錄於該 slice 的 `## Adversarial Review` 區段 / PR）。
> 沒有這份 artifact 即視為自述、不算數。

---

## 11. 與既有 scaffold / 方法論的關係（KEEP-AND-EXTEND，不重寫）

- 本文件**不要求重寫任何現有檔**。`src/iam/ids.ts`、`src/audit/event.ts`、`src/policy/evaluate.ts`、
  `scripts/scan_secrets.sh`、`.githooks/pre-commit`、`package.json` 的 `verify` **全部保留**，本文件只在
  其上加掛各語言 gate 與 dependency-boundary check。
- 與 `AGENTS.md`（authoritative contract）一致；衝突時 `AGENTS.md` wins。
- 與 `docs/dev-loops.md` 的四層 loop 體系對齊：本文件的 gate = Tier 1 收斂的 feedback gate；
  adversarial review / Independent Verifier Pass = Tier 2 驗收；prevention 永遠在 Tier 0 hook。
- **本文件未含任何 secret-like 值。**

---

*Engineering standards for the Agent OS build playbook. 每條 acceptance criterion 皆 command-verifiable；
HARD CONSTRAINT (A) low-coupling/high-cohesion 由各語言 dependency-boundary check（dependency-cruiser /
go-arch-lint / import-linter）wired 進 verify 強制；HARD CONSTRAINT (B) per-slice adversarial review 為
merge gate。Only command output is truth.*
