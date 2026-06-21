# R8 — Enterprise 多租脊椎（Enterprise multi-tenant spine）設計文件（DRAFT）

> 2026-06-21。作者：Backend Architect（agency-agents writer）。本文件是 ITEM **R8** 的權威設計，依
> [`docs/slices/phase-2-remaining/INDEX.md`](../slices/phase-2-remaining/INDEX.md) 第 26 列展開為一組**小 slice**
> （見本目錄同名 `P2R-R8-S*.md`）。方法論：[`looping-engineering.md`](../standards/looping-engineering.md)
> （doc-first、小 slice、RED 先行、Independent Verifier Pass = 獨立 Opus 4.8 reviewer、5 回合上限 → Staff+ 升級）。
> slice 範本：[`slice-spec.md`](../standards/slice-spec.md) §6 + §10。**AGENTS.md 在任何衝突上勝出。only command output is truth。**
>
> 定位：本文件對齊 [`three-surface-architecture.md`](./three-surface-architecture.md) 的「企業（一個人開公司）」面與
> P3 行（gateway-per-tenant + per-tenant Postgres + per-tenant-keyed kernel partition + release-blocking 跨租
> conformance + operator console + capability-possession maker-checker）。它**建在 P2 已 merge 的磚上**，不重寫。

---

## 1. What / Why（要做什麼、為什麼）

### 1.1 一句話

讓「在公司資料上跑一群**不受信任的腦**（Hermes 實例 + 第三方）」這件事，**跨租戶隔離成為結構性不可能**——
不是靠一個會被忘記加的 `WHERE tenant_id = ?` row filter，而是靠**進程/連線邊界 + 每租獨立 Postgres + 每租獨立簽章的
kernel partition**，並用一條 **release-blocking 跨租 conformance** 把「隔離」變成 `pnpm run verify` 可驗的不變量。

### 1.2 為什麼 row filter 不夠（威脅模型）

企業面的對手是「**被攻陷或行為異常的 agent**」與「**寫錯一行 query 的我們自己**」。row-level filter 的失效模式是
*沉默的*：少一個 `WHERE`、一個 join 漏掉 scope、一個 cache key 忘了帶 tenantId，跨租資料就外洩，且**沒有任何指令會變紅**。
這違反 AGENTS.md「deny-by-default + fail-closed」與「only command output is truth」。

因此 R8 的核心設計選擇是：**把租戶邊界上移到 process/namespace + 獨立持久化 + 獨立密鑰**，使跨租存取**需要跨越一個
實體邊界**（連到別的進程、開別的 DB、用別的私鑰），而非只是「忘了過濾」。剩餘的 row 級需求（同租戶內 project/actor）
仍由既有 PDP 處理。

### 1.3 既有缺口（grounded，verified-from-code）

- **NemoClaw 是 single-operator，明確不隔離租戶。** `src/hosting/port.ts:7-11`（本 repo）已記述此事實：NemoClaw 的
  reference pattern（nohup + gosu launch、recovery scripts、health-probe loop、`ConnectSupervisor` lifetime）是
  單一 operator。對應真 clone：`/tmp/nemoclaw/test/e2e-gateway-isolation.sh:5-8` 的隔離目標是「**sandboxed agent
  不能經 fake-HOME 攻破 gateway**」——是 **gateway↔sandbox 進程隔離**，**不是 tenant↔tenant 隔離**；
  `/tmp/nemoclaw/test/sandbox-container-owner.test.ts:21-39` 的 "co-tenant suffixed candidate" 只是**容器名前綴
  longest-owner 消歧**，不是 trust boundary。⇒ **跨租隔離 100% 自建**（亦見本 repo `P2-F` slice doc 標題）。
- **Go evidence kernel 目前是單一鏈、單一密鑰、單一 store。** `kernel/cmd/kernel/main.go:20-37`：單一 `--chain` /
  `--audit` 路徑、單一 `store.Open(path)`、單一 `NewIngestServer`。`kernel/internal/server/append.go:30-49` 的
  `head`（單一鏈頭）與 `next map[string]uint64`（per-**source** 期望序號）是**單一信任域**內的狀態。重要：
  `kernel/internal/store/store.go:27` 明寫 `SourceID` 是「ingest-completeness **NAMESPACE** identifier，**NOT** a
  trust boundary」——所以**不得**把 tenant 折成 SourceID 來「分租」，那只是換個名字的 row filter。

### 1.4 已建、可重用的磚（verified-from-code，**不重寫**）

| 能力 | 既有實作 | R8 如何重用 |
|---|---|---|
| **tenant-scoped PDP**（跨租 deny-by-default） | `src/policy/evaluate.ts:42-45,131-135,146-172`（`tenantApplies` + cross-tenant deny reason）、`src/policy/types.ts:37-63`（`AllowRule/DenyRule.tenantId?`） | R8 的 maker-checker 規則與 operator console 動作都過此 PDP；**不改 evaluate 演算法** |
| **tenant-scoped AgentHosting**（cross-tenant 拒絕） | `src/hosting/in-memory.ts:39-47,106-111`（registry 以 `tenantId` 為 owner，跨租 host/status/reconcile 一律 deny）、`src/hosting/port.ts:53-61` | gateway routing 解出的 tenant 即 hosting 的 owner；**沿用**，不重寫 |
| **branded `TenantId` + `AgentContext`** | `src/iam/ids.ts:12-13,39-52`（`TenantId` brand、`parseAgentContext` fail-closed） | 所有 R8 邊界都以 `AgentContext.tenantId` 為唯一租戶來源；malformed → fail-closed |
| **WORM 鏈 + Ed25519 checkpoint + 離線 verifier** | `kernel/internal/chain/chain.go:46-65`（`EntryHashFromCanonical`）、`chain/sign.go:10-23`（`SignCheckpoint/VerifyCheckpoint`）、`chain/types.go`（`SignedChain`）、`kernel/cmd/verifier/main.go` | per-tenant partition = **每租一條 `SignedChain` + 每租一把 Ed25519 key**；verifier **不變**（逐租驗） |
| **append-only + monotonic sequence + gap/replay fail-closed** | `kernel/internal/server/append.go:62-99` | partition 後**每租各自**保有此不變量；跨租不得共用 `head`/`next` |
| **TS↔Go byte-for-byte conformance harness** | `kernel/internal/conformance/{gen_test.go,go_verifies_ts_test.go}` | 跨租 conformance（R8-S6）**沿用**此 harness 形狀（fixture-driven、wrong-key 必拒） |
| **commit-before-effect guard** | `src/commitgate/guard.ts`（P2-C） | operator console 的特權動作走同一條 Append-await-Receipt 路徑 |

> 結論：R8 **不發明新的安全原語**。它把已被 `verify` 證明的 tenant-scope（PDP/hosting）與單一 WORM kernel，
> **沿三個實體維度切成 per-tenant**（連線、Postgres、kernel partition），再用 conformance 把「切乾淨了」變指令可驗。

---

## 2. Architecture（架構）

### 2.1 三層邊界（縱深防禦，deny-by-default + fail-closed）

```
  租戶請求（攜 AgentContext）
        │
        ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │ 邊界① gateway-per-tenant（進程/namespace 邊界，NOT row filter）      │  R8-S1
  │  TenantRouter: AgentContext.tenantId → 該租的 gateway descriptor    │
  │  - 解析 fail-closed（malformed/unknown tenant → deny，不 fall through）│
  │  - descriptor 綁定該租「專屬」DB handle + kernel partition id        │
  │  - 跨租 descriptor 取得＝結構性不可能（沒有別租的 handle 可拿）        │
  └───────────────┬───────────────────────────────┬────────────────────┘
                  ▼                                ▼
  ┌──────────────────────────────┐   ┌────────────────────────────────┐
  │ 邊界② per-tenant Postgres     │   │ 邊界③ per-tenant kernel partition│
  │  TenantStore: 一租一 DSN/handle│   │  per-tenant chain head + Ed25519 │  R8-S3
  │  - handle 由 router 提供，無「全 │   │  key（一租一條 SignedChain）      │
  │    租 connection」可列舉/跨用   │   │  - tenant 不是 SourceID row；是   │
  │  - 取錯租 = 取不到 handle = deny│   │    獨立鏈+獨立簽章 → 跨租不可偽造  │
  │   R8-S2                        │   │  - verifier 逐租驗、wrong-key 必拒 │
  └──────────────────────────────┘   └────────────────────────────────┘
                  │                                │
                  └───────────────┬────────────────┘
                                  ▼
        ┌─────────────────────────────────────────────┐
        │ release-blocking 跨租 conformance（R8-S6）     │
        │  property/fixture：任一邊界漏租 → 指令 exit≠0   │
        │  掛進 verify → 漏租無法 merge（structural gate）│
        └─────────────────────────────────────────────┘

  橫切：operator console（R8-S4，唯讀+特權動作走 PDP+commit-before-effect）
        capability-possession maker-checker（R8-S5，maker≠checker 由 capability 持有 enforce）
```

### 2.2 邊界① gateway-per-tenant（R8-S1）— **連線/namespace 邊界，非 row filter**

- **TenantRouter** 是純函式邊界：輸入 untrusted `ctx`，輸出**該租專屬的 `TenantBinding`**（含 DB handle ref +
  kernel partition id），或 `deny`。
- **deny-by-default**：`parseAgentContext` 失敗（`src/iam/ids.ts:50-52`）、或 tenant 不在已註冊 binding 表 →
  **deny，不得 fall through 到任何「預設租」**。對齊 PDP 的 fail-closed 風格（`evaluate.ts:116-120`）。
- **結構性隔離自證**：router 不暴露「列舉所有 binding」或「以任意字串取任意 binding」的 API；呼叫者**只能**拿到
  自己 `ctx.tenantId` 對應的 binding。跨租取得需要持有別租的 `ctx`——而 `ctx` 是上游驗證過的身分，不是請求可自選的。
- 對齊 three-surface P3「gateway-per-tenant（進程/namespace 邊界）」。**P2 階段以同進程內的 binding-registry 邊界
  落地**（in-memory，credential-blind）；真實「每租一進程/netns」是部署形態，由本 binding 抽象在後續 hosting/deploy
  slice 物化（out-of-scope，見 §5）。關鍵不變量（跨租取不到 binding）在 P2 即可指令驗。

### 2.3 邊界② per-tenant Postgres（R8-S2）— **一租一 store handle**

- **TenantStore** 是 vendor-neutral persistence port：`forTenant(binding) → TenantScopedRepo`。一租一個獨立
  handle（對映一個獨立 DB / schema / DSN，由 deploy 決定），**沒有跨租 connection pool 可被誤用**。
- 對齊既有 hosting registry 形狀（`src/hosting/in-memory.ts:25-27` 的 `Map`，owner=tenantId）：P2 以 in-memory
  per-tenant repo 落地第二實作 + contract test，證明「拿 A 租 repo 永遠看不到 B 租資料」。真實 Postgres adapter 是
  後續 vendor adapter slice（out-of-scope）。
- **fail-closed**：未註冊 tenant → 取不到 repo → deny（不建立空 repo）。

### 2.4 邊界③ per-tenant kernel partition（R8-S3）— **per-tenant Merkle 鏈 + per-tenant Ed25519 key**

- 這是 R8 最硬的一塊：**每租一條 `SignedChain`（獨立 `head`）+ 每租一把 Ed25519 私鑰**。對齊 three-surface P3
  「per-tenant-keyed kernel partition」。
- **為何不是 SourceID 分租**：`kernel/internal/store/store.go:27` 明寫 `SourceID` 是 completeness namespace、
  **不是 trust boundary**；`append.go:30,72` 的 `head`/`next` 是**單一信任域**狀態。若把 tenant 當 SourceID，
  跨租仍共用同一鏈頭與**同一把簽章 key** → 一個 operator/bug 能用同一把 key 為任一「租」簽章＝沒有密碼學隔離。
- **設計**：`PartitionedIngest` 持有 `map[partitionId]{head, next, store, signer}`，partitionId = tenant。
  - 每租**獨立 `head`**（鏈不互纏）、**獨立 `next`**（per-source sequence 仍在租內，沿用 `append.go:72-95`）。
  - 每租**獨立 Ed25519 keypair**：簽 checkpoint 用該租 key（`chain/sign.go:10`）；verifier 用該租 public key 驗，
    **用別租 key 驗必拒**（沿用 `conformance/go_verifies_ts_test.go:148-150` 的 wrong-key-must-reject 既有不變量）。
  - **commit-before-effect 不變**：每租各自 durable commit 後才回 Receipt（`append.go:87-99`）。
- **P2 落地範圍**：partition 的**路由 + per-tenant head/key 隔離不變量**（property test：跨租 entry 不進對方鏈、
  別租 key 驗不過），落地為一個 **stand-alone `internal/partition` library**（直接函式呼叫測試）。**把它接進 live gRPC
  `AppendService` 需先在 proto `AppendRequest` 新增 `partition_id` 欄位**（現行 `proto/ingest.proto:15-19` 無此欄、
  `source_id` 明確不是 trust boundary）——該 proto 欄位是**先於消費者的獨立 contract slice**（slice-spec §9），
  server wiring 留給其後續 slice，不在 R8-S3 範圍。真正的 multi-process kernel 部署、key 的外部化（客戶 KMS/HSM）是
  **P4**（three-surface P4 行），out-of-scope。

### 2.5 橫切 — operator console（R8-S4）

- 「一個畫面開公司」的**最小資料契約**（非 UI 像素）：列 fleet（per-tenant agent 清單）、live timeline（從該租
  WORM partition 重建）、per-agent 成本/預算（接 `src/cost`，P2-G）、policy 決策（接 PDP）、evidence 匯出（該租
  `SignedChain`）。
- **唯讀預設、特權動作走治理**：任何「改動公司」的 console 動作（暫停 agent、調預算、改 policy）都**不是直接寫**，
  而是走 PDP（`evaluatePolicy`）→ commit-before-effect（`src/commitgate`）→ 該租 kernel partition Append。
- **租戶過濾不是 console 的責任**：console 只持有 router 給的該租 binding（§2.2），所以「看到別租 fleet」結構上不可能。
  R8-S4 只交付**唯讀 fleet/timeline 投影的資料契約 + 租戶綁定**這一最小可驗片，動作部分留給 S5/後續。

### 2.6 橫切 — capability-possession maker-checker（R8-S5）

- **maker≠checker 由 capability 持有性 enforce，不是 `if maker == checker` 字串比對**（對齊 INDEX「capability-possession
  maker-checker」與 three-surface P4「capability-possession maker-checker」）。
- **設計**：一個敏感動作需要一張 `CheckerCapability`——一個**綁定到 (tenantId, actionIdentity, makerActorId)** 的
  能力憑證。enforce 規則：
  1. checker 必須**持有**該 capability（possession，不是宣稱）；
  2. capability 綁定的 `makerActorId` ≠ checker 的 actorId（同一人不能既 maker 又 checker）；
  3. capability 綁定的 `actionIdentity` 必須與**將要執行的動作**重新導出值相等，否則 **fail-closed**——
     這直接借鑑 AGT 的 TOCTOU 防禦：approval 綁 `enforced_identity`，SDK **rederive** 後不符即
     `runtime_error:approval_action_mismatch`（`/tmp/agent-governance-toolkit/policy-engine/spec/SPECIFICATION.md:388,432`）。
- **借 AGT 的點 vs 不借的點（誠實）**：借「approval 綁定 action identity + 執行前 rederive + 不符 fail-closed」這個
  *語意*（verified-from-spec）。**不借** AGT 的 approval 機制本體——AGT 的 approval 是 host callback resolver
  （`SPECIFICATION.md:388`），且 AGT audit 過不了 attester≠actor／離線 verifier（見 three-surface §「外部工具決策」對 AGT
  的評估）。我們把它升級為 **capability possession**（憑證不可由 maker 自發給自己），且 maker-checker 事件一律進
  **我們的 per-tenant WORM partition**。
- **跨租**：capability 綁 tenantId；A 租的 checker capability 對 B 租動作不適用（落到 deny-by-default，沿用 PDP
  cross-tenant 邏輯 `evaluate.ts:168-171`）。

### 2.7 橫切 — release-blocking 跨租 conformance（R8-S6）

- 一個**fixture/property 驅動**的 conformance suite，斷言三邊界**任一漏租即 exit≠0**，並**掛進 `pnpm run verify`**
  使「漏租無法 merge」成為 structural gate（對齊 INDEX「**release-blocking** 跨租 conformance」、three-surface P3
  「release-blocking 跨租 conformance」）。
- 形狀沿用既有 conformance harness（`kernel/internal/conformance/*`：fixture 對拍、wrong-key 必拒）。
- **release-blocking 的意義**：這條 suite 紅 ⇒ `verify` 紅 ⇒ pre-commit guard 擋下 ⇒ 不得 merge。它把 §2.1 三邊界的
  「跨租結構不可能」從設計宣稱升級為**每次提交都重證一遍**的指令真相。
- **已接線（R8-S6 落地）**：`package.json` 新增 `verify:cross-tenant`（`scripts/verify-cross-tenant.sh`：TS
  `src/tenant/conformance/cross-tenant.conformance.test.ts` 重證 boundary①②③ 的 S1/S2/S5 公共面 + Go
  `kernel/internal/partition -run Conformance` 重證 S3 per-tenant head/key），並插入 `verify` 鏈成為 release-blocking
  子關卡。gate 自證：對 routing/repo/maker-checker/partition 各植入一條漏租 mutation 皆 exit≠0，移除後 exit 0
  （證據見對應 slice §5）。

### 2.8 跨 plane / 低耦合（HARD CONSTRAINT A）

- TS 側新增 module 僅經各自 barrel（`src/index.ts` pattern）對外；**禁止 deep-import** 別 module 內部（dependency-cruiser
  `not-to-internal` 守）。
- 核心**不得出現 vendor 名**（no-vendor-in-core，P2-B 已 enforcing）：NemoClaw/Postgres 只在各自 adapter。
- Go kernel 的 partition 改動只在 `kernel/internal/*`（`internal/` 封裝，depguard 守）；跨 plane 僅經既有 proto/
  `SignedChain` 契約。
- 依賴方向 inward：`console/router → port（hosting/policy/cost/persistence）→ iam/ids domain`，無 cycle。

---

## 3. Trade-offs（取捨，誠實）

1. **進程/namespace 邊界 vs 同進程 binding（P2 interim）。** 真正的「每租一進程/netns」最強，但屬部署形態。R8 在 P2
   以**同進程 binding-registry 邊界**落地**不變量**（跨租取不到 binding/repo/partition），把 multi-process 物化留給
   後續 deploy slice。誠實封頂：P2 證的是「邏輯邊界乾淨 + 密碼學分區乾淨」，不是「進程級沙箱逃逸不可能」。
2. **per-tenant key 的 root 信任。** P2 的 per-tenant Ed25519 key 在 kernel 進程內生成/持有（沿用 P1 形態）。
   **attester 仍可能 == operator**——這在 three-surface 已誠實標註，root 外部化（客戶 KMS/HSM、WASM verifier）是 **P4**。
   R8 P2 對外封頂在「per-tenant tamper-evident + 跨租密碼學不可偽造（不同 key）」，不宣稱「不信 operator」。
3. **per-tenant store 數量爆炸。** 一租一 DB handle 在 10k+ 租時有 connection/檔案數成本。P2 用 in-memory per-tenant
   repo 不觸此問題；真實 Postgres adapter 需 connection pooling/分片策略（後續 vendor adapter slice 處理），本文件不
   過早最佳化（YAGNI）。
4. **maker-checker 用 capability possession 而非 RBAC 角色檢查。** 較重（要簽發/持有/驗證 capability），但避免
   「`if role==approver`」這種可被繞過的 if-check，且天然支援跨租綁定與 TOCTOU 防禦。取捨：P2 只做**最小 capability
   possession + action-identity rederive**，完整 capability algebra（attenuation、sub-delegation）是 P5（out-of-scope）。
5. **release-blocking conformance 會拖慢 CI。** 但這是刻意的：跨租隔離是企業面的**唯一賣點**，寧可 CI 慢也不要沉默漏租。

---

## 4. Capability gates（誠實能力閘，verified vs inferred）

| 宣稱 | 狀態 | 證據 / 封頂 |
|---|---|---|
| NemoClaw 不隔離租戶，跨租 100% 自建 | **verified-from-code** | `/tmp/nemoclaw/test/e2e-gateway-isolation.sh:5-8`（gateway↔sandbox，非 tenant↔tenant）、`sandbox-container-owner.test.ts:21-39`（名前綴消歧）、本 repo `src/hosting/port.ts:7-11` |
| kernel 現為單鏈/單 key/單 store | **verified-from-code** | `kernel/cmd/kernel/main.go:20-37`、`server/append.go:30-49`、`store/store.go:27` |
| SourceID 不是 trust boundary（不可用來分租） | **verified-from-code** | `kernel/internal/store/store.go:27` 註解原文 |
| PDP/hosting 已 tenant-scope 且跨租 deny-by-default | **verified-from-code** | `src/policy/evaluate.ts:42-45,131-135,168-171`、`src/hosting/in-memory.ts:39-47,106-111` |
| Ed25519 checkpoint + wrong-key 必拒可逐租重用 | **verified-from-code** | `kernel/internal/chain/sign.go:10-23`、`conformance/go_verifies_ts_test.go:148-150` |
| AGT approval 綁 action identity + rederive + fail-closed（maker-checker 借鑑來源） | **verified-from-spec** | `/tmp/agent-governance-toolkit/policy-engine/spec/SPECIFICATION.md:388,432` |
| 「每租一進程/netns」P2 即達成 | **inferred / 明確 out-of-scope** | P2 落地邏輯 binding 邊界；真實進程隔離 = 部署形態，後續 deploy slice |
| per-tenant key 達到「不信 operator」 | **inferred / 封頂 P4** | P2 key 在 kernel 進程內；root 外部化 = P4（three-surface P4 行） |
| 真實 Postgres per-tenant 已落地 | **inferred / out-of-scope** | P2 用 in-memory per-tenant repo（contract test 證隔離不變量）；真 PG adapter 後續 |

---

## 5. 範圍切分（哪些進 R8 P2，哪些不進）

**進 R8（P2，本文件展開的 6 個小 slice）**：tenant routing 邊界、per-tenant persistence port（in-memory 第二實作）、
per-tenant kernel partition 隔離不變量、operator console 唯讀資料契約、capability-possession maker-checker（最小）、
release-blocking 跨租 conformance gate。

**不進 R8（明確 out-of-scope，留給後續/其他 ITEM）**：
- 真實「每租一進程/netns/microVM」部署物化 → 後續 deploy / hosting vendor adapter slice。
- 真實 Postgres adapter（connection pool/分片）→ 後續 vendor adapter slice（R11 風格）。
- per-tenant key 的外部化 root（客戶 KMS/HSM）+ WASM verifier 嵌入 → **P4**。
- 完整 capability algebra（child⊆parent attenuation、sub-delegation firewall）→ **P5**。
- operator console 的像素/前端（React UI）→ 體驗層 slice（R7 風格，本文件只定資料契約）。

---

## 6. Slice 分解與 DAG（無 cycle）

| Slice | 檔案 | Title | 主模組 | Depends-on |
|---|---|---|---|---|
| **R8-S1** | `P2R-R8-S1-gateway-per-tenant-routing.md` | TenantRouter — 跨租取不到 binding（連線/namespace 邊界，非 row filter） | `src/tenant`（new） | P2-F |
| **R8-S2** | `P2R-R8-S2-per-tenant-postgres-store.md` | per-tenant persistence port + in-memory 第二實作（跨租取不到 repo） | `src/tenant`（persistence port） | R8-S1 |
| **R8-S3** | `P2R-R8-S3-per-tenant-kernel-partition.md` | per-tenant kernel partition（per-tenant head + Ed25519 key；跨租不可偽造） | `kernel/internal/partition`（new Go） | P1 kernel |
| **R8-S4** | `P2R-R8-S4-operator-console-contract.md` | operator console 唯讀 fleet/timeline 投影資料契約 + 租戶綁定 | `src/tenant`（console projection） | R8-S1, R8-S2 |
| **R8-S5** | `P2R-R8-S5-capability-possession-maker-checker.md` | capability-possession maker-checker（maker≠checker + action-identity rederive fail-closed） | `src/tenant`（maker-checker） | R8-S1, P2-E |
| **R8-S6** | `P2R-R8-S6-cross-tenant-conformance-gate.md` | release-blocking 跨租 conformance（任一邊界漏租 → verify exit≠0） | `src/tenant`/`kernel` conformance | R8-S1, R8-S2, R8-S3, R8-S5 |

### Slice DAG（鄰接表，無 cycle）
```
R8-S1 -> { P2-F }                                   # routing 邊界，建在 tenant-scoped PDP 上
R8-S2 -> { R8-S1 }                                  # persistence port 用 router 給的 binding
R8-S3 -> { P1-kernel }                              # kernel partition 獨立於 TS 邊界，直接建在 P1 kernel
R8-S4 -> { R8-S1, R8-S2 }                           # console 投影用 binding + repo
R8-S5 -> { R8-S1, P2-E }                            # maker-checker 用 binding + PDP sole-deny
R8-S6 -> { R8-S1, R8-S2, R8-S3, R8-S5 }             # conformance 重證全部邊界，release-blocking
```
> 無 cycle 證明：rank=0（P2-F,P1-kernel,P2-E 皆已 merge 前置）；R8-S1=1、R8-S3=1；R8-S2=2、R8-S5=2；R8-S4=3；
> R8-S6=4（依賴 rank≤3）。每條邊嚴格遞減 ⇒ DAG。每個 slice net LOC < ~300、files < ~6（見各 slice §Size）。
> module 數：S1–S5 各 1 主模組（soft target ≤2）；**S6 是 release-blocking gate，本質上需跨 TS + Go 兩 plane 重證
> （TS conformance test 1 + Go partition conformance test 1 + `package.json` script），= 2 code module + 1 config，
> 仍在 slice-spec §3 hard cap（3 module）內**。S6 為純測試 + 1 行 script（無新 runtime 公共面），故跨 plane 雖計多
> module，認知負荷仍小，不拆分；其唯一連接點是 `verify` script 編排（非跨 plane code import）。

---

## 7. 參考（cited，real file:line）

**本 repo（已建磚）**：`src/policy/evaluate.ts:42-45,116-120,131-135,146-172`、`src/policy/types.ts:37-63`、
`src/hosting/in-memory.ts:25-27,39-47,106-111`、`src/hosting/port.ts:7-11,53-61`、`src/iam/ids.ts:12-13,39-52`、
`kernel/cmd/kernel/main.go:20-37`、`kernel/internal/server/append.go:30-49,62-99`、`kernel/internal/store/store.go:27`、
`kernel/internal/chain/chain.go:46-65`、`kernel/internal/chain/sign.go:10-23`、`kernel/internal/chain/types.go`、
`kernel/internal/conformance/go_verifies_ts_test.go:148-150`、`src/index.ts`。

**真 clones（grounding）**：`/tmp/nemoclaw/test/e2e-gateway-isolation.sh:5-8`、
`/tmp/nemoclaw/test/sandbox-container-owner.test.ts:21-39`、
`/tmp/agent-governance-toolkit/policy-engine/spec/SPECIFICATION.md:388,432`。
